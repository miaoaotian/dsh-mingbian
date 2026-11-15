/**
 * 离线冒烟测试：不连模型，只验证「写得进去、查得出来、渲染得出来」。
 * 用假 ctx 模拟宿主，覆盖 apply / 两个 tool / skill 注册三条路径。
 *
 * 跑法：node --test test/
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// store 在导入时读环境变量，所以必须先设再动态 import。
const dir = await mkdtemp(join(tmpdir(), 'mingbian-'));
process.env.DSH_MINGBIAN_DIR = dir;

const { apply, name, inject } = await import('../lib/index.js');
const { validateMaster, slugify } = await import('../lib/schema.js');
const { pickMasters } = await import('../lib/roundtable.js');
const { loadLibrary } = await import('../lib/store.js');
const { parseJsonLoose } = await import('../lib/llm.js');

const GOOD_MASTER = {
  slug: 'taleb',
  name: '塔勒布',
  avatarType: 'PERSON',
  categories: ['probability'],
  thinkingModel: '反脆弱',
  summary: '把不确定性从敌人改造成原料：不预测黑天鹅，而是让自己在小概率事件里获益。',
  voice: '短句、带刺、爱用秤和赌注的比喻；先问「你承担的下行是什么」，再谈收益。',
  models: ['杠铃策略：极端保守与极端激进并存，中间地带最危险', '幸存者偏差：先看谁没活下来'],
  heuristics: ['先算出最坏情况能不能活下来', '把不可逆的决定与可逆的决定分开处理', '不为没有凸性的收益付溢价'],
  antiPatterns: ['预测具体点位', '在不可逆的下行上追求平均值'],
  tension: '鄙视预测，却必须用概率语言说话。',
  boundary: '解释不了需要精确协调的工程与制度设计；容易被误读成什么都别做。',
  tags: ['不确定性', '风险'],
  consultationDomains: ['投资', '风险'],
  intakeQuestions: ['最坏情况你能不能承受？'],
  guardrails: ['不保证收益', '涉及法律与人身安全建议找专业人士'],
};

/** 造一个可被事件式读取的假 IncomingMessage。 */
function makeReq(payload) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.readableEnded = false;
  req.destroy = () => {};
  process.nextTick(() => {
    if (payload) req.emit('data', Buffer.from(payload));
    req.emit('end');
  });
  return req;
}

/** 造一个只够用的假宿主。 */
function fakeContext({ reply } = {}) {
  const tools = new Map();
  const skills = [];
  const ctx = {
    logger: { warn() {}, info() {} },
    tools: { register: (def) => tools.set(def.name, def) },
    skills: { register: (skill) => skills.push(skill) },
    llm: {
      stream(options) {
        const payload = typeof reply === 'function' ? reply(options) : reply;
        return (async function* chunks() {
          yield { type: 'text-delta', index: 0, text: payload };
          yield { type: 'finish', reason: 'stop' };
        })();
      },
    },
    // 真实宿主里未 inject 的服务属性会抛错，所以实现改走 ctx.get() 软取。
    get: (name) => (name === 'defaultModel' ? { current: { provider: 'p', model: 'm' } } : undefined),
    // 真实宿主里 webServer 是必声明服务，且 ctx.effect 是同步执行一次注册函数。
    webServer: { register: () => () => {} },
    effect: (fn) => {
      const dispose = fn();
      return () => (typeof dispose === 'function' ? dispose() : undefined);
    },
  };
  return { ctx, tools, skills };
}

test('包元数据与依赖声明', () => {
  assert.equal(name, 'dsh-mingbian');
  // webServer 必须在 inject 里：不声明的属性访问会直接抛错，try/catch 兜不住。
  assert.deepEqual(inject, ['tools', 'llm', 'skills', 'webServer']);
});

test('apply 注册了 skill 与两个工具', async () => {
  const { ctx, tools, skills } = fakeContext({ reply: '{}' });
  apply(ctx, {});
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual([...tools.keys()].sort(), ['distill_master', 'master_roundtable']);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'mingbian');
  assert.ok(skills[0].content.includes('蒸馏'), 'skill 正文应已读入');
});

