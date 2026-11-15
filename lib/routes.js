/**
 * 面板用的 HTTP 路由。
 *
 * 面板不直接读磁盘、也不直接调模型：浏览器只认同源 HTTP，宿主侧提供三条接口。
 *   GET  /mingbian/library          合并后的库（内置 + 自铸）
 *   GET  /mingbian/export/:slug     可直接塞进后端 catalog 的 JSON
 *   POST /mingbian/roundtable       在宿主侧跑一场圆桌，把结果还给面板
 *
 * 最后一条是关键：面板自己不能调模型（模型调用是宿主服务）。没有它，面板只能把
 * 「去会话里开桌」这句话塞进输入框，交互就断了。有了它，选人→开桌→看结果都在面板内完成。
 *
 * @module dsh-mingbian/routes
 */

import { loadLibrary, loadCategories, loadDeleted, deleteMaster, restoreMaster } from './store.js';
import { validateMaster } from './schema.js';
import { findMaster } from './store.js';
import { pickMasters, runRoundtable, runRoundtableStream } from './roundtable.js';
import { resolveTarget } from './llm.js';
import { appendTurn, createSession, getSession, historyPrompt } from './sessions.js';

/** 路由前缀，客户端用同一个常量拼 URL。 */
export const BASE = '/mingbian';

/** 导出时若原卡没写 sortOrder，给一个不撞车的默认号。 */
const DEFAULT_SORT_BASE = 100;

/** 一场圆桌最多几人。下限是 1：一个人也值得问。 */
export const MAX_SEATS = 6;

/** 一次圆桌请求体上限：只有议题和几个 slug，1 MB 已经很宽松。 */
const MAX_BODY_BYTES = 1024 * 1024;

function json(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * 面板要的库视图。刻意裁掉不需要的字段，避免把整份语料推给浏览器。
 * @returns 库视图
 */
async function libraryView() {
  const [{ masters, distilledSlugs, deletedSlugs }, categories] = await Promise.all([
    loadLibrary(),
    loadCategories(),
  ]);
  // 每个分类眼下还剩几位，前端筛选条直接用它显示数量。
  const perCategory = {};
  for (const master of masters) {
    for (const slug of master.categories ?? []) perCategory[slug] = (perCategory[slug] ?? 0) + 1;
  }
  return {
    categories: categories.map((c) => ({ ...c, count: perCategory[c.slug] ?? 0 })),
    counts: {
      total: masters.length,
      distilled: distilledSlugs.length,
      bundled: masters.length - distilledSlugs.length,
    },
    masters: masters.map((master) => ({
      slug: master.slug,
      name: master.name,
      avatarType: master.avatarType,
      avatarUrl: master.avatarUrl ?? '',
      categories: master.categories ?? [],
      thinkingModel: master.thinkingModel,
      summary: master.summary,
      voice: master.voice,
      models: master.models ?? [],
      heuristics: master.heuristics ?? [],
      antiPatterns: master.antiPatterns ?? [],
      tension: master.tension,
      boundary: master.boundary,
      tags: master.tags ?? [],
      consultationDomains: master.consultationDomains ?? [],
      origin: master.origin,
    })),
    // 已删列表：前端要靠它给出「恢复」入口，否则删错了没路可退。
    deleted: deletedSlugs ?? [],
  };
}

/**
 * 只读部分的响应。抽成纯函数便于直接单测，不依赖真实 HTTP 栈。
 * @param pathname - 请求路径（已去掉 query）
 * @returns Response
 */
export async function respond(pathname) {
  try {
    if (pathname === `${BASE}/library`) return json(200, await libraryView());

    if (pathname.startsWith(`${BASE}/export/`)) {
      const slug = decodeURIComponent(pathname.slice(`${BASE}/export/`.length));
      if (!slug) return json(400, { error: '缺少 slug' });
      const { masters } = await loadLibrary();
      const master = masters.find((m) => m.slug === slug);
      if (!master) return json(404, { error: `没有 ${slug}` });
      const categories = new Set((await loadCategories()).map((c) => c.slug));
      const problems = validateMaster(master, categories);
      const clean = { ...master };
      delete clean.origin;
      if (clean.sortOrder === undefined) clean.sortOrder = DEFAULT_SORT_BASE;
      return json(problems.length === 0 ? 200 : 422, {
        ok: problems.length === 0,
        problems,
        master: clean,
      });
    }

    return json(404, { error: 'not found' });
  } catch (error) {
    return json(500, { error: String(error?.message ?? error) });
  }
}

/**
 * 读请求体并按 JSON 解析。
 *
 * 刻意用 data/end 事件而不是 `for await (const c of req)`：后者在 webServer 的
 * handler 里会挂住（请求永远不会被判定为结束），表现为客户端一直等、服务端不报错。
 * 本机已验证的插件也都走事件式读取。没有结束事件的请求必须有超时兜底。
 * @param req - IncomingMessage
 * @param options - { timeoutMs }
 * @returns 解析后的对象；空体返回 {}
 */
function readJsonBody(req, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('读取请求体超时')), timeoutMs);

    if (req.readableEnded) {
      finish(resolve, {});
      return;
    }

    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      // 按累计字节判上限，不是收完再拒——收完再拒等于没闸。
      if (size > MAX_BODY_BYTES) {
        finish(reject, new Error('请求体过大'));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        finish(resolve, {});
        return;
      }
      try {
        finish(resolve, JSON.parse(text));
      } catch {
        finish(reject, new Error('请求体不是合法 JSON'));
      }
    });

    req.on('error', (error) => finish(reject, error));
    req.on('aborted', () => finish(reject, new Error('客户端已断开')));
  });
}

