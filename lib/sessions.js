/**
 * 圆桌会话：让一场对话能持续下去，而不是每问一句就从头开始。
 *
 * 存在进程内存里。理由很实际：这些是「刚才那场讨论」的临时上下文，
 * 重启后还能继续才是意外的；真要长期留存应该在明辨 App 里做，不是插件的活。
 * 为避免长跑进程无限增长，只保留最近若干场，超出按最久未用淘汰。
 *
 * @module dsh-mingbian/sessions
 */

/** 同时留在内存里的会话上限。 */
const MAX_SESSIONS = 40;

/** id → 会话。Map 的插入顺序即创建顺序，淘汰时从最早的开始。 */
const sessions = new Map();

let counter = 0;

/** 造一个不撞车的短 id。 */
function nextId() {
  counter += 1;
  return `rt-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/**
 * 开一场新会话。
 * @param params - { topic, seats, thinking }
 * @returns 新会话
 */
export function createSession({ topic, seats, thinking }) {
  const session = {
    id: nextId(),
    topic,
    seats: [...seats],
    thinking,
    /** 每一轮：{ question, takes, host, at } */
    turns: [],
    createdAt: Date.now(),
  };
  sessions.set(session.id, session);
  prune();
  return session;
}

/**
 * 取一场会话；不存在返回 undefined。
 * @param id - 会话 id
 * @returns 会话或 undefined
 */
export function getSession(id) {
  const session = sessions.get(id);
  if (!session) return undefined;
  // 命中即视为最近使用：重新插入把它挪到队尾。
  sessions.delete(id);
  sessions.set(id, session);
  return session;
}

/**
 * 往会话里追加一轮问答。
 * @param id - 会话 id
 * @param turn - { question, takes, host }
 * @returns 更新后的会话，或 undefined
 */
export function appendTurn(id, turn) {
  const session = getSession(id);
  if (!session) return undefined;
  session.turns.push({ ...turn, at: Date.now() });
  return session;
}

/** 超上限时淘汰最久未用的。 */
function prune() {
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    sessions.delete(oldest);
  }
}

/**
 * 把会话历史压成提示词片段。
 *
 * 只带「大师说过什么、主持人收敛过什么」，不带用户原问题的重复摘要——
 * 追问时要的是上下文延续，不是把整场对话再念一遍。
 * @param session - 会话
 * @param limit - 最多回溯几轮，默认 3
 * @returns 提示词片段，无历史时为空串
 */
export function historyPrompt(session, limit = 3) {
  if (!session || session.turns.length === 0) return '';
  const recent = session.turns.slice(-limit);
  const lines = ['这场圆桌之前已经聊过：'];
  for (const turn of recent) {
    lines.push(`用户问：${turn.question}`);
    for (const take of turn.takes ?? []) {
      if (take.take) lines.push(`${take.name}：${take.take}`);
    }
    if (turn.host) lines.push(`主持人结论：${turn.host}`);
  }
  return lines.join('\n');
}

/** 测试用：清空所有会话。 */
export function resetSessions() {
  sessions.clear();
  counter = 0;
}
