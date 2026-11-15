/**
 * dsh-mingbian —— 明辨。
 *
 * 蒸馏即用：把一个对象蒸馏成明辨目录格式的大师卡，落盘后立刻能上桌；
 * 卡本身就是后端 masters.json 的一个元素，导出即用。
 *
 * 挂载三件事：一个运行时 skill、两个模型工具。
 * 不注册浏览器半边，不做 UI——这个插件的价值在会话里。
 *
 * @module dsh-mingbian
 */

import { validateMaster, validateSkillCard, slugify } from './schema.js';
import { loadLibrary, loadCategories, saveMaster, findMaster, storeDir } from './store.js';
import { distillSystemPrompt, distillUserPrompt } from './prompts.js';
import { generate, parseJsonLoose, resolveTarget } from './llm.js';
import { pickMasters, runRoundtable } from './roundtable.js';
import { mountRoutes } from './routes.js';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件名，与配置文件里的行 id 同名。 */
export const name = 'dsh-mingbian';

/**
 * 依赖的宿主服务。
 *
 * webServer 必须写进 inject 才能在 apply 里读 ctx.webServer——Cordis 对未声明的
 * 服务属性直接抛 "cannot get property ... without inject"，try/catch 兜不住。
 * 代价是：没有 HTTP 栈的 profile（TUI/headless）压根不会加载本插件。
 * 这是有意的取舍——这个插件的两个工具本来就是给 Web 会话用的。
 */
export const inject = ['tools', 'llm', 'skills', 'webServer'];

const HERE = dirname(fileURLToPath(import.meta.url));

/** 只输出 JSON 的最终文本渲染。 */
const text = (value) => [{ type: 'text', text: value }];

/** 圆桌结果渲染成一段可读的对话记录。 */
function renderRoundtable(value) {
  const lines = [`【议题】${value.topic}`, ''];
  for (const take of value.takes) {
    lines.push(`【${take.name} · ${take.thinkingModel}】`);
    lines.push(take.take || `（生成失败：${take.error ?? '未知原因'}）`);
    lines.push('');
  }
  if (value.host) {
    lines.push('【主持人】');
    lines.push(value.host);
  }
  return text(lines.join('\n').trim());
}

/** 把失败重试的提示拼进下一轮 user prompt。 */
function retryNote(problems) {
  return `\n\n上一版没通过校验，请只修正这些问题后重新输出完整 JSON：\n- ${problems.join('\n- ')}`;
}

/**
 * 插件主体。
 * @param ctx - 宿主上下文
 * @param config - 插件配置 { provider, model }
 */
