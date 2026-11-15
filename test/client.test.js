/**
 * 客户端 bundle 契约测试。
 *
 * 这类错误在 Node 侧跑不出来（bundle 是浏览器副作用脚本），但「有没有按两阶段
 * 注册」是纯逻辑，可以用 vm + 假宿主精确断言——右侧栏最隐蔽的坑就在这里：
 * 只注册正文不注册类型，侧栏查不到正文，界面上什么都不出现。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'lib', 'client.js'), 'utf8');

/** 在 vm 里执行 bundle，返回它注册的 factory 与模块 id。 */
function loadBundle() {
  let captured;
  const React = {
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useCallback: (f) => f,
    useMemo: (f) => f(),
    createElement: () => null,
  };
  const modules = { react: React, 'react/jsx-runtime': { jsx: () => null, jsxs: () => null } };
  const sandbox = {
    console,
    document: undefined,
    setTimeout,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    window: { __ModuleLoader__: { load: (info) => { captured = info; } } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'client.js' });
  if (!captured) throw new Error('bundle 没有调用 __ModuleLoader__.load');
  const exports = captured.factory((name) => {
    if (!(name in modules)) throw new Error(`bundle 请求了未提供的模块: ${name}`);
    return modules[name];
  });
  return { id: captured.id, exports };
}

/** 收集 apply 对宿主做的一切。 */
function runApply(withSidebar = true) {
  const { id, exports } = loadBundle();
  const seen = { types: [], slots: [], effects: [], gets: [] };
  const ctx = {
    get(name) {
      seen.gets.push(name);
      if (name === 'sidebarRightTabs' && withSidebar) {
        return { register: (def) => { seen.types.push(def); return () => {}; } };
      }
      return undefined;
    },
    slots: {
      register: (meta, fn) => { seen.slots.push({ meta, fn }); return () => {}; },
      inject: (_name, body) => {
        const it = body();
        let step = it.next();
        while (!step.done) step = it.next();
      },
    },
    effect: (fn) => { seen.effects.push(fn); fn(); },
  };
  exports.apply(ctx);
  return { id, exports, seen };
}

test('bundle 注册的模块 id 与包名一致', () => {
  const { id } = loadBundle();
  assert.equal(id, 'dsh-mingbian');
});

test('bundle 只使用 baseline 种子模块', () => {
  // 一旦这里出现别的模块名，package.json 就必须补 dsh.client.external，
  // 否则宿主在缺供应商时拒绝整个客户端入口。
  const required = [...SRC.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(required)].sort(), ['react', 'react/jsx-runtime']);
});

/** 按插槽名取注册项。 */
const slotNamed = (seen, name) => seen.slots.find((s) => s.meta.name === name);

test('右侧栏两阶段注册齐全：先注册标签类型，再按 id 提供正文', () => {
  const { seen } = runApply();
  assert.equal(seen.types.length, 1, '缺少标签类型注册，右侧栏不会有入口');

  const type = seen.types[0];
  const slot = slotNamed(seen, 'sidebar.right.pane.tab');
  assert.ok(slot, '缺少右侧栏正文插槽');
  assert.equal(type.priority, 'extension');
  assert.equal(typeof type.title(), 'string');
  assert.ok(Array.isArray(type.guide) && type.guide.length > 0, 'guide 决定用户能否在侧栏找到入口');

  // 右侧栏最隐蔽的坑：slot 的 key 必须是类型的 id，用 kind 会查不到正文。
  assert.equal(slot.meta.key, type.id, 'slot key 必须等于标签类型的 id');
  assert.notEqual(slot.meta.key, type.kind, 'key 不能写成 kind');
});

test('左侧图标栏用 id、主面板用 key，且两者同名', () => {
  const { seen } = runApply();

  const icon = slotNamed(seen, 'sidebar.panellist');
  const panel = slotNamed(seen, 'main');
  assert.ok(icon, '左侧图标栏没有注册 → 左边看不到入口');
  assert.ok(panel, '主面板没有注册 → 点图标会空白');

  // list 语义的插槽认 id，keyed 语义的插槽认 key。写反任一个，图标和面板就断链。
  assert.equal(typeof icon.meta.id, 'string', 'sidebar.panellist 必须用 id');
  assert.equal(icon.meta.key, undefined, 'sidebar.panellist 不能用 key');
  assert.equal(typeof panel.meta.key, 'string', 'main 必须用 key');
  assert.equal(icon.meta.id, panel.meta.key, '图标 id 必须等于主面板 key，否则点了打不开');
  assert.equal(typeof icon.meta.label, 'function', '图标需要 label，侧栏靠它取按钮文案');
  assert.equal(typeof icon.meta.label(), 'string');
});

test('左侧图标与主面板都能渲染', () => {
  const { seen } = runApply();
  assert.doesNotThrow(() => slotNamed(seen, 'sidebar.panellist').fn({ size: 20, active: false }));
  assert.doesNotThrow(() => slotNamed(seen, 'sidebar.panellist').fn({ size: 20, active: true }));
  assert.doesNotThrow(() => slotNamed(seen, 'main').fn());
});

test('正文组件可被渲染函数取到', () => {
  const { seen } = runApply();
  assert.doesNotThrow(() => slotNamed(seen, 'sidebar.right.pane.tab').fn());
});

test('没有 sidebarRightTabs 服务时只告警、不抛错', () => {
  assert.doesNotThrow(() => runApply(false));
});
