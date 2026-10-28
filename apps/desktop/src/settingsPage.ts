// The desktop Settings window: general options, sync rules, devices and searchable history.
// Rendered as a self-contained page; it talks to the main process through window.omniclip.settings (preload.ts).
// Clip text is untrusted (it comes from other devices), so the script only ever uses textContent.

const STYLE = `
:root { color-scheme: light dark; --bg:#f6f6fb; --card:#fff; --text:#16162a; --muted:#6b6b80; --accent:#4f46e5; --border:#e4e4ee; --bad:#dc2626; --ok:#16a34a; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f0f1a; --card:#1a1a2b; --text:#ececf5; --muted:#9a9ab0; --accent:#6d64f5; --border:#2a2a40; } }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:var(--bg); color:var(--text); }
nav { display:flex; gap:4px; padding:12px 16px 0; border-bottom:1px solid var(--border); position:sticky; top:0; background:var(--bg); z-index:1; }
nav button { background:none; border:0; border-bottom:2px solid transparent; color:var(--muted); padding:8px 12px; font:inherit; cursor:pointer; }
nav button.active { color:var(--text); border-bottom-color:var(--accent); font-weight:600; }
main { padding:16px; }
section { display:none; } section.active { display:block; }
.card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:14px; margin-bottom:12px; }
.row { display:flex; align-items:center; gap:10px; justify-content:space-between; }
.row + .row { margin-top:12px; padding-top:12px; border-top:1px solid var(--border); }
.muted { color:var(--muted); } .small { font-size:12px; }
h2 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:18px 0 8px; }
h2:first-child { margin-top:0; }
input[type=text], input[type=search] { font:inherit; padding:8px 10px; border-radius:8px; border:1px solid var(--border); background:var(--card); color:var(--text); width:100%; }
input[type=checkbox] { width:18px; height:18px; accent-color:var(--accent); }
select { font:inherit; padding:6px 8px; border-radius:8px; border:1px solid var(--border); background:var(--card); color:var(--text); }
.warn { color:var(--bad); font-size:12px; margin-top:6px; }
button.btn { font:inherit; padding:6px 12px; border-radius:8px; border:1px solid var(--border); background:var(--card); color:var(--text); cursor:pointer; white-space:nowrap; }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
button.danger { color:var(--bad); }
button:disabled { opacity:.5; cursor:default; }
.dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--border); margin-right:6px; }
.dot.on { background:var(--ok); }
.clip { display:flex; gap:10px; align-items:flex-start; }
.clip + .clip { margin-top:10px; padding-top:10px; border-top:1px solid var(--border); }
.clip .body { flex:1; min-width:0; }
.clip .text { white-space:pre-wrap; word-break:break-word; max-height:4.4em; overflow:hidden; }
.clip .actions { display:flex; gap:6px; }
.pin { color:#d97706; }
.empty { color:var(--muted); text-align:center; padding:16px; }
.path { font-size:12px; color:var(--muted); word-break:break-all; }
.chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
.chip { font:inherit; font-size:12px; padding:4px 10px; border-radius:999px; border:1px dashed var(--border); background:none; color:var(--text); cursor:pointer; }
`;

