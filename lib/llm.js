/**
 * 宿主模型调用适配层。
 *
 * 插件不自带 API Key：所有生成都复用 DSH 已配置的 provider/model，
 * 用户在明辨里那套「自己填 Key」的门槛在插件里直接消失。
 *
 * @module dsh-mingbian/llm
 */

/** 模型没吐够内容时的兜底提示。 */
const EMPTY = '（模型返回为空）';

/**
 * 从 chunk 流里拼出纯文本。
 * 兼容 text-delta 与 block 两种形态；遇到 finish 即结束。
 * @param stream - ctx.llm.stream 的返回
 * @returns 完整文本
 */
export async function collectText(stream) {
  let text = '';
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
    } else if (chunk.type === 'finish') {
      if (typeof chunk.text === 'string') text += chunk.text;
      break;
    }
  }
  return text;
}

/** 去掉模型习惯性加的 ```json 围栏，并截取第一个完整 JSON 对象。 */
export function stripFences(text) {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = (fenced ? fenced[1] : trimmed).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start !== -1 && end > start ? body.slice(start, end + 1) : body;
}

/** 容错 JSON 解析：模型偶尔会带尾逗号或多层包裹。 */
export function parseJsonLoose(text) {
  const body = stripFences(text);
  try {
    return JSON.parse(body);
  } catch {
    // 再试一次：去掉对象/数组里最后一个逗号。
    const cleaned = body.replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(cleaned);
  }
}

/**
 * 解析本次调用使用的 provider/model。
 * 优先用工具参数，其次插件配置，最后取宿主默认模型。
 * @param ctx - 宿主上下文
 * @param config - 插件配置
 * @param override - 调用方指定
 * @returns { provider, model }
 */
/** 思考档位。由 adapter 声明；DeepSeek 支持 off / low / high / max。 */
export const THINKING_LEVELS = ['off', 'low', 'high', 'max'];

/**
 * 把用户可选的思考档位折成合法值。
 *
 * 面板和工具都只说 on/off 这种人话，映射到 adapter 的档位放在这一处，
 * 免得每个调用点各写一套。
 * @param value - 用户给的档位或 on/off
 * @param fallback - 未给时的默认档位
 * @returns 合法档位
 */
export function normalizeThinking(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 'on') return 'high';
  if (value === false || value === 'off-direct') return 'off';
  return THINKING_LEVELS.includes(value) ? value : fallback;
}

/**
 * 解析本次调用使用的 provider/model/思考档位。
 * 优先用调用方指定，其次插件配置，最后取宿主默认模型。
 * @param ctx - 宿主上下文
 * @param config - 插件配置
 * @param override - 调用方指定 { provider, model, thinking }
 * @returns { provider, model, reasoningEffort }
 */
export async function resolveTarget(ctx, config, override) {
  const provider = override?.provider || config?.provider || undefined;
  const model = override?.model || config?.model || undefined;
  // 思考档位默认开：圆桌是判断题，多花的那点延迟换的是判断质量。
  // 想关掉在插件配置里写 thinking: 'off'。
  const reasoningEffort = normalizeThinking(
    override?.thinking ?? config?.thinking,
    'high',
  );

  if (provider && model) return { provider, model, reasoningEffort };

  const fromHost = await hostDefaultModel(ctx);
  const finalProvider = provider ?? fromHost.provider;
  const finalModel = model ?? fromHost.model;
  if (!finalProvider || !finalModel) {
    throw new Error(
      '没有可用的模型：请在插件配置里写 provider/model，或在工具参数里指定。',
    );
  }
  return { provider: finalProvider, model: finalModel, reasoningEffort };
}

/**
 * 读取宿主默认模型。
 *
 * Cordis 对未 inject 的服务属性是**抛错**而不是返回 undefined，所以这里一律走
 * ctx.get() 软取，再用 listProviders/listModels 兜底——插件不该要求用户再手填一遍
 * provider/model，那正是明辨 App 里被诟病的那道门槛。
 * @param ctx - 宿主上下文
 * @returns { provider, model }
 */
