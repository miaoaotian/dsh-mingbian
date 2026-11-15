/**
 * 明辨 · 面板（浏览器半侧）。
 *
 * 形态约束（照抄本机已验证能加载的插件）：
 *   - 整个文件是普通副作用脚本，不能有顶层 ESM import/export；
 *   - React 由 factory 的 require 取得，react/jsx-runtime 同理；
 *   - 末尾用 window.__ModuleLoader__.load 注册 { id, factory }。
 *
 * 交互原则（每条都对应一次栽过的跟头）：
 *   - 「加入圆桌」是看得见的按钮，不靠双击这种没人猜得到的手势；
 *   - 已选的人一直显示在底部，随时能取消；人数 1–6，一个人也值得问；
 *   - 开桌结果在面板里直接出来，不把一句话塞进会话输入框；
 *   - 每个异步动作都有 busy / 错误态，点完不能没反应；
 *   - 深思默认开启——圆桌是判断题，多等的几十秒换的是判断质量。
 *
 * @module dsh-mingbian/client
 */

;(() => {
  const PLUGIN_ID = 'dsh-mingbian';
  const BASE = '/mingbian';
  const PANEL_ID = 'mingbian';
  const TAB_ID = 'mingbian-panel';
  const TAB_KIND = 'mingbian';
  const CSS_ID = 'dsh-mingbian-css';

  /** 圆桌人数范围：下限 1（一个人也值得问），上限 6（再多主持就收敛不住了）。 */
  const MIN_SEATS = 1;
  const MAX_SEATS = 6;

  const CSS = `
.md-root{display:flex;flex-direction:column;height:100%;min-height:0;font:13px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--dsh-text,#e6e6e6)}
.md-top{display:flex;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--dsh-border,rgba(255,255,255,.09));flex:none}
.md-search{flex:1;min-width:0;padding:6px 10px;border-radius:7px;border:1px solid var(--dsh-border,rgba(255,255,255,.14));background:var(--dsh-input-bg,rgba(255,255,255,.045));color:inherit;font:inherit;font-size:12.5px;transition:border-color .12s}
.md-search:focus{outline:none;border-color:var(--dsh-accent,#5b9dff);background:rgba(91,157,255,.05)}
.md-count{font-size:11px;opacity:.45;white-space:nowrap;font-variant-numeric:tabular-nums}
.md-btn{padding:6px 11px;border-radius:7px;border:1px solid var(--dsh-border,rgba(255,255,255,.14));background:var(--dsh-btn-bg,rgba(255,255,255,.055));color:inherit;font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s,opacity .12s}
.md-btn:hover:not(:disabled){background:var(--dsh-btn-bg-hover,rgba(255,255,255,.11))}
.md-btn:disabled{opacity:.38;cursor:not-allowed}
.md-btn-primary{border-color:transparent;background:linear-gradient(180deg,#5b9dff,#3f83ea);color:#fff;font-weight:600;box-shadow:0 1px 6px rgba(91,157,255,.32)}
.md-btn-primary:hover:not(:disabled){background:linear-gradient(180deg,#6ba7ff,#4a8df0)}
.md-btn-ghost{border-color:transparent;background:transparent;opacity:.7}
.md-btn-ghost:hover:not(:disabled){background:rgba(255,255,255,.07);opacity:1}
.md-main{display:flex;flex:1;min-height:0}

/* 左列：名单 */
.md-list{width:196px;flex:none;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsh-border,rgba(255,255,255,.09));background:rgba(0,0,0,.06)}
.md-rows{flex:1;overflow-y:auto;padding:5px 0}
.md-row{display:flex;align-items:center;gap:6px;margin:1px 6px;padding:6px 7px 6px 9px;border-radius:6px;cursor:pointer;font-size:12.5px;transition:background .1s}
.md-row:hover{background:rgba(255,255,255,.055)}
.md-row.on{background:rgba(91,157,255,.15)}
.md-row.on .md-row-name{font-weight:600}
.md-row-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.md-badge{font-size:9px;padding:1px 4px;border-radius:3px;background:rgba(91,157,255,.2);color:var(--dsh-accent,#5b9dff);flex:none;font-weight:500}
.md-add{width:21px;height:21px;flex:none;display:flex;align-items:center;justify-content:center;border-radius:5px;border:1px solid var(--dsh-border,rgba(255,255,255,.16));background:transparent;color:inherit;cursor:pointer;font-size:12px;line-height:1;padding:0;transition:all .12s}
.md-add:hover{background:rgba(91,157,255,.22);border-color:var(--dsh-accent,#5b9dff)}
.md-add.on{background:var(--dsh-accent,#5b9dff);border-color:var(--dsh-accent,#5b9dff);color:#08131f;font-weight:700}

/* 右列：内容 */
.md-pane{flex:1;overflow-y:auto;padding:14px 16px 20px;min-width:0}
.md-title{font-size:16px;font-weight:650;margin:0 0 3px;letter-spacing:.01em}
.md-meta{font-size:11px;opacity:.55;margin-bottom:12px;font-variant-numeric:tabular-nums}
.md-sec{margin-bottom:13px}
.md-lbl{font-size:10px;letter-spacing:.1em;text-transform:uppercase;opacity:.42;margin-bottom:5px;font-weight:600}
.md-txt{line-height:1.68;font-size:12.5px}
.md-li{line-height:1.65;font-size:12.5px;padding-left:12px;position:relative;margin-bottom:3px}
.md-li:before{content:"";position:absolute;left:2px;top:.68em;width:4px;height:4px;border-radius:50%;background:currentColor;opacity:.35}
.md-emph{border-left:2px solid var(--dsh-accent,#5b9dff);padding:8px 11px;margin-bottom:13px;background:rgba(91,157,255,.06);border-radius:0 6px 6px 0}
.md-emph .md-lbl{color:var(--dsh-accent,#5b9dff);opacity:.8}
.md-tags{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:12px}
.md-tag{font-size:10.5px;padding:2.5px 8px;border-radius:20px;background:rgba(255,255,255,.07);opacity:.8}
.md-actions{display:flex;gap:7px;margin-top:14px;flex-wrap:wrap;padding-top:12px;border-top:1px solid var(--dsh-border,rgba(255,255,255,.08))}
.md-empty{padding:32px 18px;text-align:center;opacity:.45;font-size:12.5px;line-height:1.9}
.md-empty strong{display:block;font-size:13px;opacity:.8;margin-bottom:6px;font-weight:600}
.md-err{margin:8px 12px;padding:8px 11px;border-radius:6px;background:rgba(255,90,90,.11);border-left:2px solid #ff6b6b;color:#ffa8a8;font-size:12px;line-height:1.5}

/* 底部：圆桌栏 */
.md-foot{flex:none;border-top:1px solid var(--dsh-border,rgba(255,255,255,.09));padding:9px 12px;display:flex;flex-direction:column;gap:8px;background:rgba(0,0,0,.1)}
.md-seats{display:flex;flex-wrap:wrap;gap:5px;align-items:center;min-height:22px}
.md-seat{display:inline-flex;align-items:center;gap:3px;font-size:11.5px;padding:3px 4px 3px 9px;border-radius:20px;background:rgba(91,157,255,.17);color:var(--dsh-accent,#5b9dff);font-weight:500}
.md-seat button{border:0;background:transparent;color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:0 3px;opacity:.6;border-radius:50%}
.md-seat button:hover{opacity:1;background:rgba(255,255,255,.12)}
.md-hint{font-size:11.5px;opacity:.4}
.md-bottom{display:flex;gap:7px;align-items:center}
.md-topic{flex:1;min-width:0;padding:7px 10px;border-radius:7px;border:1px solid var(--dsh-border,rgba(255,255,255,.14));background:var(--dsh-input-bg,rgba(255,255,255,.045));color:inherit;font:inherit;font-size:12.5px}
.md-topic:focus{outline:none;border-color:var(--dsh-accent,#5b9dff);background:rgba(91,157,255,.05)}
.md-think{display:flex;align-items:center;gap:5px;font-size:11.5px;padding:5px 9px;border-radius:7px;border:1px solid var(--dsh-border,rgba(255,255,255,.14));cursor:pointer;user-select:none;white-space:nowrap;transition:all .12s}
.md-think.on{background:rgba(91,157,255,.14);border-color:rgba(91,157,255,.5);color:var(--dsh-accent,#5b9dff)}
.md-think input{margin:0;accent-color:#5b9dff}

/* 圆桌结果 */
.md-rt-head{display:flex;align-items:center;gap:9px;margin-bottom:12px}
.md-rt-topic{flex:1;font-size:13.5px;font-weight:600;line-height:1.45}
.md-take{border:1px solid var(--dsh-border,rgba(255,255,255,.11));border-radius:8px;padding:11px 13px;margin-bottom:10px;background:rgba(255,255,255,.02)}
.md-take-h{font-size:13px;font-weight:650;margin-bottom:6px;display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}
.md-take-h em{font-style:normal;font-size:10.5px;font-weight:400;opacity:.5;padding:1.5px 6px;border-radius:10px;background:rgba(255,255,255,.06)}
.md-take-b{font-size:12.5px;line-height:1.75;white-space:pre-wrap}
.md-host{border:1px solid rgba(91,157,255,.32);background:rgba(91,157,255,.07);border-radius:8px;padding:12px 14px;font-size:12.5px;line-height:1.8;white-space:pre-wrap;margin-top:14px}
.md-host-lbl{font-size:10px;letter-spacing:.1em;text-transform:uppercase;font-weight:600;color:var(--dsh-accent,#5b9dff);opacity:.85;margin-bottom:7px}
.md-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:48px 20px;font-size:12.5px;opacity:.65}
.md-spin{width:20px;height:20px;border:2.5px solid rgba(255,255,255,.14);border-top-color:var(--dsh-accent,#5b9dff);border-radius:50%;animation:md-spin .75s linear infinite}
@keyframes md-spin{to{transform:rotate(360deg)}}
.md-loading small{opacity:.55;font-size:11.5px}
.md-caret{display:inline-block;width:2px;height:1em;background:var(--dsh-accent,#5b9dff);vertical-align:-2px;margin-left:2px;animation:md-blink 1s steps(2) infinite}
@keyframes md-blink{0%,50%{opacity:1}50.01%,100%{opacity:0}}
.md-chat{display:flex;flex-direction:column;height:100%;min-height:0}
.md-chat-body{flex:1;overflow-y:auto;padding:14px 16px 20px;min-width:0}
.md-round{margin-bottom:22px;padding-bottom:18px;border-bottom:1px solid var(--dsh-border,rgba(255,255,255,.07))}
.md-round:last-child{border-bottom:0;margin-bottom:0}
.md-q{display:flex;gap:8px;align-items:flex-start;margin-bottom:11px}
.md-q-badge{flex:none;font-size:10px;padding:2px 7px;border-radius:10px;background:rgba(91,157,255,.18);color:var(--dsh-accent,#5b9dff);font-weight:600;margin-top:1px}
.md-q-text{font-size:13.5px;font-weight:600;line-height:1.5}
.md-cats{display:flex;gap:5px;overflow-x:auto;padding:7px 12px;flex:none;border-bottom:1px solid var(--dsh-border,rgba(255,255,255,.07));scrollbar-width:none}
.md-cats::-webkit-scrollbar{display:none}
.md-cat{font-size:11px;padding:3px 9px;border-radius:20px;border:1px solid var(--dsh-border,rgba(255,255,255,.13));background:transparent;color:inherit;cursor:pointer;white-space:nowrap;opacity:.72;transition:all .12s}
.md-cat:hover{opacity:1;background:rgba(255,255,255,.06)}
.md-cat.on{background:rgba(91,157,255,.18);border-color:rgba(91,157,255,.5);color:var(--dsh-accent,#5b9dff);opacity:1;font-weight:600}
.md-cat-n{opacity:.5;margin-left:3px;font-variant-numeric:tabular-nums}
.md-btn-danger{border-color:transparent;background:rgba(255,90,90,.13);color:#ff9a9a}
.md-btn-danger:hover:not(:disabled){background:rgba(255,90,90,.22)}
.md-btn-danger-armed{background:#d94a4a;color:#fff;font-weight:600}
.md-ghost-row{opacity:.55}
.md-ghost-row .md-row-name{text-decoration:line-through}
.md-streaming{opacity:.85}
.md-pending{display:inline-flex;gap:4px;align-items:center;font-size:11.5px;opacity:.5;padding:2px 0}
.md-dots{display:inline-flex;gap:2px}
.md-dots i{width:3px;height:3px;border-radius:50%;background:currentColor;animation:md-bob 1.1s infinite}
.md-dots i:nth-child(2){animation-delay:.15s}
.md-dots i:nth-child(3){animation-delay:.3s}
@keyframes md-bob{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-2px)}}
`;

  /** 元素构造：把可变参数折成 props.children 并丢掉空值。 */
  let hFn = null;
  function el(type, props, ...children) {
    const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false);
    const merged = { ...(props || {}) };
    if (flat.length > 0) merged.children = flat.length === 1 ? flat[0] : flat;
    return hFn(type, merged);
  }

  window.__ModuleLoader__.load({
    id: PLUGIN_ID,
    factory: (require) => {
      const module = { exports: {} };

      let React;
      try {
        React = require('react');
        hFn = require('react/jsx-runtime').jsx;
      } catch (error) {
        console.warn(`[${PLUGIN_ID}] React 不可用：${String(error)}`);
        module.exports = { name: PLUGIN_ID, inject: ['slots'], apply() {} };
        return module.exports;
      }

      const { useState, useEffect, useCallback, useMemo } = React;

      function ensureCss() {
        if (typeof document === 'undefined') return () => {};
        if (document.getElementById(CSS_ID)) return () => {};
        const style = document.createElement('style');
        style.id = CSS_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }

      async function fetchLibrary(signal) {
        const response = await fetch(`${BASE}/library`, { cache: 'no-store', signal });
        if (!response.ok) throw new Error(`库接口 ${response.status}`);
        return response.json();
      }

      async function fetchExport(slug) {
        const response = await fetch(`${BASE}/export/${encodeURIComponent(slug)}`, {
          cache: 'no-store',
        });
        return response.json();
      }

      /** 删掉一位大师（内置也行，靠服务端墓碑挡住）。 */
      async function removeMaster(slug) {
        const response = await fetch(`${BASE}/master/${encodeURIComponent(slug)}`, { method: 'DELETE' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error ?? `删除失败 ${response.status}`);
        return data;
      }

      /** 把一位大师放回目录。 */
      async function restoreMaster(slug) {
        const response = await fetch(`${BASE}/master/${encodeURIComponent(slug)}/restore`, { method: 'POST' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error ?? `恢复失败 ${response.status}`);
        return data;
      }

      /**
       * 流式开圆桌：POST + SSE，逐段回调。
       *
       * 用 fetch 而不是 EventSource：EventSource 只支持 GET，带不了议题和座位。
       * 分帧按空行切，不假设一个 chunk 里恰好是完整事件。
       */
      async function streamRoundtable(payload, onEvent, signal) {
        const response = await fetch(`${BASE}/stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal,
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data?.error ?? `圆桌接口 ${response.status}`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut;
          while ((cut = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              try {
                onEvent(JSON.parse(line.slice(6)));
              } catch {
                // 半截帧或非 JSON 一律跳过，不能因为一条坏消息毁掉整场流。
              }
            }
          }
        }
      }

      const Section = ({ label, text }) =>
        !text ? null : el('div', { className: 'md-sec' }, el('div', { className: 'md-lbl' }, label), el('div', { className: 'md-txt' }, text));

      const ListSection = ({ label, items }) =>
        !items || items.length === 0
          ? null
          : el(
              'div',
              { className: 'md-sec' },
              el('div', { className: 'md-lbl' }, label),
              ...items.map((item, index) => el('div', { className: 'md-li', key: index }, item)),
            );

      const EmphSection = ({ label, text }) =>
        !text ? null : el('div', { className: 'md-emph' }, el('div', { className: 'md-lbl' }, label), el('div', { className: 'md-txt' }, text));

      function MasterDetail({ master, seated, onToggleSeat, onCopy, copied, onDelete, armedDelete }) {
        if (!master) {
          return el(
            'div',
            { className: 'md-empty' },
            el('strong', null, '左边点一位大师'),
            el('div', null, '看他的思维模型、口吻、以及他做不到什么'),
            el('div', null, '点 ＋ 把人请上桌，可以请 1–6 位'),
            el('div', { style: { marginTop: '10px', opacity: 0.75 } }, '想造新的人？在会话里说「把某某蒸馏成大师」'),
          );
        }
        return el(
          'div',
          null,
          el(
            'div',
            { style: { display: 'flex', alignItems: 'flex-start', gap: '8px' } },
            el('div', { className: 'md-title', style: { flex: 1, minWidth: 0 } }, master.name),
            el(
              'button',
              {
                className: `md-btn md-btn-danger${armedDelete === master.slug ? ' md-btn-danger-armed' : ''}`,
                style: { flex: 'none', marginTop: '1px', fontSize: '11.5px', padding: '4px 9px' },
                title: '删掉后可在「已删」里恢复',
                onClick: () => onDelete(master),
              },
              armedDelete === master.slug ? '确认删除？' : '删除',
            ),
          ),
          el(
            'div',
            { className: 'md-meta' },
            `${master.thinkingModel} · ${master.origin === 'distilled' ? '自铸' : '内置'} · ${master.slug}`,
          ),
          el(
            'div',
            { className: 'md-tags' },
            ...(master.categories || []).map((c) => el('span', { className: 'md-tag', key: c }, c)),
          ),
          el(Section, { label: '他怎么看这个世界', text: master.summary }),
          el(Section, { label: '怎么说话', text: master.voice }),
          el(ListSection, { label: '补充心智模型', items: master.models }),
          el(ListSection, { label: '可执行的启发式', items: master.heuristics }),
          el(ListSection, { label: '他明确不做', items: master.antiPatterns }),
          el(EmphSection, { label: '内在张力', text: master.tension }),
          el(EmphSection, { label: '诚实边界', text: master.boundary }),
          el(ListSection, { label: '专长领域', items: master.consultationDomains }),
          el(
            'div',
            { className: 'md-actions' },
            el(
              'button',
              { className: `md-btn${seated ? '' : ' md-btn-primary'}`, onClick: () => onToggleSeat(master) },
              seated ? '移出圆桌' : '加入圆桌',
            ),
            el(
              'button',
              { className: 'md-btn', onClick: () => onCopy(master) },
              copied === master.slug ? '已复制' : '复制 JSON',
            ),
          ),
          // 常驻说明：这代表一种思维方式，不是本人。
          el(
            'div',
            { style: { marginTop: '12px', fontSize: '11px', lineHeight: '1.6', opacity: 0.42 } },
            '这张卡代表一种思维方式，不代表大师本人。由模型根据公开材料蒸馏生成，可能出错。',
          ),
        );
      }

      /** 一个正在流式输出的人：先占位，再逐字补。 */
      const TakeStream = ({ take, text, pending }) =>
        el(
          'div',
          { className: `md-take${pending ? ' md-streaming' : ''}` },
          el('div', { className: 'md-take-h' }, take.name, el('em', null, take.thinkingModel)),
          el(
            'div',
            { className: 'md-take-b' },
            text ? text : null,
            pending ? el('span', { className: 'md-pending' }, el('span', { className: 'md-dots' }, el('i'), el('i'), el('i'))) : null,
            pending && text ? el('span', { className: 'md-caret' }) : null,
          ),
        );

      /** 多轮对话视图：每轮一问、多人发言、主持人收敛。 */
      function ChatView({ rounds, live, hostLive, thinkingEffort, onBack, busy }) {
        return el(
          'div',
          { className: 'md-chat' },
          el(
            'div',
            { className: 'md-rt-head' },
            el('button', { className: 'md-btn md-btn-ghost', onClick: onBack, disabled: busy }, '← 换一批人'),
            el('div', { className: 'md-rt-topic' }, rounds[0]?.question ?? '圆桌'),
            el('span', { className: 'md-hint' }, thinkingEffort === 'off' ? '快速' : '深思'),
          ),
          el(
            'div',
            { className: 'md-chat-body' },
            ...rounds.map((round, index) =>
              el(
                'div',
                { className: 'md-round', key: `r${index}` },
                index > 0
                  ? el(
                      'div',
                      { className: 'md-q' },
                      el('span', { className: 'md-q-badge' }, '追问'),
                      el('span', { className: 'md-q-text' }, round.question),
                    )
                  : null,
                ...(round.takes ?? []).map((take) =>
                  el(
                    'div',
                    { className: 'md-take', key: take.slug },
                    el('div', { className: 'md-take-h' }, take.name, el('em', null, take.thinkingModel)),
                    el('div', { className: 'md-take-b' }, take.take || `（没说话）`),
                  ),
                ),
                round.host
                  ? el(
                      'div',
                      { className: 'md-host' },
                      el('div', { className: 'md-host-lbl' }, '主持人收敛'),
                      round.host,
                    )
                  : null,
              ),
            ),
            // 正在说的这一轮
            live
              ? el(
                  'div',
                  { className: 'md-round' },
                  el(
                    'div',
                    { className: 'md-q' },
                    el('span', { className: 'md-q-badge' }, rounds.length > 0 ? '追问' : '议题'),
                    el('span', { className: 'md-q-text' }, live.question),
                  ),
                  ...(live.seats ?? []).map((take) =>
                    el(TakeStream, {
                      key: take.slug,
                      take,
                      text: live.texts?.[take.slug] ?? '',
                      pending: !live.done?.[take.slug],
                    }),
                  ),
                  hostLive !== null
                    ? el(
                        'div',
                        { className: 'md-host' },
                        el('div', { className: 'md-host-lbl' }, '主持人收敛'),
                        hostLive || el('span', { className: 'md-pending' }, el('span', { className: 'md-dots' }, el('i'), el('i'), el('i'))),
                        hostLive ? el('span', { className: 'md-caret' }) : null,
                      )
                    : null,
                )
              : null,
          ),
        );
      }

      function Panel() {
        const [library, setLibrary] = useState(null);
        const [error, setError] = useState('');
        const [selected, setSelected] = useState('');
        const [query, setQuery] = useState('');
        const [copied, setCopied] = useState('');
        const [seats, setSeats] = useState([]);
        const [topic, setTopic] = useState('');
        const [thinking, setThinking] = useState(true);
        const [view, setView] = useState('browse');
        const [rounds, setRounds] = useState([]);
        const [sessionId, setSessionId] = useState(null);
        const [live, setLive] = useState(null);
        const [hostLive, setHostLive] = useState(null);
        const [effort, setEffort] = useState('high');
        const [busy, setBusy] = useState(false);
        // 分类筛选：'' 表示全部。
        const [category, setCategory] = useState('');
        // 删除确认：第一次点变成「确认删除」，再点才真的删。
        const [armedDelete, setArmedDelete] = useState('');
        // 已删视图
        const [ghostView, setGhostView] = useState(false);

        const load = useCallback(async (signal) => {
          try {
            setError('');
            const data = await fetchLibrary(signal);
            setLibrary(data);
            setSelected((current) => current || data.masters[0]?.slug || '');
          } catch (err) {
            if (err?.name === 'AbortError') return;
            setError(String(err?.message ?? err));
          }
        }, []);

        useEffect(() => {
          const controller = new AbortController();
          load(controller.signal);
          return () => controller.abort();
        }, [load]);

        const filtered = useMemo(() => {
          if (!library) return [];
          const q = query.trim().toLowerCase();
          // 已删视图完全不看分类和搜索，它要回答的是「我删了什么」。
          if (ghostView) {
            return (library.deleted ?? []).map((slug) => ({ slug, name: slug, ghost: true }));
          }
          let list = library.masters;
          if (category) list = list.filter((m) => (m.categories ?? []).includes(category));
          if (q) {
            list = list.filter(
              (m) =>
                m.name.toLowerCase().includes(q) ||
                m.slug.includes(q) ||
                m.thinkingModel.toLowerCase().includes(q) ||
                (m.tags || []).some((t) => t.toLowerCase().includes(q)),
            );
          }
          return list;
        }, [library, query, category, ghostView]);

        const current = library?.masters.find((m) => m.slug === selected) ?? null;
        const seatedMasters = seats.map((slug) => library?.masters.find((m) => m.slug === slug)).filter(Boolean);

        const toggleSeat = useCallback((master) => {
          setSeats((prev) => {
            if (prev.includes(master.slug)) return prev.filter((s) => s !== master.slug);
            if (prev.length >= MAX_SEATS) return [...prev.slice(1), master.slug];
            return [...prev, master.slug];
          });
        }, []);

        const handleCopy = useCallback(async (master) => {
          try {
            const data = await fetchExport(master.slug);
            await navigator.clipboard.writeText(JSON.stringify(data.master ?? data, null, 2));
            setCopied(master.slug);
            setTimeout(() => setCopied(''), 1600);
          } catch (err) {
            setError(`导出失败：${String(err?.message ?? err)}`);
          }
        }, []);

        /** 删除：第一次点只武装，第二次才真删。 */
        const handleDelete = useCallback(
          async (master) => {
            if (!master) return;
            if (armedDelete !== master.slug) {
              setArmedDelete(master.slug);
              return;
            }
            setArmedDelete('');
            try {
              await removeMaster(master.slug);
              setSeats((prev) => prev.filter((s) => s !== master.slug));
              await load();
            } catch (err) {
              setError(`删除失败：${String(err?.message ?? err)}`);
            }
          },
          [armedDelete, load],
        );

        const handleRestore = useCallback(
          async (slug) => {
            try {
              await restoreMaster(slug);
              await load();
            } catch (err) {
              setError(`恢复失败：${String(err?.message ?? err)}`);
            }
          },
          [load],
        );

        /** 开一轮（首问或追问共用一条流）。 */
        const runStream = useCallback(
          async (payload) => {
            setBusy(true);
            setError('');
            setHostLive(null);
            setLive({ question: payload.question, seats: [], texts: {}, done: {} });
            setView('chat');
            try {
              await streamRoundtable(payload, (event) => {
                switch (event.type) {
                  case 'session':
                    setSessionId(event.sessionId);
                    break;
                  case 'thinking':
                    setEffort(event.effort ?? 'high');
                    break;
                  case 'seats':
                    setLive((prev) =>
                      prev ? { ...prev, seats: event.masters.map((m) => ({ ...m })) } : prev,
                    );
                    break;
                  case 'take-start':
                    setLive((prev) => (prev ? { ...prev, texts: { ...prev.texts, [event.slug]: '' } } : prev));
                    break;
                  case 'take-delta':
                    setLive((prev) =>
                      prev
                        ? { ...prev, texts: { ...prev.texts, [event.slug]: (prev.texts[event.slug] ?? '') + event.text } }
                        : prev,
                    );
                    break;
                  case 'take-end':
                    setLive((prev) =>
                      prev ? { ...prev, done: { ...prev.done, [event.slug]: true } } : prev,
                    );
                    break;
                  case 'host-start':
                    setHostLive('');
                    break;
                  case 'host-delta':
                    setHostLive((prev) => (prev ?? '') + event.text);
                    break;
                  case 'turn':
                    setRounds((prev) => [...prev, event.turn]);
                    setLive(null);
                    setHostLive(null);
                    break;
                  case 'error':
                    setError(event.error ?? '未知错误');
                    setLive(null);
                    break;
                  default:
                    break;
                }
              });
            } catch (err) {
              if (err?.name !== 'AbortError') setError(`开桌失败：${String(err?.message ?? err)}`);
              setLive(null);
            } finally {
              setBusy(false);
              setLive(null);
            }
          },
          [],
        );

        const startRoundtable = useCallback(() => {
          if (seats.length < MIN_SEATS || !topic.trim() || busy) return;
          setRounds([]);
          runStream({
            question: topic.trim(),
            masters: seats,
            thinking: thinking ? 'high' : 'off',
          });
        }, [seats, topic, thinking, busy, runStream]);

        const followUp = useCallback(() => {
          if (!topic.trim() || busy || !sessionId) return;
          const question = topic.trim();
          setTopic('');
          runStream({ question, sessionId, thinking: thinking ? 'high' : 'off' });
        }, [topic, thinking, busy, sessionId, runStream]);

        if (!library && !error) {
          return el('div', { className: 'md-empty' }, el('strong', null, '读取大师库…'));
        }

        const inChat = view === 'chat';

        return el(
          'div',
          { className: 'md-root' },
          el(
            'div',
            { className: 'md-top' },
            inChat
              ? el('div', { className: 'md-search', style: { border: 0, background: 'transparent', paddingLeft: 0, opacity: 0.6 } }, inChat ? '圆桌进行中' : '')
              : el('input', {
                  className: 'md-search',
                  placeholder: '搜大师 / 思维模型 / 标签',
                  value: query,
                  onChange: (e) => setQuery(e.target.value),
                }),
            !inChat && library ? el('span', { className: 'md-count' }, `${filtered.length}/${library.counts.total}`) : null,
            el('button', { className: 'md-btn md-btn-ghost', onClick: () => load() }, '刷新'),
          ),
          error ? el('div', { className: 'md-err' }, error) : null,
          // 分类筛选条：11 个分类 + 全部 + 已删
          inChat
            ? null
            : el(
                'div',
                { className: 'md-cats' },
                el(
                  'button',
                  {
                    className: `md-cat${!category && !ghostView ? ' on' : ''}`,
                    onClick: () => {
                      setCategory('');
                      setGhostView(false);
                    },
                  },
                  '全部',
                  el('span', { className: 'md-cat-n' }, library?.counts.total ?? ''),
                ),
                ...(library?.categories ?? []).map((c) =>
                  el(
                    'button',
                    {
                      key: c.slug,
                      className: `md-cat${category === c.slug && !ghostView ? ' on' : ''}`,
                      title: c.coreQuestion ?? '',
                      onClick: () => {
                        setCategory(category === c.slug ? '' : c.slug);
                        setGhostView(false);
                      },
                    },
                    c.name,
                    el('span', { className: 'md-cat-n' }, c.count ?? ''),
                  ),
                ),
                (library?.deleted ?? []).length > 0
                  ? el(
                      'button',
                      {
                        className: `md-cat${ghostView ? ' on' : ''}`,
                        style: { marginLeft: 'auto', opacity: ghostView ? 1 : 0.55 },
                        onClick: () => setGhostView(!ghostView),
                      },
                      '已删 ',
                      el('span', { className: 'md-cat-n' }, library.deleted.length),
                    )
                  : null,
              ),
          el(
            'div',
            { className: 'md-main' },
            inChat
              ? el(
                  'div',
                  { style: { flex: 1, minWidth: 0, display: 'flex' } },
                  el(ChatView, {
                    rounds,
                    live,
                    hostLive,
                    thinkingEffort: effort,
                    busy,
                    onBack: () => {
                      setView('browse');
                      setRounds([]);
                      setSessionId(null);
                      setLive(null);
                      setHostLive(null);
                    },
                  }),
                )
              : [
                  el(
                    'div',
                    { className: 'md-list', key: 'list' },
                    el(
                      'div',
                      { className: 'md-rows' },
                      ...(filtered.length === 0
                        ? [
                            el(
                              'div',
                              { className: 'md-empty', key: '__none', style: { padding: '22px 12px' } },
                              ghostView ? '没有被删掉的人' : '这个分类下暂时没有人',
                            ),
                          ]
                        : filtered.map((m) =>
                            m.ghost
                              ? el(
                                  'div',
                                  { key: m.slug, className: 'md-row md-ghost-row' },
                                  el('span', { className: 'md-row-name' }, m.slug),
                                  el(
                                    'button',
                                    {
                                      className: 'md-add',
                                      title: '恢复',
                                      onClick: (e) => {
                                        e.stopPropagation();
                                        handleRestore(m.slug);
                                      },
                                    },
                                    '↺',
                                  ),
                                )
                              : el(
                                  'div',
                                  {
                                    key: m.slug,
                                    className: `md-row${m.slug === selected ? ' on' : ''}`,
                                    onClick: () => setSelected(m.slug),
                                  },
                                  el('span', { className: 'md-row-name' }, m.name),
                                  m.origin === 'distilled' ? el('span', { className: 'md-badge' }, '铸') : null,
                                  el(
                                    'button',
                                    {
                                      className: `md-add${seats.includes(m.slug) ? ' on' : ''}`,
                                      title: seats.includes(m.slug) ? '移出圆桌' : '加入圆桌',
                                      onClick: (e) => {
                                        e.stopPropagation();
                                        toggleSeat(m);
                                      },
                                    },
                                    seats.includes(m.slug) ? '✓' : '＋',
                                  ),
                                ),
                          )),
                    ),
                  ),
                  el(
                    'div',
                    { className: 'md-pane', key: 'pane' },
                    ghostView
                      ? el(
                          'div',
                          { className: 'md-empty' },
                          el('strong', null, '已删掉的大师'),
                          el('div', null, '左边点 ↺ 就能放回来'),
                          el('div', { style: { opacity: 0.7, marginTop: '6px' } }, '删除只是从目录里移走，随包的原始文件不动'),
                        )
                      : el(MasterDetail, {
                          master: current,
                          seated: seats.includes(current?.slug),
                          onToggleSeat: toggleSeat,
                          onCopy: handleCopy,
                          copied,
                          onDelete: handleDelete,
                          armedDelete,
                        }),
                  ),
                ],
          ),
          el(
            'div',
            { className: 'md-foot' },
            inChat
              ? null
              : el(
                  'div',
                  { className: 'md-seats' },
                  seats.length === 0
                    ? el('span', { className: 'md-hint' }, '点名单右侧的 ＋ 请人上桌，1–6 位都行')
                    : [
                        ...seatedMasters.map((m) =>
                          el(
                            'span',
                            { className: 'md-seat', key: m.slug },
                            m.name,
                            el('button', { title: '移出', onClick: () => setSeats((prev) => prev.filter((s) => s !== m.slug)) }, '×'),
                          ),
                        ),
                        el('span', { className: 'md-hint', key: '__n' }, `${seats.length}/${MAX_SEATS}`),
                      ],
                ),
            el(
              'div',
              { className: 'md-bottom' },
              el('input', {
                className: 'md-topic',
                placeholder: inChat ? '接着追问…' : '你要决定什么？',
                value: topic,
                onChange: (e) => setTopic(e.target.value),
                onKeyDown: (e) => {
                  if (e.key !== 'Enter') return;
                  inChat ? followUp() : startRoundtable();
                },
              }),
              el(
                'label',
                { className: `md-think${thinking ? ' on' : ''}`, title: thinking ? '深思已开启' : '深思已关闭' },
                el('input', { type: 'checkbox', checked: thinking, onChange: (e) => setThinking(e.target.checked) }),
                '深思',
              ),
              inChat
                ? el(
                    'button',
                    { className: 'md-btn md-btn-primary', disabled: !topic.trim() || busy, onClick: followUp },
                    busy ? '…' : '追问',
                  )
                : el(
                    'button',
                    {
                      className: 'md-btn md-btn-primary',
                      disabled: seats.length < MIN_SEATS || !topic.trim() || busy,
                      onClick: startRoundtable,
                    },
                    busy ? '开桌中…' : '开桌',
                  ),
            ),
          ),
        );
      }

      /** 左侧图标栏的按钮。owner props 只有 { size, active }。 */
      function PanelIcon(props) {
        const size = props?.size ?? 20;
        const active = props?.active === true;
        return hFn('svg', {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          style: { opacity: active ? 1 : 0.72 },
          children: [
            hFn('path', { key: 'flask', d: 'M9.5 3h5M10.5 3v5.2L6.3 16.4A3 3 0 0 0 9 20.8h6a3 3 0 0 0 2.7-4.4L13.5 8.2V3' }),
            hFn('path', { key: 'line', d: 'M7.8 14.6h8.4' }),
          ],
        });
      }

      const inject = ['slots'];
      function apply(ctx) {
        ctx.effect(ensureCss, `${PLUGIN_ID}: style`);

        // 右侧栏：两阶段注册（先登记标签类型，再用它的 id 提供正文）。
        const tabs = ctx.get?.('sidebarRightTabs');
        if (!tabs || typeof tabs.register !== 'function') {
          console.warn(`[${PLUGIN_ID}] 没有 sidebarRightTabs 服务，右侧栏入口未注册`);
        } else {
          ctx.effect(() => {
            const disposeType = tabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              priority: 'extension',
              title: () => '明辨',
              guide: [
                {
                  id: TAB_KIND,
                  order: 380,
                  title: () => '明辨',
                  description: () => '与大师同桌，明辨当下',
                },
              ],
            });
            ctx.slots.inject('sidebar.right.pane.tab', function* () {
              yield ctx.slots.register(
                { name: 'sidebar.right.pane.tab', key: TAB_ID, order: 90 },
                () => hFn(Panel, {}),
              );
            });
            return disposeType;
          }, `${PLUGIN_ID}: right sidebar tab`);
        }

        // 左侧图标栏 + 中央主面板：list 语义认 id，keyed 语义认 key。
        try {
          ctx.slots.inject('sidebar.panellist', function* () {
            yield ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: () => '明辨' },
              () => hFn(PanelIcon, {}),
            );
          });
          ctx.slots.inject('main', function* () {
            yield ctx.slots.register({ name: 'main', key: PANEL_ID }, () => hFn(Panel, {}));
          });
        } catch (error) {
          console.warn(`[${PLUGIN_ID}] 左侧面板注册失败：${String(error)}`);
        }
      }

      module.exports = { name: PLUGIN_ID, inject, apply };
      return module.exports;
    },
  });
})();