/**
 * 在宿主侧跑一场圆桌。
 * @param ctx - 宿主上下文（需要 ctx.llm）
 * @param config - 插件配置
 * @param body - { topic, masters?, thinking?, withHost? }
 * @returns 圆桌结果
 */
export async function runRoundtableRequest(ctx, config, body) {
  const topic = String(body?.topic ?? '').trim();
  if (!topic) throw new Error('缺少议题');

  const { masters: library } = await loadLibrary();
  const keys = (body?.masters ?? []).map((k) => String(k).trim()).filter(Boolean).slice(0, MAX_SEATS);

  const chosen =
    keys.length > 0
      ? keys.map((key) => findMaster(library, key)).filter(Boolean)
      : pickMasters(library, topic, 3);

  if (chosen.length === 0) throw new Error('没找到可用的大师');

  const thinking = body?.thinking;
  const target = await resolveTarget(ctx, config, thinking ? { thinking } : undefined);

  const result = await runRoundtable(ctx, {
    topic,
    masters: chosen,
    target,
    withHost: body?.withHost !== false,
  });

  return { topic, ...result };
}

/**
 * 挂上路由。
 * @param ctx - 宿主上下文
 * @param webServer - ctx.webServer
 * @param config - 插件配置
 * @returns disposer 列表
 */