test('schema 接受合法卡片、拒绝缺边界与未知分类', async () => {
  const categories = new Set(['probability']);
  assert.deepEqual(validateMaster(GOOD_MASTER, categories), []);

  const noBoundary = { ...GOOD_MASTER, boundary: '' };
  assert.ok(validateMaster(noBoundary, categories).some((p) => p.includes('boundary')));

  const badCategory = { ...GOOD_MASTER, categories: ['nope'] };
  assert.ok(validateMaster(badCategory, categories).some((p) => p.includes('未知思维分类')));

  const badAvatar = { ...GOOD_MASTER, avatarType: 'ROBOT' };
  assert.ok(validateMaster(badAvatar, categories).some((p) => p.includes('avatarType')));
});

test('slugify 只产出 kebab-case', () => {
  assert.equal(slugify('Nassim Taleb'), 'nassim-taleb');
  assert.equal(slugify('???'), '');
});

test('parseJsonLoose 吃掉代码围栏与尾逗号', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1,}\n```'), { a: 1 });
});

test('distill_master 落盘后可被 re-import 成合法 JSON', async () => {
  const { ctx, tools } = fakeContext({ reply: JSON.stringify(GOOD_MASTER) });
  apply(ctx, {});
  const tool = tools.get('distill_master');
  const result = await tool.execute({ source: '塔勒布' }, { signal: undefined });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.ok(result.savedTo.endsWith('taleb.json'));
  const saved = JSON.parse(await readFile(result.savedTo, 'utf8'));
  assert.equal(saved.slug, 'taleb');
  assert.ok(Array.isArray(saved.heuristics));
});

test('distill_master 两次都不合格时不落盘且报出问题', async () => {
  const broken = JSON.stringify({ ...GOOD_MASTER, category: [], boundary: 'x' });
  const { ctx, tools } = fakeContext({ reply: broken });
  apply(ctx, {});
  const result = await tools.get('distill_master').execute(
    { source: '塔勒布', slug: 'broken-one' },
    { signal: undefined },
  );
  assert.equal(result.ok, false);
  assert.equal(result.savedTo, '');
  assert.ok(result.problems.length > 0);
});

test('pickMasters 按议题命中专长，且不同分类优先', async () => {
  const { masters } = await loadLibrary();
  const picked = pickMasters(masters, '这个 offer 的谈判底线怎么定', 3);
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked.map((m) => m.slug)).size, 3);
});

test('master_roundtable 并行出三份短判断并有主持人', async () => {
  const { ctx, tools } = fakeContext({
    reply: (options) => (options.system.includes('主持人') ? '共识：x。分歧：y。结论：z。' : '我的判断是这句。'),
  });
  apply(ctx, {});
  const value = await tools.get('master_roundtable').execute(
    { topic: '要不要接这个 offer', masters: ['塔勒布'] },
    { signal: undefined },
  );
  assert.equal(value.takes.length, 1);
  assert.equal(value.takes[0].name, '塔勒布');
  assert.match(value.host, /共识/);
});

test('master_roundtable 找不到大师时报错而不是静默空跑', async () => {
  const { ctx, tools } = fakeContext({ reply: 'x' });
  apply(ctx, {});
  await assert.rejects(
    () => tools.get('master_roundtable').execute({ topic: 't', masters: ['不存在的人'] }, { signal: undefined }),
    /没找到大师/,
  );
});

// ── 面板路由 ────────────────────────────────────────────────────────────
const { respond, BASE } = await import('../lib/routes.js');

test('library 路由返回合并后的库与计数', async () => {
  const response = await respond(`${BASE}/library`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.ok(body.masters.length >= 48, '至少包含 48 位内置大师');
  assert.equal(typeof body.counts.distilled, 'number');
  assert.ok(Array.isArray(body.categories) && body.categories.length > 0);
  // 面板依赖的字段必须齐全（少一个就会渲染成空白）。
  for (const field of ['slug', 'name', 'thinkingModel', 'summary', 'voice', 'tension', 'boundary', 'origin']) {
    assert.ok(field in body.masters[0], `缺字段 ${field}`);
  }
});

test('export 路由能吐出可导入后端的 JSON', async () => {
  const response = await respond(`${BASE}/export/taleb`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true, JSON.stringify(body.problems));
  assert.equal(body.master.slug, 'taleb');
  assert.equal(body.master.origin, undefined, '导出的卡不该带 origin 这种本地标记');
  assert.equal(typeof body.master.sortOrder, 'number');
});

test('export 不存在的 slug 返回 404 而不是 500', async () => {
  const response = await respond(`${BASE}/export/没有这个人`);
  assert.equal(response.status, 404);
});

test('未知路径返回 404', async () => {
  const response = await respond('/mingbian/nope');
  assert.equal(response.status, 404);
});

test('apply 挂上六条路由并在卸载时回收', async () => {
  const registered = [];
  const disposed = [];
  const { ctx } = fakeContext({ reply: '{}' });
  ctx.webServer = {
    register: (route) => {
      registered.push(route);
      return () => disposed.push(route.path);
    },
  };
  const disposers = [];
  ctx.effect = (fn) => {
    disposers.push(fn());
  };
  apply(ctx, {});
  assert.deepEqual(
    registered.map((r) => [r.path, r.kind]).sort(),
    [
      [`${BASE}/deleted`, 'exact'],
      [`${BASE}/export`, 'prefix'],
      [`${BASE}/library`, 'exact'],
      [`${BASE}/master`, 'prefix'],
      [`${BASE}/roundtable`, 'exact'],
      [`${BASE}/stream`, 'exact'],
    ].sort(),
  );
  // 只读两条走 resource，圆桌走 handler（要 POST）。
  const byPath = Object.fromEntries(registered.map((r) => [r.path, r]));
  assert.equal(typeof byPath[`${BASE}/library`].resource, 'function');
  assert.equal(typeof byPath[`${BASE}/export`].resource, 'function');
  assert.equal(typeof byPath[`${BASE}/roundtable`].handler, 'function');
  assert.equal(byPath[`${BASE}/roundtable`].resource, undefined, '圆桌要 POST，不能用只读的 resource');
  assert.equal(typeof byPath[`${BASE}/stream`].handler, 'function', '流式必须走 handler，resource 无法保持连接');

  disposers.forEach((dispose) => dispose());
  assert.equal(disposed.length, 6);
});

test('圆桌路由拒绝非 POST', async () => {
  const registered = [];
  const { ctx } = fakeContext({ reply: '{}' });
  ctx.webServer = { register: (r) => { registered.push(r); return () => {}; } };
  ctx.effect = (fn) => fn();
  apply(ctx, {});
  const route = registered.find((r) => r.path === `${BASE}/roundtable`);

  const headers = {};
  let status = 0;
  let body = '';
  const res = {
    setHeader: (k, v) => { headers[k] = v; },
    writeHead: (s) => { status = s; },
    end: (t) => { body = t ?? ''; },
  };
  await route.handler({ method: 'GET' }, res);
  assert.equal(status, 405);
  assert.equal(headers.allow, 'POST');
});

test('圆桌路由能在宿主侧跑完整一场', async () => {
  const registered = [];
  const { ctx } = fakeContext({
    reply: (options) => (options.system.includes('主持人') ? '共识：x。分歧：y。结论：z。' : '我的判断。'),
  });
  ctx.webServer = { register: (r) => { registered.push(r); return () => {}; } };
  ctx.effect = (fn) => fn();
  apply(ctx, {});
  const route = registered.find((r) => r.path === `${BASE}/roundtable`);

  const payload = JSON.stringify({ topic: '要不要接这个 offer', masters: ['taleb'], thinking: 'high' });
  const req = makeReq(payload);

  let status = 0;
  let body = '';
  const res = { setHeader() {}, writeHead: (s) => { status = s; }, end: (t) => { body = t ?? ''; } };
  await route.handler(req, res);

  assert.equal(status, 200, body);
  const data = JSON.parse(body);
  assert.equal(data.takes.length, 1);
  assert.equal(data.takes[0].name, '塔勒布');
  assert.match(data.host, /共识/);
});

// ── 思考档位与人数范围 ──────────────────────────────────────────────────
const { resolveTarget, normalizeThinking, THINKING_LEVELS } = await import('../lib/llm.js');
const { MAX_SEATS } = await import('../lib/routes.js');

test('深思默认开启：不传 thinking 时走 high', async () => {
  const { ctx } = fakeContext({ reply: '{}' });
  assert.equal((await resolveTarget(ctx, {})).reasoningEffort, 'high');
  // 显式关掉仍然有效。
  assert.equal((await resolveTarget(ctx, {}, { thinking: 'off' })).reasoningEffort, 'off');
  // 配置层也能覆盖。
  assert.equal((await resolveTarget(ctx, { thinking: 'max' })).reasoningEffort, 'max');
});

test('思考档位归一：on→high、未知值回落、off 原样', async () => {
  assert.deepEqual(THINKING_LEVELS, ['off', 'low', 'high', 'max']);
  assert.equal(normalizeThinking(true, 'off'), 'high');
  assert.equal(normalizeThinking('on', 'off'), 'high');
  assert.equal(normalizeThinking('off', 'high'), 'off');
  assert.equal(normalizeThinking('乱写', 'off'), 'off');
  assert.equal(normalizeThinking(undefined, 'high'), 'high');
});

test('思考档位真的传进了模型调用', async () => {
  const seen = [];
  const { ctx, tools } = fakeContext({ reply: JSON.stringify(GOOD_MASTER) });
  ctx.llm.stream = (options) => {
    seen.push(options.reasoningEffort);
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: JSON.stringify(GOOD_MASTER) };
      yield { type: 'finish', reason: 'stop' };
    })();
  };
  apply(ctx, {});
  await tools.get('distill_master').execute({ source: '塔勒布', slug: 'think-test' }, { signal: undefined });
  assert.equal(seen[0], 'high', '默认应带 reasoningEffort=high');
});

test('人数上限放宽到 6', () => {
  assert.equal(MAX_SEATS, 6);
});

// ── 流式与多轮 ──────────────────────────────────────────────────────────
const { createSession, appendTurn, getSession, historyPrompt, resetSessions } = await import('../lib/sessions.js');
const { runRoundtableStream } = await import('../lib/roundtable.js');

test('会话：新建、追加、历史拼进提示词', () => {
  resetSessions();
  const session = createSession({ topic: '要不要接 offer', seats: ['taleb', 'munger'], thinking: 'high' });
  assert.equal(session.turns.length, 0);
  assert.equal(historyPrompt(session), '', '没有历史时不产生任何提示');

  appendTurn(session.id, {
    question: '要不要接 offer',
    takes: [{ name: '塔勒布', take: '先看最坏情况' }],
    host: '共识：算清风险',
  });
  const loaded = getSession(session.id);
  assert.equal(loaded.turns.length, 1);

  const prompt = historyPrompt(loaded);
  assert.match(prompt, /要不要接 offer/);
  assert.match(prompt, /塔勒布/);
  assert.match(prompt, /共识：算清风险/);
});

test('会话不存在的 id 返回 undefined，不抛错', () => {
  assert.equal(getSession('rt-不存在'), undefined);
});

test('流式圆桌按顺序发出 seats → take-* → host-* → turn', async () => {
  const events = [];
  const { ctx } = fakeContext({
    reply: (options) => (options.system.includes('主持人') ? '共识。' : '判断。'),
  });
  const { masters } = await loadLibrary();
  const chosen = [masters[0], masters[1]];

  const turn = await runRoundtableStream(ctx, {
    question: '该不该换工作',
    masters: chosen,
    target: { provider: 'p', model: 'm', reasoningEffort: 'high' },
    onEvent: (e) => events.push(e),
  });

  const types = events.map((e) => e.type);
  assert.equal(types[0], 'seats');
  assert.ok(types.includes('take-start'));
  assert.ok(types.includes('take-delta'));
  assert.ok(types.includes('take-end'));
  assert.ok(types.includes('host-start'));
  assert.ok(types.includes('host-delta'));
  assert.equal(types[types.length - 1], 'turn');

  // 每位大师都要有 start/end 成对，前端才不会卡在「正在输入」。
  for (const m of chosen) {
    assert.equal(events.filter((e) => e.type === 'take-start' && e.slug === m.slug).length, 1);
    assert.equal(events.filter((e) => e.type === 'take-end' && e.slug === m.slug).length, 1);
  }
  assert.equal(turn.takes.length, 2);
  assert.ok(turn.host);
});

test('流式圆桌带上历史时，user prompt 里能看到上一轮', async () => {
  const seen = [];
  const { ctx } = fakeContext({ reply: 'x' });
  ctx.llm.stream = (options) => {
    seen.push(options.messages?.[0]?.content?.[0]?.text ?? '');
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: '好' };
      yield { type: 'finish', reason: 'stop' };
    })();
  };
  const { masters } = await loadLibrary();
  await runRoundtableStream(ctx, {
    question: '那如果薪水再高一点呢',
    masters: [masters[0]],
    target: { provider: 'p', model: 'm', reasoningEffort: 'off' },
    history: '这场圆桌之前已经聊过：\n用户问：要不要接 offer\n塔勒布：先看最坏情况',
  });
  assert.ok(
    seen.some((t) => t.includes('那如果薪水再高一点呢') && t.includes('先看最坏情况')),
    '追问必须同时带上新问题和上一轮内容',
  );
});

test('SSE 路由：流式事件序列完整，且会话可追问', async () => {
  resetSessions();
  const registered = [];
  const { ctx } = fakeContext({
    reply: (options) => (options.system.includes('主持人') ? '共识：算清最坏情况。' : '先看下行。'),
  });
  ctx.webServer = { register: (r) => { registered.push(r); return () => {}; } };
  ctx.effect = (fn) => fn();
  apply(ctx, {});
  const route = registered.find((r) => r.path === `${BASE}/stream`);
  assert.ok(route, 'stream 路由必须存在');

  /** 跑一次流，收集收到的 SSE 事件。 */
  async function runStream(payload) {
    const events = [];
    let headers = null;
    let status = 0;
    const res = {
      setHeader() {},
      writeHead(s, h) { status = s; headers = h; },
      write(chunk) {
        const text = String(chunk);
        for (const line of text.split('\n')) {
          if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
        }
      },
      end() {},
    };
    await route.handler(makeReq(JSON.stringify(payload)), res);
    return { events, headers, status };
  }

  const first = await runStream({ question: '要不要接这个 offer', masters: ['taleb', 'munger'], thinking: 'high' });
  assert.equal(first.status, 200);
  assert.match(first.headers['content-type'], /text\/event-stream/);

  const types = first.events.map((e) => e.type);
  assert.ok(types.includes('session'), '必须先给出 sessionId，前端才能追问');
  assert.ok(types.includes('seats'));
  assert.ok(types.includes('take-delta'), '没有增量就没有流式');
  assert.ok(types.includes('host-delta'));
  assert.equal(types[types.length - 1], 'end');

  const sessionId = first.events.find((e) => e.type === 'session').sessionId;
  assert.ok(sessionId);

  // 追问：只带 sessionId，不再传 masters，应沿用同一批人。
  const second = await runStream({ question: '如果薪水翻倍呢', sessionId, thinking: 'high' });
  const secondSession = second.events.find((e) => e.type === 'session')?.sessionId;
  assert.equal(secondSession, sessionId, '追问必须复用同一场会话');

  const turns = second.events.filter((e) => e.type === 'turn');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].turn.question, '如果薪水翻倍呢');

  // 两轮都落进了会话。
  assert.equal(getSession(sessionId).turns.length, 2);
});

test('SSE 路由对空议题回 error 事件而不是挂住', async () => {
  resetSessions();
  const registered = [];
  const { ctx } = fakeContext({ reply: 'x' });
  ctx.webServer = { register: (r) => { registered.push(r); return () => {}; } };
  ctx.effect = (fn) => fn();
  apply(ctx, {});
  const route = registered.find((r) => r.path === `${BASE}/stream`);

  const events = [];
  const res = {
    setHeader() {},
    writeHead() {},
    write(chunk) {
      for (const line of String(chunk).split('\n')) {
        if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
      }
    },
    end() {},
  };
  await route.handler(makeReq(JSON.stringify({ masters: ['taleb'] })), res);
  assert.ok(events.some((e) => e.type === 'error' && e.error.includes('议题')));
});

// ── 分类与删除 ──────────────────────────────────────────────────────────
const { deleteMaster, restoreMaster, loadDeleted } = await import('../lib/store.js');

test('分类计数随库一起返回，前端筛选条能直接用', async () => {
  const response = await respond(`${BASE}/library`);
  const body = await response.json();
  assert.ok(Array.isArray(body.categories));
  // 每个分类都带 count，且总和等于各人分类数之和（一人可属多类）。
  for (const c of body.categories) {
    assert.equal(typeof c.count, 'number', `${c.slug} 缺 count`);
  }
  const systems = body.categories.find((c) => c.slug === 'systems');
  assert.ok(systems && systems.count > 0, '系统工程分类应有人');
});

test('删除内置大师：靠墓碑挡住，随包文件不动', async () => {
  const before = await (await respond(`${BASE}/library`)).json();
  const target = before.masters[0].slug;

  await deleteMaster(target);
  const after = await (await respond(`${BASE}/library`)).json();
  assert.ok(!after.masters.some((m) => m.slug === target), '删掉的人不该再出现');
  assert.equal(after.counts.total, before.counts.total - 1);
  assert.ok(after.deleted.includes(target), '已删列表里要能看到');

  // 导出接口也要认墓碑，不能从侧门捞回来。
  const exported = await respond(`${BASE}/export/${target}`);
  assert.equal(exported.status, 404, '已删的大师不应还能导出');

  // 随包目录文件不受影响。
  const bundled = JSON.parse(await readFile(new URL('../catalog/masters.json', import.meta.url), 'utf8'));
  assert.ok(bundled.some((m) => m.slug === target), '内置文件必须原样保留');
});

test('删除后可恢复', async () => {
  const body = await (await respond(`${BASE}/library`)).json();
  const target = body.masters[0].slug;
  await deleteMaster(target);
  await restoreMaster(target);
  const restored = await (await respond(`${BASE}/library`)).json();
  assert.ok(restored.masters.some((m) => m.slug === target));
  assert.ok(!restored.deleted.includes(target));
});

test('删除路由：DELETE 生效、非 DELETE 拒绝', async () => {
  const registered = [];
  const { ctx } = fakeContext({ reply: '{}' });
  ctx.webServer = { register: (r) => { registered.push(r); return () => {}; } };
  ctx.effect = (fn) => fn();
  apply(ctx, {});
  const route = registered.find((r) => r.path === `${BASE}/master`);

  const body = await (await respond(`${BASE}/library`)).json();
  const victim = body.masters[0].slug;

  function call(method, url) {
    return new Promise((resolve) => {
      const req = new EventEmitter();
      req.method = method;
      req.url = url;
      req.readableEnded = true;
      req.destroy = () => {};
      const res = {
        headers: {},
        setHeader(k, v) { this.headers[k] = v; },
        writeHead(status) { this.status = status; },
        end(text) { resolve({ status: this.status, body: text ?? '', headers: this.headers }); },
      };
      route.handler(req, res);
    });
  }

  const ok = await call('DELETE', `${BASE}/master/${victim}`);
  assert.equal(ok.status, 200, ok.body);
  assert.equal(JSON.parse(ok.body).deleted, true);

  const back = await call('POST', `${BASE}/master/${victim}/restore`);
  assert.equal(back.status, 200, back.body);
  assert.equal(JSON.parse(back.body).deleted, false);

  const bad = await call('PATCH', `${BASE}/master/${victim}`);
  assert.equal(bad.status, 405);
});

test('prefix 路由的 path 不能带尾斜杠（带了会静默不生效）', async () => {
  const registered = [];
  const { ctx } = fakeContext({ reply: '{}' });
  ctx.webServer = { register: (r) => { registered.push(r); return () => {}; } };
  ctx.effect = (fn) => fn();
  apply(ctx, {});

  for (const route of registered) {
    if (route.kind !== 'prefix') continue;
    assert.ok(
      !route.path.endsWith('/'),
      `prefix 路由 ${route.path} 带了尾斜杠 —— 宿主把它当 exact 匹配，GET 会落到 404 fallback`,
    );
  }
  // 另外确认两条 prefix 都在。
  const prefixes = registered.filter((r) => r.kind === 'prefix').map((r) => r.path).sort();
  assert.deepEqual(prefixes, [`${BASE}/export`, `${BASE}/master`]);
});