export function apply(ctx, config = {}) {
  // ── 面板数据路由：面板不读磁盘，只走这两条同源 HTTP 接口 ────────────────────
  ctx.effect(() => {
    const disposers = mountRoutes(ctx, ctx.webServer, config);
    return () => disposers.forEach((dispose) => dispose());
  }, 'dsh-mingbian: panel routes');

  // ── 运行时 skill：把蒸馏方法论交给模型当说明书 ──────────────────────────────
  Promise.resolve()
    .then(async () =>
      ctx.skills.register({
        name: 'mingbian',
        description:
          '把一个人物/一本书/一套思想蒸馏成符合明辨目录格式的大师卡，并直接开一场三人圆桌。',
        whenToUse:
          '用户说「蒸馏某人」「把这本书做成大师」「让 N 位大师就这个问题吵一架」「加进大师库」时。',
        content: await readSkillContent(),
      }),
    )
    .catch((error) => ctx.logger?.warn?.(`mingbian skill 注册失败: ${String(error)}`));

  // ── 工具 1：蒸馏 ────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'distill_master',
    description:
      '把一个人物、一本书或一套思想蒸馏成大师卡（思维模型/口吻/启发式/反模式/张力/边界），' +
      '校验通过后写入本地大师库，可直接用于 master_roundtable，也可导出为明辨 catalog 的正式大师。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['source'],
      properties: {
        source: {
          type: 'string',
          description: '蒸馏对象：人物名、书名或思想体系，如「塔勒布」「《孙子兵法》」',
        },
        name: { type: 'string', description: '卡片显示名，默认跟随 source' },
        slug: { type: 'string', description: '英文标识（kebab-case），默认用 name 推导' },
        focus: { type: 'string', description: '侧重哪个领域蒸馏，如「谈判」「工程成本」' },
        save: {
          type: 'boolean',
          description: '是否落盘到本地大师库，默认 true；false 时只返回卡片',
        },
        thinking: {
          type: 'string',
          enum: ['off', 'low', 'high', 'max'],
          description: '思考档位，默认 high；蒸馏是结构化产出，想快可传 off',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          slug: { type: 'string' },
          savedTo: { type: 'string' },
          master: {},
          problems: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) =>
        text(
          value.ok
            ? `已蒸馏「${value.master?.name}」· ${value.master?.thinkingModel}\n` +
                `已写入 ${value.savedTo}\n\n` +
                `${JSON.stringify(value.master, null, 2)}`
            : `蒸馏未通过校验：\n- ${(value.problems ?? []).join('\n- ')}`,
        ),
    },
    async execute(args, exec) {
      const categories = await loadCategories();
      const categorySet = new Set(categories.map((c) => c.slug));
      const target = await resolveTarget(ctx, config, args.thinking ? { thinking: args.thinking } : undefined);
      const displayName = args.name?.trim() || args.source.trim();
      const wantedSlug = args.slug?.trim() || slugify(displayName) || slugify(args.source);

      const baseSystem = distillSystemPrompt(categories);
      const baseUser = distillUserPrompt({
        source: args.source,
        name: displayName,
        focus: args.focus,
      });

      let candidate;
      let problems = [];
      let slug = wantedSlug;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const raw = await generate(ctx, {
          target,
          system: baseSystem,
          user: attempt === 0 ? baseUser : baseUser + retryNote(problems),
          maxTokens: 1800,
          temperature: 0.6,
          signal: exec.signal,
        });
        try {
          candidate = parseJsonLoose(raw);
        } catch (error) {
          problems = [`输出不是合法 JSON：${error.message}`];
          continue;
        }
        candidate.slug = slug || candidate.slug;
        if (!candidate.slug) candidate.slug = slugify(candidate.name ?? '') || 'master';
        slug = candidate.slug;
        candidate.name = candidate.name || displayName;
        candidate.avatarUrl = candidate.avatarUrl ?? '';
        problems = validateMaster(candidate, categorySet);
        if (problems.length === 0) {
          const skillProblems = validateSkillCard({
            domains: candidate.consultationDomains,
            intakeQuestions: candidate.intakeQuestions,
            method: candidate.summary,
            guardrails: candidate.guardrails,
          });
          if (skillProblems.length > 0) {
            problems = skillProblems;
            continue;
          }
          break;
        }
      }

      if (problems.length > 0) {
        return { ok: false, slug, savedTo: '', master: candidate ?? null, problems };
      }

      const master = {
        ...candidate,
        slug,
        categories: [...new Set(candidate.categories)],
      };
      let savedTo = '';
      if (args.save !== false) savedTo = await saveMaster(master);
      return { ok: true, slug, savedTo, master, problems: [] };
    },
  });

  // ── 工具 2：圆桌 ────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'master_roundtable',
    description:
      '让 1-6 位大师就一个议题各说一段（80-120 字），再由主持人收敛共识、分歧与结论。' +
      '不指定大师时按议题自动挑选立场最有张力的人，包含刚蒸馏出来的大师。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['topic'],
      properties: {
        topic: { type: 'string', description: '本次议题，越具体越好' },
        masters: {
          type: 'array',
          items: { type: 'string' },
          description: '指定大师（slug 或中文名），最多 6 位；留空则自动挑 3 位',
        },
        withHost: {
          type: 'boolean',
          description: '是否要主持人收敛，默认 true；只要各人短判断时设 false',
        },
        thinking: {
          type: 'string',
          enum: ['off', 'low', 'high', 'max'],
          description: '思考档位，默认 high（深思开启）；想更快可传 off',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          topic: { type: 'string' },
          takes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                order: { type: 'number' },
                slug: { type: 'string' },
                name: { type: 'string' },
                thinkingModel: { type: 'string' },
                take: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
          host: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
      render: (_args, value) => renderRoundtable(value),
    },
    async execute(args, exec) {
      const { masters: library } = await loadLibrary();
      const target = await resolveTarget(ctx, config, args.thinking ? { thinking: args.thinking } : undefined);
      const keys = (args.masters ?? []).map((k) => k.trim()).filter(Boolean).slice(0, 6);

      let chosen;
      if (keys.length > 0) {
        const missing = [];
        chosen = keys
          .map((key) => {
            const hit = findMaster(library, key);
            if (!hit) missing.push(key);
            return hit;
          })
          .filter(Boolean);
        if (chosen.length === 0) {
          throw new Error(
            `没找到大师：${missing.join('、')}。可先用 distill_master 蒸馏，或从内置目录里换一个。`,
          );
        }
      } else {
        chosen = pickMasters(library, args.topic, 3);
      }

      const result = await runRoundtable(ctx, {
        topic: args.topic,
        masters: chosen,
        target,
        withHost: args.withHost !== false,
        signal: exec.signal,
      });
      return { topic: args.topic, ...result };
    },
  });
}

/** 读取随包的 skill 说明。 */
function readSkillContent() {
  return readFile(join(HERE, '..', 'skill', 'mingbian.md'), 'utf8');
}

/** 供测试与脚本直接复用。 */
export const internals = { storeDir, pickMasters, loadLibrary };