async function hostDefaultModel(ctx) {
  const candidates = ['defaultModel', 'agentDefaultModel', 'modelSelection', 'models'];
  for (const name of candidates) {
    let service;
    try {
      service = typeof ctx.get === 'function' ? ctx.get(name) : undefined;
    } catch {
      continue;
    }
    if (!service || typeof service !== 'object') continue;
    try {
      const value =
        typeof service.resolve === 'function'
          ? await service.resolve()
          : typeof service.current === 'function'
            ? await service.current()
            : service.current ?? service;
      const provider = value?.provider ?? value?.providerId;
      const model = value?.model ?? value?.modelId;
      if (provider && model) return { provider, model };
    } catch {
      // 形状不同就试下一个，不因为一个服务异常就整体失败。
    }
  }

  // 兜底：问 llm 服务本身有哪些路线，取第一条可用的。
  try {
    const providers = await ctx.llm.listProviders?.();
    const provider = providers?.[0]?.id ?? providers?.[0];
    if (provider) {
      const models = await ctx.llm.listModels?.(provider);
      const model = models?.[0]?.id ?? models?.[0];
      if (model) return { provider: String(provider), model: String(model) };
    }
  } catch {
    // 没有目录能力就到此为止，交给调用方报错。
  }
  return {};
}

/**
 * 单次生成，返回纯文本。
 * @param ctx - 宿主上下文
 * @param options - { target, system, user, maxTokens, temperature, signal }
 * @returns 文本
 */
export async function generate(ctx, options) {
  const { target, system, user, maxTokens = 1600, temperature = 0.7, signal } = options;
  const stream = ctx.llm.stream({
    provider: target.provider,
    model: target.model,
    // 未指定就不传：让 adapter 用它自己的默认档位，避免覆盖用户在该模型上的选择。
    ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    maxTokens,
    temperature,
    signal,
  });
  const text = await collectText(stream);
  return text.trim() || EMPTY;
}

/**
 * 流式生成：边收边把增量交给调用方，最后返回完整文本。
 *
 * 面板要能看见大师一个字一个字地说，所以这里不能用 generate 那种「等齐了再回」的方式。
 * @param ctx - 宿主上下文
 * @param options - { target, system, user, maxTokens, temperature, signal }
 * @param onDelta - 每收到一段文本回调一次；抛错不影响主流程
 * @returns 完整文本
 */
export async function generateStream(ctx, options, onDelta) {
  const { target, system, user, maxTokens = 1600, temperature = 0.7, signal } = options;
  const stream = ctx.llm.stream({
    provider: target.provider,
    model: target.model,
    ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    maxTokens,
    temperature,
    signal,
  });

  let text = '';
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
      try {
        onDelta?.(chunk.text);
      } catch {
        // 渲染端的问题不该打断生成。
      }
    } else if (chunk.type === 'finish') {
      if (typeof chunk.text === 'string' && chunk.text) {
        text += chunk.text;
        try {
          onDelta?.(chunk.text);
        } catch {
          /* 同上 */
        }
      }
      break;
    }
  }
  return text.trim();
}

/**
 * 并行生成多段文本。任何一段失败都会作为该段的错误文本保留，不拖垮整场圆桌。
 * @param ctx - 宿主上下文
 * @param jobs - [{ key, system, user, maxTokens }]
 * @param target - 模型
 * @param signal - 取消信号
 * @returns 按 key 索引的结果
 */
export async function generateMany(ctx, jobs, target, signal) {
  const settled = await Promise.all(
    jobs.map(async (job) => {
      try {
        const text = await generate(ctx, { ...job, target, signal });
        return [job.key, { text }];
      } catch (error) {
        return [job.key, { text: '', error: error?.message ?? String(error) }];
      }
    }),
  );
  return Object.fromEntries(settled);
}
