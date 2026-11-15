/**
 * 圆桌编排：并列短判断 + 主持人收敛。
 *
 * 延迟纪律照抄明辨的 ai-interface-design：先并行，再收敛；
 * 不追加第四轮追问，也不做决策简报——那是 App 里的活。
 *
 * @module dsh-mingbian/roundtable
 */

import { generateMany, generate, generateStream } from './llm.js';
import { hostSystemPrompt, roundtableSystemPrompt, roundtableUserPrompt } from './prompts.js';

/** 由思考档位决定回答深度：off/low 走快答，其余走深答。 */
function depthOf(target) {
  const effort = target?.reasoningEffort;
  return effort === 'off' || effort === 'low' ? 'fast' : 'deep';
}

/**
 * 按议题给大师排序，挑出立场最有张力的几位。
 *
 * 评分只做三件事：问题里的字命中专长领域 / 标签 / 分类；
 * 同分类的人最多取一个——不是要「最像」的三个人，而是要「最不该互相同意」的三个人。
 *
 * @param masters - 候选大师卡
 * @param topic - 议题
 * @param count - 需要几位
 * @returns 选中的人
 */
export function pickMasters(masters, topic, count) {
  const text = topic.toLowerCase();
  const scored = masters.map((master) => {
    let score = 0;
    for (const domain of master.consultationDomains ?? []) {
      if (domain && text.includes(domain.toLowerCase())) score += 3;
    }
    for (const tag of master.tags ?? []) {
      if (tag && text.includes(tag.toLowerCase())) score += 2;
    }
    for (const model of master.models ?? []) {
      if (model && text.includes(model.slice(0, 2).toLowerCase())) score += 1;
    }
    if (text.includes(master.name.toLowerCase())) score += 5;
    return { master, score };
  });

  // 高分的先上，同分保持目录顺序（稳定，可复现）。
  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  const usedCategories = new Set();
  for (const { master } of scored) {
    if (picked.length >= count) break;
    const primary = master.categories?.[0];
    if (primary && usedCategories.has(primary) && scored.length > count) continue;
    if (picked.some((m) => m.slug === master.slug)) continue;
    picked.push(master);
    if (primary) usedCategories.add(primary);
  }
  // 分类去重过狠时兜底补满。
  for (const { master } of scored) {
    if (picked.length >= count) break;
    if (!picked.some((m) => m.slug === master.slug)) picked.push(master);
  }
  return picked;
}

/**
 * 开一场圆桌。
 * @param ctx - 宿主上下文
 * @param options - { topic, masters, target, withHost, signal }
 * @returns { takes, host }
 */
export async function runRoundtable(ctx, options) {
  const { topic, masters, target, withHost = true, signal } = options;

  const depth = depthOf(target);
  const takeaways = await generateMany(
    ctx,
    masters.map((master) => ({
      key: master.slug,
      system: roundtableSystemPrompt(master, { depth }),
      user: roundtableUserPrompt(topic, { depth }),
      maxTokens: depth === 'deep' ? 1600 : 700,
      temperature: 0.85,
    })),
    target,
    signal,
  );

  const takes = masters.map((master, index) => {
    const result = takeaways[master.slug] ?? { text: '' };
    return {
      order: index + 1,
      slug: master.slug,
      name: master.name,
      thinkingModel: master.thinkingModel,
      take: result.text,
      ...(result.error ? { error: result.error } : {}),
    };
  });

  if (!withHost) return { takes, host: null };

  const spoken = takes.filter((t) => t.take).map((t) => `【${t.name}】${t.take}`).join('\n\n');
  if (!spoken) return { takes, host: null };

  const host = await generate(ctx, {
    target,
    system: hostSystemPrompt(masters, { depth }),
    user: `议题：${topic}\n\n各位的发言：\n${spoken}\n\n请收敛：共识 / 分歧 / 结论。`,
    maxTokens: depth === 'deep' ? 1800 : 900,
    temperature: 0.4,
    signal,
  });

  return { takes, host: host || null };
}


/**
 * 流式开一场圆桌，并把每一段增量交给 onEvent。
 *
 * 事件序列（前端按 slug 归并即可）：
 *   { type: 'seats', masters: [{slug,name,thinkingModel}] }
 *   { type: 'take-start', slug }
 *   { type: 'take-delta', slug, text }
 *   { type: 'take-end', slug, text }       —— text 是该位完整发言
 *   { type: 'host-start' }
 *   { type: 'host-delta', text }
 *   { type: 'turn', turn }                 —— 一整轮成品，供服务端落库
 *
 * 没有说话的人（失败）也会先 take-end 再继续，前端不会卡在「正在输入」。
 *
 * @param ctx - 宿主上下文
 * @param options - { question, masters, target, withHost, signal, onEvent, history }
 * @returns 这一轮的成品 { question, takes, host }
 */
export async function runRoundtableStream(ctx, options) {
  const { question, masters, target, withHost = true, signal, onEvent, history } = options;
  const emit = (event) => {
    try {
      onEvent?.(event);
    } catch {
      // 通道断了不该让生成继续烧 token。
    }
  };

  emit({
    type: 'seats',
    masters: masters.map((m) => ({ slug: m.slug, name: m.name, thinkingModel: m.thinkingModel })),
  });

  const depth = depthOf(target);
  const historyBlock = history ? `${history}\n\n` : '';
  const range = depth === 'deep' ? '260-400 字' : '120-180 字';
  const userPrompt = `${historyBlock}本次议题：${question}\n\n请以你的身份给出你的判断，篇幅 ${range}。`;

  const takes = await Promise.all(
    masters.map(async (master) => {
      emit({ type: 'take-start', slug: master.slug });
      let text = '';
      try {
        text = await generateStream(
          ctx,
          {
            target,
            system: roundtableSystemPrompt(master, { depth }),
            user: userPrompt,
            maxTokens: depth === 'deep' ? 1600 : 700,
            temperature: 0.85,
            signal,
          },
          (delta) => emit({ type: 'take-delta', slug: master.slug, text: delta }),
        );
      } catch (error) {
        text = '';
        emit({ type: 'take-delta', slug: master.slug, text: `（生成失败：${error?.message ?? error}）` });
      }
      emit({ type: 'take-end', slug: master.slug, text });
      return {
        order: masters.indexOf(master) + 1,
        slug: master.slug,
        name: master.name,
        thinkingModel: master.thinkingModel,
        take: text,
      };
    }),
  );

  let host = null;
  if (withHost) {
    const spoken = takes.filter((t) => t.take).map((t) => `【${t.name}】${t.take}`).join('\n\n');
    if (spoken) {
      emit({ type: 'host-start' });
      try {
        host = await generateStream(
          ctx,
          {
            target,
            system: hostSystemPrompt(masters, { depth }),
            user: `议题：${question}\n\n各位的发言：\n${spoken}\n\n请收敛：共识 / 分歧 / 结论。`,
            maxTokens: depth === 'deep' ? 1800 : 900,
            temperature: 0.4,
            signal,
          },
          (delta) => emit({ type: 'host-delta', text: delta }),
        );
      } catch (error) {
        host = `（主持人收敛失败：${error?.message ?? error}）`;
        emit({ type: 'host-delta', text: host });
      }
    }
  }

  const turn = { question, takes, host };
  emit({ type: 'turn', turn });
  return turn;
}