export function mountRoutes(ctx, webServer, config = {}) {
  const resourceRoute = (path, kind) => ({
    path,
    kind,
    resource: (request) => respond(new URL(request.url).pathname),
  });

  return [
    webServer.register(resourceRoute(`${BASE}/library`, 'exact')),
    // prefix 的 path 不能带尾斜杠；匹配 /mingbian/export/<slug> 靠前缀语义。
    webServer.register(resourceRoute(`${BASE}/export`, 'prefix')),
    webServer.register({
      path: `${BASE}/master`,
      kind: 'prefix',
      async handler(req, res) {
        const send = (status, payload) => {
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          });
          res.end(JSON.stringify(payload));
        };
        try {
          const raw = String(req.url ?? '').split('?')[0];
          const rest = decodeURIComponent(raw.slice(`${BASE}/master/`.length));
          const [slug, action] = rest.split('/');
          if (!slug) {
            send(400, { error: '缺少 slug' });
            return;
          }
          if (req.method === 'DELETE') {
            // 内置卡也允许删：靠墓碑挡住，不改随包文件。
            await deleteMaster(slug);
            send(200, { ok: true, slug, deleted: true });
            return;
          }
          if (req.method === 'POST' && action === 'restore') {
            await restoreMaster(slug);
            send(200, { ok: true, slug, deleted: false });
            return;
          }
          res.setHeader('allow', 'DELETE, POST');
          send(405, { error: 'method not allowed' });
        } catch (error) {
          send(400, { error: String(error?.message ?? error) });
        }
      },
    }),
    webServer.register({
      path: `${BASE}/deleted`,
      kind: 'exact',
      resource: async () => {
        const table = await loadDeleted();
        const slugs = Object.keys(table);
        return json(200, { slugs, count: slugs.length });
      },
    }),
    webServer.register({
      path: `${BASE}/stream`,
      kind: 'exact',
      async handler(req, res) {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST');
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'method not allowed' }));
          return;
        }

        // SSE：保持连接打开，逐段把增量写下去。x-accel-buffering 让中间的代理别攒包。
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        // 必须立刻 flush：writeHead 只设置头部，Node 要等第一次 write/end 才真正发出。
        // 而第一条数据要等模型返回（几十秒），不 flush 的话浏览器连响应头都收不到，
        // 表现就是「发起了但没有任何回复」。
        res.flushHeaders?.();

        let closed = false;
        const send = (event) => {
          if (closed) return;
          try {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          } catch {
            closed = true;
          }
        };

        // 客户端断开时停止生成，别让模型白跑。
        const controller = new AbortController();
        req.on('close', () => {
          closed = true;
          controller.abort();
        });

        try {
          const body = await readJsonBody(req);
          const question = String(body?.question ?? body?.topic ?? '').trim();
          if (!question) throw new Error('缺少议题');

          const { masters: library } = await loadLibrary();
          const thinking = body?.thinking;

          // 有 sessionId 就是追问：沿用座位上的人，把历史带进提示词。
          const existing = body?.sessionId ? getSession(String(body.sessionId)) : undefined;
          let session = existing;
          if (!session) {
            const keys = (body?.masters ?? []).map((k) => String(k).trim()).filter(Boolean).slice(0, MAX_SEATS);
            const chosen =
              keys.length > 0
                ? keys.map((key) => findMaster(library, key)).filter(Boolean)
                : pickMasters(library, question, 3);
            if (chosen.length === 0) throw new Error('没找到可用的大师');
            session = createSession({ topic: question, seats: chosen.map((m) => m.slug), thinking });
          }

          const masters = session.seats
            .map((slug) => library.find((m) => m.slug === slug))
            .filter(Boolean);
          if (masters.length === 0) throw new Error('会话里的大师已不在库中');

          const target = await resolveTarget(ctx, config, thinking ? { thinking } : undefined);

          send({ type: 'session', sessionId: session.id, topic: session.topic });
          send({ type: 'thinking', effort: target.reasoningEffort });

          const turn = await runRoundtableStream(ctx, {
            question,
            masters,
            target,
            withHost: body?.withHost !== false,
            signal: controller.signal,
            onEvent: send,
            history: existing ? historyPrompt(existing) : '',
          });

          appendTurn(session.id, turn);
          send({ type: 'end' });
        } catch (error) {
          send({ type: 'error', error: String(error?.message ?? error) });
        } finally {
          if (!closed) res.end();
        }
      },
    }),
    webServer.register({
      path: `${BASE}/roundtable`,
      kind: 'exact',
      async handler(req, res) {
        const send = (status, payload) => {
          const text = JSON.stringify(payload);
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          });
          res.end(text);
        };
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST');
          send(405, { error: 'method not allowed' });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const result = await runRoundtableRequest(ctx, config, body);
          send(200, result);
        } catch (error) {
          send(400, { error: String(error?.message ?? error) });
        }
      },
    }),
  ];
}

export { libraryView, json };
