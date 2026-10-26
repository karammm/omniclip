// The desktop Settings window: general options, devices and searchable history.
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
    ),
    el('h2', {}, 'Sync'),
    el('div', { class: 'card' },
      toggle('Pause syncing', 'Stop sending and receiving until you turn this off.', 'paused'),
      toggle('Send files I copy', 'Files copied in ' + state.fileManager + ' are sent to your other devices (up to 20 files, 100 MB).', 'sendCopiedFiles'),
      toggle('Put received files on the clipboard', 'Paste them straight into a folder with ' + state.pasteKey + '.', 'filesToClipboard'),
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
      d.id === state.deviceId || d.id === state.hubDeviceId || !state.connected
        ? null
        : el('button', { class: 'btn danger', onclick: () => confirmRemove(d) }, 'Remove'),
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
  const preview = c.kind === 'text' ? el('div', { class: 'text' }, c.text || '') : el('div', {}, (c.kind === 'image' ? '🖼 ' : '📄 ') + (c.name || c.kind));
  return el('div', { class: 'clip' },
    el('div', { class: 'body' },
      preview,
      el('div', { class: 'muted small' }, (c.pinned ? '📌 ' : '') + (c.sourceDeviceId === state.deviceId ? 'This computer' : c.sourceName) + ' · ' + ago(c.createdAt)),
    ),
    el('div', { class: 'actions' },
      el('button', { class: 'btn', onclick: () => act(() => api.copy(c.id)) }, c.kind === 'file' ? 'Save' : 'Copy'),
      el('button', { class: 'btn' + (c.pinned ? ' pin' : ''), title: c.pinned ? 'Unpin' : 'Pin', onclick: () => act(async () => { await api.pin(c.id, !c.pinned); runSearch(); }) }, c.pinned ? 'Unpin' : 'Pin'),
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
<nav><button class="active" data-tab="general">General</button><button data-tab="devices">Devices</button><button data-tab="history">History</button></nav>
<div id="alert" class="card" style="display:none;margin:12px 16px 0;border-color:var(--accent)"></div>
<main><section id="general" class="active"></section><section id="devices"></section><section id="history"></section></main>
<script>${SCRIPT}</script></body></html>`;
}
