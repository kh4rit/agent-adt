// SAP GUI for HTML (Web GUI) driver for a Chromium browser with remote debugging (CDP, default port 9222),
// modelled on SAP GUI scripting. Setup and examples: README.md next to this file.
// Fields are addressed by the scripting IDs (SIDs) Web GUI puts in the DOM, not by pixels.
//
// Usage: node sapgui.mjs <command> [args...]        (one command)
//        node sapgui.mjs run <file|->                (one command per line, '#' comments; stops on error)
//
// Commands
//   spro "<activity>" [tree=<IMG area>] [n=<hit>]   execute an IMG activity via SPRO (Find -> hit -> execute)
//   sm30 <view> [show]        open maintenance view directly (SM30, change mode unless 'show'; fallback)
//   sm34 <cluster> [show]     open view cluster directly (SM34)
//   tx <tcode> [k=v;...]      start any transaction (/n<tcode>), optional *-parameters
//   cache [IMG area]          dump an IMG area (default 'SCM Extended Warehouse Management') to img-tree.json (paths + objects)
//   img <text|activity>       find IMG activities: id, text, maintenance object, SPRO path (read-only, SQL)
//   sql <select>              ADT data preview, client from SAP_CLIENT (default 100), max 200 rows
//   state                     title, status bar, popup, editable fields, visible table rows, buttons
//   rows                      visible table control rows (field=value)
//   set F=V [F=V ...]         set fields; F = field name (LGTYP), name[row] for table cells, or full SID
//   press <n|label>           press toolbar button by function key number (11=Save, 3=Back) or label
//   key <Enter|F1..F12|...>   send a key to the active window
//   okcode <code>             enter an OK code (e.g. POSI, /n) + Enter
//   position F=V ...          SM30 'Position...' to a key
//   select <row> | selectkey F=V ...   mark a table row (row index on screen, or by key values)
//   save <TRKORR>             Save; fills/validates the request prompt with TRKORR; fails if SAP proposes another
//   leave                     leave the transaction (/n), releasing locks; reports unsaved-data popups
//   shot <file.png>           screenshot
//   wait                      wait until Web GUI is idle
// Env: CDP_PORT (9222), SAPGUI_TAB (url substring, default 'webgui'), SAP_HOST, SAP_CLIENT, SAP_LANG - or sapgui.config.json
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const CACHE = new URL('./img-tree.json', import.meta.url);
const loadCache = () => existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : null;

