/**
 * 圆桌会话：让一场对话能持续下去，而不是每问一句就从头开始。
 *
 * 落盘到 `<storeDir>/sessions/<id>.json`，内存只做热点缓存。
 * 最初只存内存，理由是「这些是临时上下文」——实际用起来就是重启后全丢，
 * 用户找不到自己昨天问过的那个决定。所以改成持久化：写穿式（每次追加即落盘），
 * 读取时内存未命中就回落到磁盘。
 *
 * @module dsh-mingbian/sessions
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { storeDir } from './store.js';

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

/** 会话文件目录。 */
function sessionsDir() {
  return join(storeDir(), 'sessions');
}

/** 一场会话的落盘路径。 */
function sessionPath(id) {
  return join(sessionsDir(), `${id}.json`);
}

/**
 * 写穿式落盘。失败只记不抛：一次落盘失败不该让正在进行的圆桌中断。
 * @param session - 会话
 */
async function persist(session) {
  try {
    await mkdir(sessionsDir(), { recursive: true });
    await writeFile(sessionPath(session.id), `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  } catch {
    // 磁盘满、权限问题等：内存里仍然可用，下一轮会再试。
  }
}

/** 从磁盘读一场会话；不存在或损坏返回 undefined。 */
async function readFromDisk(id) {
  try {
    const session = JSON.parse(await readFile(sessionPath(id), 'utf8'));
    if (session && typeof session.id === 'string' && Array.isArray(session.turns)) return session;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 列出磁盘上的历史会话（新的在前），只带摘要字段，不搬全文。
 * @param limit - 最多几条，默认 30
 * @returns 摘要数组
 */
export async function listSessions(limit = 30) {
  let files;
  try {
    files = await readdir(sessionsDir());
  } catch {
    return [];
  }
  const rows = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const session = await readFromDisk(file.slice(0, -5));
    if (!session) continue;
    const last = session.turns[session.turns.length - 1];
    rows.push({
      id: session.id,
      topic: session.topic,
      seats: session.seats ?? [],
      turnCount: session.turns.length,
      createdAt: session.createdAt,
      updatedAt: last?.at ?? session.createdAt,
    });
  }
  rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return rows.slice(0, limit);
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
  void persist(session);
  return session;
}

/**
 * 取一场会话；不存在返回 undefined。
 * @param id - 会话 id
 * @returns 会话或 undefined
 */
export async function getSession(id) {
  let session = sessions.get(id);
  // 内存未命中就回落磁盘：重启后继续上次那场圆桌，靠的就是这一步。
  if (!session) {
    session = await readFromDisk(id);
    if (!session) return undefined;
    sessions.set(id, session);
  }
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
export async function appendTurn(id, turn) {
  const session = await getSession(id);
  if (!session) return undefined;
  session.turns.push({ ...turn, at: Date.now() });
  await persist(session);
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