const SCRIPT = `
const api = window.omniclip.settings;
let state = null;
let query = '';
let results = [];
let searchTimer = 0;

const $ = (sel) => document.querySelector(sel);
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'value') n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}
function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(ts).toLocaleDateString();
}
async function act(fn) {
  try { await fn(); } catch (e) { alertBar(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
}
function alertBar(msg) {
  const bar = $('#alert');
  bar.textContent = msg;
  bar.style.display = msg ? 'block' : 'none';
  if (msg) setTimeout(() => (bar.style.display = 'none'), 5000);
}

// ---- tabs
document.querySelectorAll('nav button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('nav button, section').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $('#' + b.dataset.tab).classList.add('active');
    if (b.dataset.tab === 'history') runSearch();
  }),
);

// ---- general
function toggle(label, hint, key) {
  return el('label', { class: 'row' },
    el('div', {}, el('div', {}, label), hint ? el('div', { class: 'muted small' }, hint) : null),
    el('input', { type: 'checkbox', checked: !!state[key], onchange: (e) => act(() => api.set(key, e.target.checked)) }),
  );
}
function choice(label, hint, key, options) {
  const select = el('select', { onchange: (e) => act(() => api.set(key, e.target.value)) },
    ...options.map((o) => el('option', { value: o.value }, o.label)));
  select.value = state[key];
  return el('div', { class: 'row' },
    el('div', {}, el('div', {}, label), hint ? el('div', { class: 'muted small' }, hint) : null),
    select,
  );
}
function renderGeneral() {
  const name = el('input', { type: 'text', value: state.deviceName, maxlength: '64' });
  const save = el('button', { class: 'btn primary', onclick: () => act(async () => { await api.rename(name.value); alertBar(''); }) }, 'Save');
  name.addEventListener('keydown', (e) => e.key === 'Enter' && save.click());
  $('#general').replaceChildren(
    el('h2', {}, 'This computer'),
    el('div', { class: 'card' },
      el('div', { class: 'muted small' }, 'Name shown on your other devices'),
      el('div', { class: 'row', style: 'margin-top:6px' }, name, save),
      el('div', { class: 'muted small', style: 'margin-top:10px' }, state.statusLabel),
      el('div', { class: 'muted small', style: 'margin-top:4px' }, historyNote()),
    ),
    el('h2', {}, 'Sync'),
    el('div', { class: 'card' },
      toggle('Pause syncing', 'Stop sending and receiving until you turn this off.', 'paused'),
      toggle('Put received files on the clipboard', 'Paste them straight into a folder with ' + state.pasteKey + '.', 'filesToClipboard'),
      choice('Passwords and codes', 'Detected passwords, one-time codes and card numbers are never saved in history.', 'sensitive', [
        { value: 'expire', label: 'Send, then clear after 1 minute' },
        { value: 'skip', label: 'Never send' },
        { value: 'off', label: 'Treat as normal text' },
      ]),
    ),
    el('h2', {}, 'Quick paste'),
    el('div', { class: 'card' },
      choice('Shortcut', 'Opens your recent clips next to the mouse, from any app.', 'hotkey', state.hotkeys),
      state.hotkeyError ? el('div', { class: 'warn' }, state.hotkeyError) : null,
      toggle('Paste right away', 'Otherwise the clip is only copied, ready for ' + state.pasteKey + '.' + (state.fileManager === 'Finder' ? ' On a Mac this needs OmniClip allowed in System Settings → Privacy & Security → Accessibility.' : ''), 'autoPaste'),
    ),
    el('h2', {}, 'Received files'),
    el('div', { class: 'card' },
      el('div', { class: 'row' },
        el('div', { style: 'min-width:0' }, el('div', {}, 'Save to'), el('div', { class: 'path' }, state.downloadDir)),
        el('div', { style: 'display:flex;gap:6px' },
          el('button', { class: 'btn', onclick: () => act(() => api.openDownloadDir()) }, 'Open'),
          el('button', { class: 'btn', onclick: () => act(() => api.chooseDownloadDir()) }, 'Change…'),
        ),
      ),
    ),
    el('h2', {}, 'App'),
    el('div', { class: 'card' },
      toggle('Open at login', null, 'openAtLogin'),
      el('div', { class: 'row' },
        el('div', {}, el('div', {}, 'OmniClip ' + state.version), state.update ? el('div', { class: 'muted small' }, 'Version ' + state.update.version + ' is available') : null),
        el('button', { class: 'btn', onclick: () => act(() => api.checkUpdates()) }, state.update ? (state.update.ready ? 'Restart to update' : 'Download update') : 'Check for updates'),
      ),
    ),
  );
}

function historyNote() {
  if (state.historyEncryption === 'on') return '🔒 Saved history is encrypted on this computer.';
  if (state.historyEncryption === 'unavailable') return 'Saved history is not encrypted: this computer has no keychain OmniClip can use.';
  return state.connected ? 'History is kept on ' + state.hubLabel + '.' : '';
}

// ---- rules
function renderRules() {
  const name = el('input', { type: 'text', placeholder: 'App name, e.g. 1Password', maxlength: '100' });
  const add = (app) => act(() => api.ignoreApp(app, true));
  const addBtn = el('button', { class: 'btn', onclick: () => name.value.trim() && add(name.value) }, 'Add');
  name.addEventListener('keydown', (e) => e.key === 'Enter' && addBtn.click());
  const apps = state.ignoredApps.map((a) =>
    el('div', { class: 'row' }, el('div', {}, a), el('button', { class: 'btn', onclick: () => act(() => api.ignoreApp(a, false)) }, 'Remove')),
  );
  $('#rules').replaceChildren(
    el('h2', {}, 'Send from this computer'),
    el('div', { class: 'card' },
      toggle('Text', 'Text you copy is sent to your other devices.', 'sendText'),
      toggle('Keep formatting', 'Bold, fonts and links paste the same way on your other computers.', 'sendFormatting'),
      toggle('Images', null, 'sendImages'),
      toggle('Files and folders', 'Copied in ' + state.fileManager + '. Up to 20 items and 100 MB; folders are sent as a zip and unpacked on arrival.', 'sendCopiedFiles'),
    ),
    el('h2', {}, 'Use what other devices send'),
    el('div', { class: 'card' },
      toggle('Text', 'Put it on this computer’s clipboard.', 'receiveText'),
      toggle('Images', 'Put them on this computer’s clipboard.', 'receiveImages'),
      toggle('Files and folders', 'Save them to ' + state.downloadDir + '.', 'receiveFiles'),
      el('div', { class: 'muted small', style: 'margin-top:12px' }, 'What you turn off still shows up in History. Anything sent to this computer alone always comes through.'),
    ),
    el('h2', {}, 'Ignore these apps'),
    el('div', { class: 'card' },
      el('div', { class: 'muted small' }, 'Nothing you copy while one of these apps is in front is sent.' + (state.frontAppHint ? ' ' + state.frontAppHint : '')),
      ...apps,
      el('div', { class: 'row' }, name, addBtn),
      state.suggestedApps.length
        ? el('div', { class: 'chips' }, ...state.suggestedApps.map((a) => el('button', { class: 'chip', title: 'Ignore ' + a, onclick: () => add(a) }, '+ ' + a)))
        : null,
    ),
  );
}

// ---- devices
const ICON = { mac: '💻', windows: '🖥️', linux: '🐧', ios: '📱', ipados: '📲', android: '🤖', web: '🌐', shortcut: '⚡' };
function renderDevices() {
  const rows = state.devices.map((d) =>
    el('div', { class: 'row' },
      el('div', {},
        el('span', { class: d.online ? 'dot on' : 'dot' }),
        (ICON[d.platform] || '•') + ' ' + d.name,
        d.id === state.deviceId ? el('span', { class: 'muted' }, ' (this computer)') : null,
        d.id === state.hubDeviceId ? el('span', { class: 'muted' }, ' · hub') : null,
      ),
      el('div', { style: 'display:flex;gap:6px' },
        d.id === state.deviceId || !state.connected
          ? null
          : el('button', { class: 'btn', title: 'Send what is on this computer’s clipboard to ' + d.name, onclick: () => act(() => api.sendClipboardTo(d.id)) }, 'Send clipboard'),
        d.id === state.deviceId || d.id === state.hubDeviceId || !state.connected
          ? null
          : el('button', { class: 'btn danger', onclick: () => confirmRemove(d) }, 'Remove'),
      ),
    ),
  );
  $('#devices').replaceChildren(
    el('div', { class: 'row', style: 'margin-bottom:12px' },
      el('div', { class: 'muted' }, state.devices.filter((d) => d.online).length + ' of ' + state.devices.length + ' online'),
      state.isHub ? el('button', { class: 'btn primary', onclick: () => act(() => api.pair()) }, 'Pair a device…') : null,
    ),
    el('div', { class: 'card' }, ...(rows.length ? rows : [el('div', { class: 'empty' }, state.connected ? 'No devices yet.' : 'Not connected to a hub.')])),
    el('div', { class: 'muted small' }, 'Removing a device signs it out. It can pair again with a new code.'),
  );
}
function confirmRemove(d) {
  if (confirmRemove.pending !== d.id) {
    confirmRemove.pending = d.id;
    alertBar('Click Remove again to remove ' + d.name + '.');
    setTimeout(() => (confirmRemove.pending = null), 4000);
    return;
  }
  confirmRemove.pending = null;
  act(() => api.removeDevice(d.id));
}

// ---- history
function clipRow(c) {
  const preview = c.kind !== 'text'
    ? el('div', {}, (c.kind === 'image' ? '🖼 ' : c.folder ? '📁 ' : '📄 ') + (c.name || c.kind))
    : c.sensitive ? el('div', { class: 'text muted' }, '🔒 •••••••• (password or code, deleted after a minute)') : el('div', { class: 'text' }, c.text || '');
  const from = c.sourceDeviceId === state.deviceId ? 'This computer' : c.sourceName;
  const to = c.targetName ? ' → ' + (c.targetDeviceId === state.deviceId ? 'this computer' : c.targetName) : '';
  return el('div', { class: 'clip' },
    el('div', { class: 'body' },
      preview,
      el('div', { class: 'muted small' }, (c.pinned ? '📌 ' : '') + from + to + ' · ' + ago(c.createdAt)),
    ),
    el('div', { class: 'actions' },
      el('button', { class: 'btn', onclick: () => act(() => api.copy(c.id)) }, c.kind === 'file' ? 'Save' : 'Copy'),
      state.connected ? el('button', { class: 'btn', title: 'Send to one device', onclick: () => act(() => api.sendTo(c.id)) }, 'Send to…') : null,
      c.sensitive ? null : el('button', { class: 'btn' + (c.pinned ? ' pin' : ''), title: c.pinned ? 'Unpin' : 'Pin', onclick: () => act(async () => { await api.pin(c.id, !c.pinned); runSearch(); }) }, c.pinned ? 'Unpin' : 'Pin'),
    ),
  );
}
function renderHistory() {
  const input = $('#q') || el('input', { id: 'q', type: 'search', placeholder: 'Search text and file names…', oninput: (e) => { query = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 250); } });
  const pinned = query ? [] : state.pinned;
  const recent = results.filter((c) => query || !c.pinned);
  const blocks = [];
  if (pinned.length) blocks.push(el('h2', {}, 'Pinned'), el('div', { class: 'card' }, ...pinned.map(clipRow)));
  blocks.push(el('h2', {}, query ? 'Results' : 'Recent'));
  blocks.push(el('div', { class: 'card' }, ...(recent.length ? recent.map(clipRow) : [el('div', { class: 'empty' }, !state.connected ? 'Not connected to a hub.' : query ? 'Nothing matches "' + query + '".' : 'Nothing copied yet.')])));
  $('#history').replaceChildren(input, ...blocks);
  input.focus();
}
async function runSearch() {
  if (!state.connected) { results = []; return renderHistory(); }
  try { results = await api.search(query); } catch (e) { results = []; }
  renderHistory();
}

async function refresh() {
  state = await api.get();
  renderGeneral();
  renderRules();
  renderDevices();
  if ($('#history').classList.contains('active')) runSearch();
}
api.onChange(refresh);
refresh().then(() => { if (location.hash === '#history') document.querySelector('[data-tab=history]').click(); });
`;

export function renderSettingsPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>OmniClip Settings</title><style>${STYLE}</style></head><body>
<nav><button class="active" data-tab="general">General</button><button data-tab="rules">Rules</button><button data-tab="devices">Devices</button><button data-tab="history">History</button></nav>
<div id="alert" class="card" style="display:none;margin:12px 16px 0;border-color:var(--accent)"></div>
<main><section id="general" class="active"></section><section id="rules"></section><section id="devices"></section><section id="history"></section></main>
<script>${SCRIPT}</script></body></html>`;
}