const PORT = process.env.CDP_PORT || 9222;
const TAB = process.env.SAPGUI_TAB || 'webgui';
// system settings: env vars, else sapgui.config.json next to this file ({ "host": "https://…", "client": "100", "lang": "EN" })
const CONF_FILE = new URL('./sapgui.config.json', import.meta.url);
const CONF = existsSync(CONF_FILE) ? JSON.parse(readFileSync(CONF_FILE, 'utf8')) : {};
const HOST = process.env.SAP_HOST || CONF.host;
const CLIENT = process.env.SAP_CLIENT || CONF.client || '100';
const LANG = process.env.SAP_LANG || CONF.lang || 'EN';
if (!HOST) throw new Error('set SAP_HOST or create sapgui.config.json with {"host": "https://<webgui host>", "client": "<client>"}');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- CDP session ----------
const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page');
const target = pages.find(t => t.url.includes(TAB)) || pages.find(t => t.url.startsWith(HOST));
if (!target) throw new Error(`no tab matching '${TAB}' or ${HOST}; open Web GUI first (sapgui.mjs needs a logged-on tab)`);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0; const pending = new Map(); let inflight = 0; let lastNet = Date.now();
const rt = { started: 0, finished: 0, ids: new Set() };   // Web GUI server roundtrips (batch/json XHRs)
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') { inflight++; lastNet = Date.now();
    if (/\/webgui\/batch\/json|\/its\/webgui[^/]*$/.test(m.params.request.url) && m.params.type === 'XHR') { rt.started++; rt.ids.add(m.params.requestId); } }
  if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') { inflight = Math.max(0, inflight - 1); lastNet = Date.now();
    if (rt.ids.delete(m.params.requestId)) rt.finished++; }
};
const send = (method, params = {}) => new Promise(res => { const i = ++msgId; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Network.enable');
const evaluate = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};

// ---------- in-page helpers ----------
const PAGE = String.raw`(() => {
  const sidOf = e => { const m = (e.getAttribute('lsdata') || '').match(/SID\\?"?:\\?"([^"\\]+)/); return m && m[1]; };
  const vis = e => !!(e && (e.offsetParent || e.getClientRects().length));
  const all = () => { const out = []; for (const e of document.querySelectorAll('[lsdata]')) { const s = sidOf(e); if (s && vis(e)) out.push([s, e]); } return out; };
  const wins = () => [...new Set(all().map(([s]) => s.match(/^wnd\[(\d+)\]/)?.[1]).filter(Boolean))].map(Number).sort();
  const top = () => Math.max(0, ...wins());
  const input = e => e.matches('input,textarea,select') ? e : (e.querySelector('input,textarea') || e);
  const fieldName = s => { const m = s.match(/^.*\/(?:txt|ctxt|chk|rad|cmb|pwd|lbl)(.+?)(\[\d+(?:,\d+)?\])?$/); if (!m) return null; const f = m[1]; return f.includes('-') ? f.slice(f.lastIndexOf('-') + 1) : f.replace(/^.*\//, ''); };
  const rowOf = s => { const m = s.match(/\[(\d+),(\d+)\]$/); return m ? +m[2] : null; };
  const val = e => { const i = input(e); if (i.type === 'checkbox' || e.getAttribute('ct') === 'C' || /\/chk/.test(sidOf(e) || '')) return (i.checked || e.getAttribute('aria-checked') === 'true' || /urCbgChecked|lsCheckBox--checked/.test(e.className + ' ' + (e.querySelector('[class*=hecked]')?.className || ''))) ? 'X' : '';
    return (i.value ?? i.textContent ?? '').trim(); };
  const editable = e => { const i = input(e); return !(i.readOnly || i.disabled || i.getAttribute('aria-readonly') === 'true' || i.getAttribute('aria-disabled') === 'true'); };
  const label = e => { const i = input(e); const ids = (i.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    const t = ids.map(id => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' '); return t || i.title || ''; };
  // match: full SID, or 'NAME', 'NAME[row]', optionally prefixed 'wnd[n]/'
  const find = (spec, w = top()) => {
    const list = all();
    if (spec.startsWith('wnd[')) { const hit = list.find(([s]) => s === spec) || list.find(([s]) => s.endsWith(spec.replace(/^wnd\[\d+\]/, '')) && s.startsWith(spec.slice(0, 6)));
      if (hit) return hit; }
    const m = spec.match(/^([^\[]+)(?:\[(\d+)\])?$/); if (!m) return null;
    const [, name, row] = m; const N = name.toUpperCase();
    const cands = list.filter(([s, e]) => s.startsWith('wnd[' + w + ']') && fieldName(s) === N && (row == null || rowOf(s) === +row));
    return cands.find(([, e]) => e.matches('input,textarea')) || cands.find(([, e]) => e.querySelector?.('input,textarea')) || cands[0] || null;
  };
  const rect = e => { e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; };
  const status = () => { const el = document.getElementById('wnd[0]/sbar_msg'); if (!el || /invisible/.test(el.className)) return { type: '', text: '' };
    const d = (el.getAttribute('lsdata') || '').match(/messageType\\?"?:\\?"(\w?)/); const t = el.textContent.replace(/\s+/g, ' ').trim();
    return { type: (d && d[1]) || (/^Error/.test(t) ? 'E' : 'S'), text: t.replace(/^(Success|Error|Warning|Information):?\s*/, '').replace(/\s*View Details$/, '').trim() }; };
  const buttons = w => all().filter(([s]) => s.startsWith('wnd[' + w + ']') && /\/(btn|tbar\[\d\]\/btn)\[\d+\]$|\/btn[^/]*$/.test(s))
    .map(([s, e]) => ({ sid: s, n: (s.match(/btn\[(\d+)\]$/) || s.match(/\/btn([A-Z0-9_%]+)$/) || [])[1], label: (e.textContent.trim() || e.title || '').replace(/\s+/g, ' ').slice(0, 40), tip: e.title }))
    .filter(b => b.label || b.tip);
  const btnEl = (key, w = top()) => {
    if (/^\d+$/.test(key)) { const h = all().find(([s]) => s.startsWith('wnd[' + w + ']') && s.endsWith('/btn[' + key + ']')); if (h) return h[1]; }
    if (/^[A-Z0-9_%]+$/.test(key)) { const h = all().find(([s]) => s.startsWith('wnd[' + w + ']') && s.endsWith('/btn' + key)); if (h) return h[1]; }
    const byN = [...document.querySelectorAll('[id*="::btn[' + key + ']"]')].filter(vis).find(e => e.id.startsWith('M' + w + ':'));
    if (/^\d+$/.test(key) && byN) return byN;
    const re = new RegExp('^\\s*' + key.replace(/[.*+?^$\{}()|[\]\\]/g, '\\$&') + '\\s*$', 'i');
    return [...document.querySelectorAll('[ct=B],[role=button],button')].filter(vis).filter(e => !w || e.id.startsWith('M' + w + ':') || e.closest('[id^="M' + w + ':"]'))
      .find(e => re.test(e.textContent.replace(/\s+/g, ' ')) || re.test((e.title || '').replace(/\s*\(.*\)$/, '')));
  };
  const table = (w = top()) => {
    const cells = all().filter(([s]) => s.startsWith('wnd[' + w + ']/usr/tbl') && /\[\d+,\d+\]$/.test(s));
    const rows = new Map();
    for (const [s, e] of cells) { const r = rowOf(s), f = fieldName(s); if (f == null) continue; const o = rows.get(r) || {}; if (!(f in o) || e.matches('input')) o[f] = val(e); rows.set(r, o); }
    return [...rows].sort((a, b) => a[0] - b[0]).map(([r, o]) => ({ row: r, ...o })).filter(o => Object.keys(o).some(k => k !== 'row' && o[k] !== ''));
  };
  const state = () => {
    if (/Session Timed Out or Not Found|Session no longer exists/.test(document.body?.innerText?.slice(0, 300) || ''))
      return { window: 0, dialog: null, ended: true, title: 'SESSION ENDED (server closed the Web GUI session; its locks are released) - start again with spro/tx', status: { type: 'E', text: '' }, fields: [], columns: [], rows: [], buttons: [] };
    const w = top();
    const title = document.title;
    const dlg = [...document.querySelectorAll('[role=dialog]')].filter(vis).pop();
    const popupTitle = w > 0 && dlg ? (document.getElementById(dlg.getAttribute('aria-labelledby') || '')?.textContent?.trim() || '') : '';
    const fields = all().filter(([s]) => s.startsWith('wnd[' + w + ']/usr') && !/\/tbl/.test(s) && /\/(txt|ctxt|chk|rad|cmb|pwd)/.test(s))
      .map(([s, e]) => ({ name: fieldName(s), sid: s, value: val(e), edit: editable(e), label: label(e) }));
    const seen = new Set(); const f2 = fields.filter(f => !seen.has(f.sid) && seen.add(f.sid));
    const tbl = all().find(([s]) => s.startsWith('wnd[' + w + ']/usr/tbl') && /\/tbl[^/]*\/[^/]+$/.test(s) === false);
    const cols = all().filter(([s]) => s.startsWith('wnd[' + w + ']/usr/tbl') && /\/col\//.test(s)).map(([s, e]) => s.replace(/^.*\/col\/(.*?-)?/, '') + (e.textContent.trim() ? '(' + e.textContent.trim() + ')' : ''));
    const sdlg = w === 0 ? [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(vis).find(d => !d.querySelector('[lsdata*=SID]')) : null;
    const dialog = sdlg ? { title: document.getElementById(sdlg.getAttribute('aria-labelledby') || '')?.textContent?.trim() || '', text: sdlg.textContent.replace(/\s+/g, ' ').trim().slice(0, 200),
      buttons: [...sdlg.querySelectorAll('[role=button],button,[ct=B]')].filter(vis).map(b => b.textContent.trim()).filter(Boolean) } : null;
    return { window: w, dialog, title: w ? popupTitle || 'popup' : title, status: status(), fields: f2, columns: [...new Set(cols)], rows: table(w), buttons: buttons(w).map(b => (b.n ? b.n + ':' : '') + (b.label || b.tip)) };
  };
  return { all, find, rect, val, editable, input, state, table, status, top, btnEl, sidOf, label, fieldName };
})()`;
const PAGE_V = PAGE.length + ':' + PAGE.slice(-40).replace(/\W/g, '');
const page = fn => evaluate(`(${fn})(window.__sgv === ${JSON.stringify(PAGE_V)} ? window.__sg : (window.__sgv = ${JSON.stringify(PAGE_V)}, window.__sg = ${PAGE}))`);

// ---------- primitives ----------
// idle = no Web GUI request in flight and no DOM mutation for `min` ms
async function waitIdle(min = 200, max = 20000) {
  const t0 = Date.now(); await sleep(50);
  while (Date.now() - t0 < max) {
    const quiet = await evaluate(`(() => { if (!window.__sgMO) { window.__sgMut = Date.now(); window.__sgMO = new MutationObserver(() => window.__sgMut = Date.now());
        window.__sgMO.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); return 0; }
      return document.readyState === 'complete' ? Date.now() - window.__sgMut : 0; })()`).catch(() => 0);
    if (inflight === 0 && Date.now() - lastNet > min && quiet > min) return;
    await sleep(40);
  }
}
// after a user action: wait for the Web GUI roundtrip it triggers (starts ~0.7 s later), then for the DOM to settle
async function afterAction(before, expect = true) {
  const t0 = Date.now();
  if (expect) while (rt.started === before && Date.now() - t0 < 2500) await sleep(25);
  // chained roundtrips (e.g. IMG activity -> maintenance dialog): settle until none started for 250 ms
  let last = rt.started, quietSince = Date.now();
  while (Date.now() - t0 < 30000) {
    if (rt.started !== last || rt.ids.size) { last = rt.started; quietSince = Date.now(); }
    else if (Date.now() - quietSince > 250) break;
    await sleep(25);
  }
  await waitIdle(120);
}
async function clickAt({ x, y }) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}
const KEYS = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Home: 36, End: 35, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };
async function jsClick(fn, what) {   // fn: page function returning the element to click (or null)
  const before = rt.started;
  const ok = await page(`sg => { const e = (${fn})(sg); if (!e) return false; e.scrollIntoView({ block: 'center' }); e.focus?.(); e.click(); return true; }`);
  if (!ok) throw new Error(`not found: ${what}`);
  return before;
}
async function key(spec) {
  const before = rt.started;
  const parts = spec.split('+'); const k = parts.pop();
  const mods = (parts.includes('Alt') ? 1 : 0) | (parts.includes('Ctrl') ? 2 : 0) | (parts.includes('Meta') || parts.includes('Cmd') ? 4 : 0) | (parts.includes('Shift') ? 8 : 0);
  const code = KEYS[k] ?? (/^F\d+$/.test(k) ? 111 + +k.slice(1) : k.toUpperCase().charCodeAt(0));
  for (const type of ['rawKeyDown', 'keyUp'])
    await send('Input.dispatchKeyEvent', { type, key: k, code: /^[a-z]$/i.test(k) ? 'Key' + k.toUpperCase() : k, windowsVirtualKeyCode: code, modifiers: mods });
  if (k === 'Enter') await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', modifiers: mods });
  await afterAction(before, !/^(Tab|Arrow|Home|End|Backspace|Delete)/.test(k));
}
async function focusField(spec) {
  const info = await page(`sg => { const h = sg.find(${JSON.stringify(spec)}); if (!h) return null; const [s, e] = h; const i = sg.input(e);
    const r = sg.rect(i); return { sid: s, r, ct: e.getAttribute('ct') || i.getAttribute('ct'), type: i.type, value: sg.val(e), edit: sg.editable(e), tag: i.tagName }; }`);
  if (!info) throw new Error(`field not found: ${spec}`);
  return info;
}
async function setField(spec, value) {
  const f = await focusField(spec);
  if (!f.edit) throw new Error(`field not editable: ${spec} (${f.sid})`);
  const isChk = /\/chk/.test(f.sid) || f.ct === 'C' || f.type === 'checkbox';
  const S = JSON.stringify(f.sid);
  if (/\/rad/.test(f.sid) || f.ct === 'R' || f.type === 'radio') {   // radio: any non-empty value selects it
    if (value && value !== '-') await jsClick(`sg => { const h = sg.find(${S}); return h && (h[1].querySelector('input,[role=radio]') || h[1]); }`, spec);
    return f.sid; }
  if (isChk) { const want = value && value !== '-' && value !== ' ' ? 'X' : '';
    if (f.value !== want) await jsClick(`sg => { const h = sg.find(${S}); return h && (sg.input(h[1]).matches('input') ? sg.input(h[1]) : h[1]); }`, spec);
    return f.sid; }
  if (/\/cmb/.test(f.sid) || f.ct === 'CB') {               // dropdown: open, then pick the entry whose text or key matches
    await jsClick(`sg => { const h = sg.find(${S}); return h && sg.input(h[1]); }`, spec); await sleep(300);
    const re = JSON.stringify('^\\s*(' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(\\b|$)');
    const before = rt.started;
    const ok = await page(`sg => { const re = new RegExp(${re}, 'i');
      const it = [...document.querySelectorAll('[role=option],[ct=LIB_I],.lsListbox__value')].filter(e => e.offsetParent).find(e => re.test(e.textContent.trim()) || re.test(e.getAttribute('data-itemkey') || ''));
      if (!it) return false; it.click(); return true; }`);
    if (!ok) { await key('Escape'); throw new Error(`no dropdown entry '${value}' in ${spec}`); }
    await afterAction(before, false); return f.sid;
  }
  let now;
  for (let attempt = 0; attempt < 3; attempt++) {
    await afterAction(rt.started, false);   // let type-ahead / re-render of the previous field finish
    // table cells are <span> until activated: click to turn into an <input>, then make sure that input has focus
    const ok = await page(`async sg => { let h = sg.find(${S}); let i = sg.input(h[1]);
      if (i.tagName !== 'INPUT' && i.tagName !== 'TEXTAREA') { i.click(); await new Promise(r => setTimeout(r, 80)); h = sg.find(${S}); i = sg.input(h[1]); }
      if (i.tagName !== 'INPUT' && i.tagName !== 'TEXTAREA') return 'no-input';
      const max = +i.getAttribute('maxlength') || 0; if (max && ${JSON.stringify(value)}.length > max) return 'too-long:' + max;
      i.focus(); i.select?.(); return document.activeElement === i ? 'ok' : 'no-focus'; }`);
    if (/^too-long/.test(ok)) throw new Error(`value '${value}' longer than field ${spec} (max ${ok.split(':')[1]})`);
    if (ok !== 'ok') { await sleep(150); continue; }
    if (value === '') { for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }); }
    else await send('Input.insertText', { text: value });
    await sleep(60);
    now = await page(`sg => { const h = sg.find(${S}); return h && sg.val(h[1]); }`);
    if ((now || '').toUpperCase() === value.toUpperCase()) return f.sid;
  }
  throw new Error(`could not set ${spec}: has '${now}', wanted '${value}'`);
}
async function press(keyOrLabel) {
  if ((await state()).ended) throw new Error('Web GUI session ended - nothing to press; restart with spro/tx');
  const k = JSON.stringify(String(keyOrLabel));
  const found = await page(`sg => !!sg.btnEl(${k})`);
  if (!found) {  // fall back to the function key itself
    const fk = { 0: 'Enter', 3: 'F3', 5: 'F5', 6: 'F6', 2: 'F2', 8: 'F8', 12: 'Escape' }[keyOrLabel];
    if (fk) return key(fk);
    throw new Error(`button not found: ${keyOrLabel}`);
  }
  await afterAction(await jsClick(`sg => sg.btnEl(${k})`, keyOrLabel));
}
async function okcode(code) {
  const r = await page(`sg => { const e = document.getElementById('ToolbarOkCode'); if (!e) return null; e.closest('[style*="display: none"]') ; return sg.rect(e); }`);
  if (r && r.w > 0) { await clickAt(r); await evaluate(`document.getElementById('ToolbarOkCode').value=''`); await send('Input.insertText', { text: code }); await key('Enter'); return; }
  // OK-code field hidden in this theme: set it programmatically and submit with Enter
  await evaluate(`(() => { const e = document.getElementById('ToolbarOkCode'); e.focus(); e.value = ${JSON.stringify(code)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await key('Enter');
}
const state = () => page(`sg => sg.state()`);
const statusMsg = () => page(`sg => sg.status()`);
function fmtState(s, full = false) {
  const out = [`[wnd${s.window}] ${s.title}`];
  if (s.dialog) out.push(`DIALOG ${s.dialog.title}: ${s.dialog.text}  buttons: ${s.dialog.buttons.join(' | ')}  (answer with: dialog <button text>)`);
  if (s.status?.text) out.push(`status ${s.status.type}: ${s.status.text}`);
  const fl = s.fields.filter(f => full || f.value || f.edit);
  if (fl.length) out.push('fields: ' + fl.map(f => `${f.name}${f.edit ? '' : '(ro)'}=${JSON.stringify(f.value)}${f.label && f.label.toUpperCase() !== f.name ? ' «' + f.label + '»' : ''}`).join('  '));
  if (s.columns.length) out.push('columns: ' + s.columns.join(' '));
  for (const r of s.rows.slice(0, full ? 999 : 30)) out.push('  ' + Object.entries(r).filter(([k, v]) => full || v !== '').map(([k, v]) => k === 'row' ? `#${v}` : `${k}=${v}`).join(' '));
  if (s.rows.length > 30 && !full) out.push(`  ... ${s.rows.length - 30} more visible rows`);
  out.push('buttons: ' + s.buttons.join(' | '));
  return out.join('\n');
}
async function gotoTx(tcodeWithParams) {
  const url = `${HOST}/sap/bc/gui/sap/its/webgui?sap-client=${CLIENT}&sap-language=${LANG}&~transaction=${encodeURIComponent(tcodeWithParams)}`;
  const cur = await state().catch(() => null);
  if (cur && /^Change|New Entries|Change View/.test(cur.title || '')) throw new Error(`current screen '${cur.title}' is in change mode: run 'leave' first (keeps locks otherwise)`);
  inflight = 0; rt.ids.clear(); await send('Page.navigate', { url });
  const t0 = Date.now(); await sleep(300);
  while (Date.now() - t0 < 30000) {
    const ok = await evaluate(`!!document.title && !!document.querySelector('[lsdata*="wnd[0]/usr"]') && ![...document.querySelectorAll('[role=dialog]')].some(d => d.offsetParent && /SAP GUI for HTML/.test(d.textContent))`).catch(() => false);
    if (ok) break; await sleep(100);
  }
  await waitIdle(150, 10000);
}

// ---------- ADT data preview (read-only SQL over the same SSO session) ----------
async function sql(query, rows = 200) {
  const expr = `(async () => {
    const tk = window.__sgTok || (window.__sgTok = (await fetch('/sap/bc/adt/discovery', { headers: { 'x-csrf-token': 'fetch' } })).headers.get('x-csrf-token'));
    const r = await fetch('/sap/bc/adt/datapreview/freestyle?rowNumber=${rows}&sap-client=${CLIENT}', { method: 'POST',
      headers: { 'x-csrf-token': tk, 'Content-Type': 'text/plain', Accept: 'application/vnd.sap.adt.datapreview.table.v1+xml' }, body: ${JSON.stringify(query)} });
    if (r.status === 403) window.__sgTok = null;
    const x = new DOMParser().parseFromString(await r.text(), 'text/xml');
    if (r.status !== 200) return { error: (x.getElementsByTagName('message')[0] || x.documentElement).textContent };
    const cols = [...x.getElementsByTagNameNS('*', 'columns')].map(c => ({ n: c.getElementsByTagNameNS('*', 'metadata')[0].getAttribute('dataPreview:name'), d: [...c.getElementsByTagNameNS('*', 'data')].map(e => e.textContent) }));
    const total = x.getElementsByTagNameNS('*', 'totalRows')[0]?.textContent;
    const out = []; for (let i = 0; i < (cols[0]?.d.length || 0); i++) { const o = {}; cols.forEach(c => o[c.n] = c.d[i]); out.push(o); }
    return { total: +total, rows: out };
  })()`;
  const r = await evaluate(expr);
  if (r.error) throw new Error('SQL: ' + r.error);
  return r;
}
const fmtRows = r => r.rows.length ? [Object.keys(r.rows[0]).join(' | '), ...r.rows.map(o => Object.values(o).join(' | ')), `(${r.rows.length} of ${r.total})`].join('\n') : `(0 rows)`;
const q = s => `'${String(s).replace(/'/g, "''")}'`;

const inList = ids => ids.map(q).join(',\n');
async function img(text) {
  const cached = cacheFind(text);
  if (cached?.length) return cached.map(a => ({ ...a, paths: [a.path.join(' › ')], cached: true }));
  const t = text.toUpperCase();
  const acts = (await sql(`SELECT activity, text FROM cus_imgact WHERE spras = 'E' AND ( upper( text ) LIKE ${q('%' + t + '%')}${t.length <= 20 ? ` OR activity = ${q(t)}` : ''} )`, 15)).rows;
  if (!acts.length) return [];
  const ids = acts.map(a => a.ACTIVITY);
  const [ach, refs] = await Promise.all([
    sql(`SELECT activity, c_activity FROM cus_imgach WHERE activity IN (${inList(ids)})`, 50),
    sql(`SELECT node_id, ref_object FROM tnodeimgr WHERE ref_object IN (${inList(ids)})`, 100)]);
  const cact = Object.fromEntries(ach.rows.map(r => [r.ACTIVITY, r.C_ACTIVITY || r.ACTIVITY]));
  const objs = (await sql(`SELECT act_id, objecttype, objectname, tcode FROM cus_actobj WHERE act_id IN (${inList([...new Set(ids.map(i => cact[i] || i))])})`, 100)).rows;
  // walk all node chains upwards in parallel, one query per level; at a sub-tree root follow every REF node pointing to it
  let walkers = refs.rows.map(r => ({ act: r.REF_OBJECT, id: r.NODE_ID, names: [] }));
  const done = [];
  for (let depth = 0; depth < 40 && walkers.length; depth++) {
    const nodes = Object.fromEntries((await sql(`SELECT n~node_id, n~tree_id, n~parent_id, t~text FROM tnodeimg AS n LEFT OUTER JOIN tnodeimgt AS t ON t~node_id = n~node_id AND t~spras = 'E'
      WHERE n~node_id IN (${inList([...new Set(walkers.map(w => w.id))])})`, 500)).rows.map(r => [r.NODE_ID, r]));
    const next = [], roots = [];
    for (const w of walkers) {
      const n = nodes[w.id]; if (!n) { done.push(w); continue; }
      const names = n.TEXT && n.TEXT !== w.names[0] ? [n.TEXT, ...w.names] : w.names;
      if (n.PARENT_ID) next.push({ ...w, id: n.PARENT_ID, names }); else roots.push({ ...w, tree: n.TREE_ID, names });
    }
    if (roots.length) {
      const refRows = (await sql(`SELECT node_id, reftree_id FROM tnodeimg WHERE node_type = 'REF' AND reftree_id IN (${inList([...new Set(roots.map(r => r.tree))])})`, 500)).rows;
      for (const r of roots) {
        const ups = refRows.filter(x => x.REFTREE_ID === r.tree).slice(0, 3);
        if (!ups.length || depth > 30) done.push(r); else for (const u of ups) next.push({ act: r.act, id: u.NODE_ID, names: r.names });
      }
    }
    walkers = next.slice(0, 200);
  }
  done.push(...walkers);
  return acts.map(a => {
    const ps = [...new Set(done.filter(d => d.act === a.ACTIVITY).map(d => d.names.join(' › ')))];
    const ref = ps.filter(p => p.startsWith('SAP Customizing Implementation Guide'));
    return { activity: a.ACTIVITY, text: a.TEXT,
      objects: objs.filter(o => o.ACT_ID === (cact[a.ACTIVITY] || a.ACTIVITY)).map(o => `${o.OBJECTTYPE} ${o.OBJECTNAME} (${o.TCODE || ''})`),
      paths: (ref.length ? ref : ps).sort((x, y) => y.length - x.length).slice(0, 2) };
  });
}

// ---------- local IMG cache: dump one Reference-IMG area (default SCM EWM) with paths and maintenance objects ----------
const chunks = (a, n = 150) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
async function sqlIn(build, ids, rows = 5000) { const out = []; for (const c of chunks([...new Set(ids)])) out.push(...(await sql(build(inList(c)), rows)).rows); return out; }
async function buildCache(area = 'SCM Extended Warehouse Management') {
  const ROOT = 'SAP Customizing Implementation Guide';
  // top node of the area directly under the Reference IMG root
  const cand = (await sql(`SELECT n~node_id, n~parent_id, n~node_type, n~refnode_id FROM tnodeimg AS n INNER JOIN tnodeimgt AS t ON t~node_id = n~node_id
    WHERE t~spras = 'E' AND t~text = ${q(area)}`, 50)).rows;
  const parents = await sqlIn(l => `SELECT n~node_id, t~text FROM tnodeimg AS n INNER JOIN tnodeimgt AS t ON t~node_id = n~node_id WHERE t~spras = 'E' AND n~node_id IN (${l})`, cand.map(c => c.PARENT_ID).filter(Boolean));
  const top = cand.find(c => parents.some(p => p.NODE_ID === c.PARENT_ID && p.TEXT === ROOT)) || cand[0];
  if (!top) throw new Error(`IMG area '${area}' not found`);
  // BFS over display nodes; a REF node shows the children of the node it references
  const acts = []; let level = [{ id: top.NODE_ID, src: top.NODE_TYPE === 'REF' ? top.REFNODE_ID : top.NODE_ID, path: [ROOT, area] }];
  let n = 0;
  while (level.length) {
    const kids = await sqlIn(l => `SELECT n~node_id, n~parent_id, n~node_type, n~refnode_id, t~text FROM tnodeimg AS n LEFT OUTER JOIN tnodeimgt AS t ON t~node_id = n~node_id AND t~spras = 'E' WHERE n~parent_id IN (${l})`, level.map(x => x.src));
    const refTexts = Object.fromEntries((await sqlIn(l => `SELECT node_id, text FROM tnodeimgt WHERE spras = 'E' AND node_id IN (${l})`, kids.filter(k => k.NODE_TYPE === 'REF' && !k.TEXT).map(k => k.REFNODE_ID))).map(r => [r.NODE_ID, r.TEXT]));
    const next = [];
    for (const p of level) for (const k of kids.filter(k => k.PARENT_ID === p.src)) {
      n++;
      const text = k.TEXT || refTexts[k.REFNODE_ID] || '';
      if (k.NODE_TYPE === 'IMG') acts.push({ node: k.NODE_ID, text, path: p.path });
      else next.push({ id: k.NODE_ID, src: k.NODE_TYPE === 'REF' ? k.REFNODE_ID : k.NODE_ID, path: [...p.path, text] });
    }
    level = next;
  }
  const refs = (await sqlIn(l => `SELECT node_id, ref_object, ref_type FROM tnodeimgr WHERE node_id IN (${l})`, acts.map(a => a.node))).filter(r => r.REF_TYPE === 'COBJ' && r.REF_OBJECT.length <= 20);
  const actOf = Object.fromEntries(refs.map(r => [r.NODE_ID, r.REF_OBJECT]));
  const ach = await sqlIn(l => `SELECT activity, c_activity FROM cus_imgach WHERE activity IN (${l})`, refs.map(r => r.REF_OBJECT));
  const cact = Object.fromEntries(ach.map(r => [r.ACTIVITY, r.C_ACTIVITY || r.ACTIVITY]));
  const objs = await sqlIn(l => `SELECT act_id, objecttype, objectname, tcode FROM cus_actobj WHERE act_id IN (${l})`, Object.values(cact));
  const texts = Object.fromEntries((await sqlIn(l => `SELECT activity, text FROM cus_imgact WHERE spras = 'E' AND activity IN (${l})`, refs.map(r => r.REF_OBJECT))).map(r => [r.ACTIVITY, r.TEXT]));
  const out = acts.map(a => { const id = actOf[a.node] || ''; return { activity: id, text: a.text || texts[id] || '', path: a.path,
    objects: objs.filter(o => o.ACT_ID === (cact[id] || id)).map(o => `${o.OBJECTTYPE} ${o.OBJECTNAME} (${o.TCODE || ''})`) }; });
  const cache = loadCache() || { areas: {} };
  cache.areas[area] = { built: new Date().toISOString(), system: HOST, client: CLIENT, nodes: n, activities: out };
  writeFileSync(CACHE, JSON.stringify(cache, null, 1));
  return `cached '${area}': ${n} nodes, ${out.length} IMG activities -> ${fileURLToPath(CACHE)}`;
}
function cacheFind(text, tree) {
  const c = loadCache(); if (!c) return null;
  const T = text.toUpperCase(), A = (tree || '').toUpperCase();
  const all = Object.values(c.areas).flatMap(a => a.activities);
  const hit = a => (a.text.toUpperCase().includes(T) || a.activity === T) && (!A || a.path.join(' › ').toUpperCase().includes(A));
  const exact = all.filter(a => a.text.toUpperCase() === T && (!A || a.path.join(' › ').toUpperCase().includes(A)));
  return exact.length ? exact : all.filter(hit);
}

// ---------- high-level steps ----------
async function save(tr) {
  if (!/^[A-Z0-9]{3}K\d{6}$/.test(tr || '')) throw new Error('save needs a transport request, e.g. save <SID>K900123');
  await press(11);
  for (let i = 0; i < 3; i++) {
    const s = await state();
    if (s.window === 0) {
      if (s.status.type === 'E') throw new Error('save failed: ' + s.status.text);
      return `saved: ${s.status.text || '(no message)'}`;
    }
    const trf = s.fields.find(f => /TRKORR|KORRNUM|REQUEST/i.test(f.name) && f.edit);
    if (!trf) throw new Error(`unexpected popup after save:\n${fmtState(s)}`);
    if (trf.value !== tr) {
      if (trf.value) process.stderr.write(`note: SAP proposed ${trf.value}, replacing with ${tr}\n`);
      await setField(trf.sid, tr);
    }
    await press(0);
    const after = await state();
    if (after.window > 0 && after.title !== s.title) throw new Error(`request ${tr} rejected:\n${fmtState(after)}`);
    if (after.window > 0) { const m = await page(`sg => [...document.querySelectorAll('[id^="M${after.window}:"]')].map(e => e.textContent).join(' ').replace(/\\s+/g,' ').slice(0,300)`); if (/cannot|not valid|nicht/i.test(m)) throw new Error(`request ${tr} rejected: ${m}`); }
  }
  throw new Error('save: transport popup did not close');
}
// leave change mode: Back (F3) until no maintenance screen is shown; stops at the initial screen of SM30/SM34/SPRO.
// Never exits the session itself (that would ask to log off). Leaving the overview releases the enqueue lock.
const MAINT = /^(Change View|Display View|New Entries|Change |Display |Maintain |Copy )|Details of Selected Set|Overview|Dialog Structure/;
async function leave() {
  const seen = [];
  for (let i = 0; i < 6; i++) {
    const s = await state();
    if (s.ended) return `left: session already ended (locks released)`;
    if (s.window > 0 || s.dialog) throw new Error(`leaving asks a question (unsaved data?) — answer it explicitly:\n${fmtState(s)}`);
    seen.push(s.title);
    if (!MAINT.test(s.title) || /Initial Screen|^Display IMG|^Customizing/.test(s.title)) return `left: ${seen.join(' -> ')}`;
    await press(3);
  }
  throw new Error(`could not leave: ${seen.join(' -> ')}`);
}
async function position(pairs) {
  await press('Position...').catch(() => okcode('POSI'));
  const s = await state();
  if (s.window === 0) throw new Error('Position popup did not open (not an SM30 overview?)');
  const slots = s.fields.filter(f => f.edit && f.name !== 'KEYTEXT');
  for (let i = 0; i < pairs.length; i++) {
    const [k, v] = pairs[i];
    const byName = slots.find(f => f.name === k.toUpperCase());
    const keyLabels = s.fields.filter(f => f.name === 'KEYTEXT' || !f.edit).map(f => f.value.replace(/[:.]+$/, '').toUpperCase());
    const byLabel = keyLabels.findIndex(l => l === k.toUpperCase() || l.startsWith(k.toUpperCase()));
    const target = byName || slots[byLabel >= 0 ? byLabel : i];
    if (!target) throw new Error(`position: no slot for ${k} (popup has ${slots.length} key fields)`);
    await setField(target.sid, v);
  }
  await press(0);
  return fmtState(await state());
}
async function selectRow(spec) {
  let row = /^\d+$/.test(spec[0]?.[0] ?? '') ? +spec[0][0] : null;
  if (row == null) {
    const rows = await page(`sg => sg.table()`);
    const hit = rows.find(r => spec.every(([k, v]) => (r[k.toUpperCase()] || '').toUpperCase() === v.toUpperCase()));
    if (!hit) throw new Error(`no visible row with ${spec.map(p => p.join('=')).join(' ')} — position first`);
    row = hit.row;
  }
  const before = await jsClick(`sg => { const any = sg.all().find(([s]) => /\\/usr\\/tbl/.test(s) && new RegExp('\\\\[\\\\d+,${row}\\\\]$').test(s));
    if (!any) return null; const tr = any[1].closest('tr'); const td = tr.querySelector('td'); return td.querySelector('input,span[role=checkbox],div') || td; }`, `row ${row}`);
  await afterAction(before, false);
  return `selected row ${row}`;
}

// execute an IMG activity in SPRO by navigating the tree along its cached path (Find as fallback)
async function treeStep(name, level) {   // expand folder `name` at `level` (root = 0) if collapsed; returns 'ok' | 'missing'
  const before = rt.started;
  const r = await page(`sg => { const rows = [...document.querySelectorAll('tr')].filter(r => r.offsetParent && !r.querySelector('tr'));
    const lv = r => { const m = r.textContent.match(/Level (\\d+) (Expanded|Collapsed)/); return m ? [+m[1], m[2]] : null; };
    const row = rows.find(r => { const l = lv(r); return l && l[0] === ${level} && [...r.querySelectorAll('span')].some(s => s.textContent.trim() === ${JSON.stringify(name)}); });
    if (!row) return 'missing'; row.scrollIntoView({ block: 'start' });
    if (lv(row)[1] === 'Expanded') return 'open';
    const ex = [...row.querySelectorAll('[title="Expand Node"]')][0]; if (!ex) return 'missing'; ex.click(); return 'clicked'; }`);
  if (r === 'clicked') await afterAction(before);
  return r === 'missing' ? 'missing' : 'ok';
}
async function sproFind(text, hit) {   // fallback: Find dialog
  await press(71); await setField('SEARCH_STRING', text); await press(0);
  const s = await state(); if (s.window === 0) throw new Error(`no IMG hit for '${text}'`);
  const hits = s.rows.filter(r => r.TEXT === text && (!hit || hit.path.some(p => p === r.PARENT_TEXT)));
  if (!hits.length) { await press(12); throw new Error(`Find has no hit '${text}'`); }
  await selectRow([[String(hits[0].row)]]); await press(0);
}
async function spro(text, opts = {}) {
  let hits = cacheFind(text, opts.tree) || [];
  hits = hits.filter(a => a.text.toUpperCase() === text.toUpperCase());
  if (!hits.length) {   // not cached: resolve path via SQL
    const r = (await img(text)).filter(a => a.text.toUpperCase() === text.toUpperCase() && (!opts.tree || a.paths.some(p => p.toUpperCase().includes(opts.tree.toUpperCase()))));
    hits = r.flatMap(a => a.paths.slice(0, 1).map(p => ({ ...a, path: p.split(' › ') })));
  }
  hits = hits.filter((a, i) => hits.findIndex(b => b.activity === a.activity && b.path.join() === a.path.join()) === i);
  if (opts.n != null) hits = [hits[+opts.n]].filter(Boolean);
  if (hits.length !== 1) throw new Error(`${hits.length} IMG activities named '${text}' — add tree=<area text> or n=<index>:\n` + hits.map((h, i) => `  n=${i} ${h.activity}  ${h.path.join(' › ')}`).join('\n'));
  const hit = hits[0];
  // always start from a fresh, collapsed Reference IMG so the path expansion is deterministic (rows are virtualized)
  await gotoTx('SPRO');
  for (let i = 0; i < 4; i++) {   // the start screen may ignore an early click: press until the Reference IMG is shown
    const t = (await state()).title; if (/^Display IMG/.test(t)) break;
    if (/^Customizing: Execute Project/.test(t)) await press(5); else await sleep(300);
  }
  if (!/^Display IMG/.test((await state()).title)) throw new Error('could not open the SAP Reference IMG');
  let ok = true;
  for (let i = 1; i < hit.path.length && ok; i++) ok = (await treeStep(hit.path[i], i)) === 'ok';
  const before = rt.started;
  const exec = () => page(`sg => { const rows = [...document.querySelectorAll('tr')].filter(r => r.offsetParent && !r.querySelector('tr'));
    const lv = r => { const m = r.textContent.match(/Level (\\d+) (Expanded|Collapsed)/); return m ? +m[1] : null; };
    const pi = rows.findIndex(r => lv(r) === ${hit.path.length - 1} && [...r.querySelectorAll('span')].some(s => s.textContent.trim() === ${JSON.stringify(hit.path.at(-1))}));
    const scope = pi < 0 ? rows : rows.slice(pi + 1, (i => i < 0 ? undefined : pi + 1 + i)(rows.slice(pi + 1).findIndex(r => lv(r) != null && lv(r) <= ${hit.path.length - 1})));
    const hitRows = scope.filter(r => [...r.querySelectorAll('span')].some(s => s.textContent.trim() === ${JSON.stringify(hit.text)}));
    if (pi < 0 || hitRows.length !== 1) return 'missing:' + pi + ':' + hitRows.length;
    hitRows[0].scrollIntoView({ block: 'center' }); hitRows[0].querySelector('a[title="IMG - Activity"]').click(); return 'ok'; }`);
  let r = ok ? await exec() : 'missing';
  if (r !== 'ok') { process.stderr.write(`note: tree row not rendered (${r}), using Find\n`); await sproFind(hit.text, hit); r = await exec(); if (r !== 'ok') throw new Error('could not reach IMG activity: ' + r); }
  await afterAction(before);
  for (const t0 = Date.now(); Date.now() - t0 < 15000;) {   // the dialog arrives in a later roundtrip
    const s2 = await state(); if (s2.window > 0 || !/^Display IMG/.test(s2.title)) break; await sleep(100);
  }
  await afterAction(rt.started, false);
  const st = await state();
  if (st.window > 0 && /Locked Data/i.test(st.title)) {   // someone else is maintaining it: do not open display-only, report and stop
    await press('BUTTON_2'); const m = (await statusMsg()).text;
    throw new Error(`${hit.text}: ${m || 'data locked by another user'} — wait for the lock or ask the user; nothing was opened`);
  }
  return `executed ${hit.activity} via SPRO: ${hit.path.join(' › ')} › ${hit.text}\n` + fmtState(await state());
}

// ---------- command dispatch ----------
const kv = (args, loose) => args.map((a, n) => { const i = a.indexOf('='); if (i < 1) { if (loose) return ['#' + n, a]; throw new Error(`expected F=V, got '${a}'`); } return [a.slice(0, i), a.slice(i + 1)]; });
// shell-like split: quotes may wrap a whole token or just the value part (tree="A › B"); SQL lines keep their quotes
function splitArgs(line) {
  if (/^sql\s/i.test(line)) return ['sql', line.replace(/^sql\s+/i, '')];
  return (line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).map(t => t.replace(/"([^"]*)"|'([^']*)'/g, (_, a, b) => a ?? b));
}
async function exec(cmd, args) {
  switch (cmd) {
    case 'spro': { const o = {}; const t = args.filter(a => { const m = a.match(/^(tree|n)=(.*)$/); if (m) o[m[1]] = m[2]; return !m; }); return spro(t.join(' '), o); }
    case 'sm30': await gotoTx(`*SM30 VIEWNAME=${args[0]};DYNP_OKCODE=${args[1] === 'show' ? 'SHOW' : 'UPD'}`); return fmtState(await state());
    case 'sm34': await gotoTx(`*SM34 VCLNAME=${args[0]};DYNP_OKCODE=${args[1] === 'show' ? 'SHOW' : 'UPD'}`); return fmtState(await state());
    case 'tx': await gotoTx(args[1] ? `*${args[0]} ${args.slice(1).join(' ')}` : args[0]); return fmtState(await state());
    case 'state': return fmtState(await state(), args[0] === 'full');
    case 'rows': return (await page(`sg => sg.table()`)).map(r => Object.entries(r).map(([k, v]) => k === 'row' ? `#${v}` : `${k}=${v}`).join(' ')).join('\n') || '(no rows)';
    case 'set': { for (const [k, v] of kv(args)) await setField(k, v); return 'set ' + args.join(' '); }
    case 'press': await press(args.join(' ')); return fmtState(await state());
    case 'key': await key(args[0]); return fmtState(await state());
    case 'okcode': await okcode(args.join(' ')); return fmtState(await state());
    case 'position': return position(kv(args, true));
    case 'select': return selectRow(/^\d+$/.test(args[0]) ? [[args[0]]] : kv(args));
    case 'selectkey': return selectRow(kv(args));
    case 'save': return save(args[0]);
    case 'leave': return leave();
    case 'wait': await waitIdle(); return 'idle';
    case 'dialog': {   // click a button of a SID-less shell dialog by its text
      const r = await page(`sg => { const re = new RegExp('^\\s*' + ${JSON.stringify(args.join(' '))} + '\\s*$', 'i');
        const b = [...document.querySelectorAll('[role=dialog] [role=button],[role=dialog] button,[role=alertdialog] [role=button]')].filter(e => e.offsetParent).find(e => re.test(e.textContent)); return b ? sg.rect(b) : null; }`);
      if (!r) throw new Error('no dialog button ' + args.join(' '));
      await clickAt(r); await waitIdle(); return fmtState(await state()); }
    case 'status': { const s = await statusMsg(); return `${s.type}: ${s.text}`; }
    case 'expect': { const s = await statusMsg(); const re = new RegExp(args.join(' '), 'i'); if (!re.test(s.text)) throw new Error(`expected status /${re.source}/, got '${s.text}'`); return 'ok: ' + s.text; }
    case 'shot': { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(args[0], Buffer.from(r.result.data, 'base64')); return 'wrote ' + args[0]; }
    case 'cache': return buildCache(args.join(' ') || undefined);
    case 'sql': return fmtRows(await sql(args.join(' ')));
    case 'img': return (await img(args.join(' '))).map(a => `${a.activity}  "${a.text}"\n  objects: ${a.objects.join(', ') || '-'}\n${a.paths.map(p => '  SPRO: ' + p).join('\n')}`).join('\n') || 'no IMG activity found';
    case 'sleep': await sleep(+args[0] || 500); return 'slept';
    default: throw new Error(`unknown command '${cmd}'`);
  }
}

const argv = process.argv.slice(2); const VERBOSE = argv[0] === '-v' && argv.shift();
const [cmd, ...args] = argv;
const t0 = Date.now();
try {
  if (cmd === 'run') {
    const src = args[0] && args[0] !== '-' ? readFileSync(args[0], 'utf8') : readFileSync(0, 'utf8');
    for (const raw of src.split('\n')) {
      const line = raw.trim(); if (!line || line.startsWith('#')) continue;
      const [c, ...a] = splitArgs(line); const s0 = Date.now();
      const res = await exec(c, a);
      const brief = VERBOSE || c === 'sql' || c === 'rows' || c === 'state' ? res : res.split('\n').filter(l => /^(\[wnd|status|saved|left|executed|DIALOG|set |selected)/.test(l)).join('\n');
      console.log(`> ${line}  (${Date.now() - s0} ms)${brief ? '\n' + brief : ''}`);
    }
  } else if (cmd) console.log(await exec(cmd, args));
  else console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').filter(l => l.startsWith('//')).join('\n'));
  if (process.env.SAPGUI_TIME) console.error(`total ${Date.now() - t0} ms`);
} catch (e) {
  console.error('ERROR: ' + e.message);
  try { console.error(fmtState(await state())); } catch {}
  process.exitCode = 1;
} finally { ws.close(); }
