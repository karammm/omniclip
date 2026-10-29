// The desktop Settings window: general options, sync rules, devices and searchable history.
// Rendered as a self-contained page; it talks to the main process through window.omniclip.settings (preload.ts).
// Clip text is untrusted (it comes from other devices), so the script only ever uses textContent.
// Icons are constants from @omniclip/ui and are the only markup inserted as HTML.
import { BASE_CSS, ICONS, PLATFORM_ICON } from '@omniclip/ui';

const STYLE = `
html, body { height: 100%; }
body { display: flex; font-size: 14px; overflow: hidden; -webkit-user-select: none; user-select: none; }
body.mac { background: transparent; }
input, .text, .path, .sel { -webkit-user-select: text; user-select: text; }

.sidebar { width: 212px; flex: none; display: flex; flex-direction: column; padding: 14px 10px; background: var(--surface-2); box-shadow: inset -1px 0 0 var(--line); }
body.mac .sidebar { background: transparent; padding-top: 46px; -webkit-app-region: drag; }
body.mac .sidebar button, body.mac .sidebar .side-brand { -webkit-app-region: no-drag; }
.side-brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px 16px; }
.mark { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; color: #fff; background: var(--grad); box-shadow: var(--glow); }
.mark svg.i { width: 19px; height: 19px; stroke-width: 2; }
.side-brand .name { font-weight: 650; font-size: 15px; letter-spacing: -0.015em; line-height: 1.2; }
.side-brand .st { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); line-height: 1.3; margin-top: 2px; }
.side-brand .st .dot { width: 6px; height: 6px; box-shadow: none; }
nav { display: flex; flex-direction: column; gap: 2px; }
nav button {
  display: flex; align-items: center; gap: 10px; width: 100%; height: 34px; padding: 0 10px; border: 0; border-radius: 8px;
  font: 500 13.5px var(--font); color: var(--text-2); background: transparent; cursor: pointer; text-align: left;
}
nav button:hover { background: var(--hover); color: var(--text); }
nav button.active { color: var(--text); background: var(--surface); box-shadow: var(--shadow-1); }
nav button.active svg.i { color: var(--accent-ink); }
body.mac nav button:hover { background: rgb(128 128 128 / 0.12); }
body.mac nav button.active { background: rgb(128 128 128 / 0.2); box-shadow: none; }
nav .count { margin-left: auto; font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
.side-foot { margin-top: auto; padding: 8px 10px 2px; font-size: 11.5px; color: var(--muted); }

main { flex: 1; min-width: 0; overflow-y: auto; background: var(--bg); }
section { display: none; max-width: 640px; margin: 0 auto; padding: 26px 28px 40px; animation: fade 0.18s ease; }
section.active { display: block; }
body.mac .page-head { -webkit-app-region: drag; }
.page-head { display: flex; align-items: flex-end; gap: 12px; margin-bottom: 18px; }
.page-head h1 { font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.02em; }
.page-head p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.page-head .btn { -webkit-app-region: no-drag; }
.section-title:first-of-type { margin-top: 4px; }
.item { min-height: 54px; }
.item .label { font-size: 13.5px; }
.item .end { display: flex; align-items: center; gap: 6px; flex: none; }
.item .select { font-size: 13px; padding-top: 6px; padding-bottom: 6px; max-width: 240px; }
.note { color: var(--muted); font-size: 12.5px; margin: 10px 4px 0; line-height: 1.45; }
.hotkey-error { color: var(--bad); font-size: 12.5px; padding: 0 14px 12px; }

.me { display: flex; align-items: center; gap: 14px; padding: 16px; box-shadow: var(--shadow-2); background: var(--surface); border-radius: var(--r-lg); }
.me .grow { display: flex; flex-direction: column; gap: 8px; }
.me .name-row { display: flex; gap: 8px; }
.me .meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; color: var(--text-2); }
.path { font-size: 12px; color: var(--muted); word-break: break-all; margin-top: 2px; }

.chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 14px; }
.chip { height: 28px; font-size: 12.5px; }

.search-bar { position: sticky; top: 0; z-index: 2; margin: 0 -28px 4px; padding: 10px 28px 12px; background: linear-gradient(var(--bg) 78%, transparent); }
.search-bar .field { height: 40px; background: var(--surface); }
.clip { align-items: flex-start; padding: 12px 14px; }
.clip .avatar { margin-top: 1px; }
.clip .text { white-space: pre-wrap; word-break: break-word; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.45; }
.clip .text.link { color: var(--accent-ink); word-break: break-all; }
.clip .meta { font-size: 12px; color: var(--muted); margin-top: 4px; display: flex; align-items: center; gap: 6px; }
.clip .actions { display: flex; gap: 2px; opacity: 0.55; transition: opacity 0.15s; }
.clip:hover .actions { opacity: 1; }
.clip .actions .pin.on { color: var(--accent-ink); opacity: 1; }
.clip .actions .pin.on svg.i { fill: currentColor; fill-opacity: 0.2; }
.empty { padding: 30px 16px; }
.toast[hidden] { display: none; }

.modal-backdrop { position: fixed; inset: 0; z-index: 30; display: grid; place-items: center; padding: 24px; background: rgb(5 5 15 / 0.45); animation: fade 0.15s ease; -webkit-app-region: no-drag; }
.modal { width: 100%; max-width: 520px; max-height: 100%; overflow-y: auto; padding: 20px; border-radius: var(--r-lg); background: var(--surface); box-shadow: var(--shadow-3); display: flex; flex-direction: column; gap: 14px; animation: rise 0.22s var(--ease); -webkit-user-select: text; user-select: text; }
.modal h2 { margin: 0; font-size: 17px; font-weight: 650; }
.modal label { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; font-weight: 500; color: var(--text-2); }
.modal .pair { display: grid; grid-template-columns: 1fr 160px; gap: 12px; }
.modal textarea.field { min-height: 150px; resize: vertical; font: 13.5px/1.5 var(--font); }
.modal .row-end { display: flex; gap: 8px; align-items: center; }
.modal .row-end .spacer { flex: 1; }
.modal .hint { font-size: 12px; color: var(--muted); line-height: 1.45; }
.modal .hint code { padding: 1px 5px; border-radius: 5px; background: var(--hover); }
.kw { font-family: var(--mono); font-size: 11.5px; }
.snippet .text { -webkit-line-clamp: 1; color: var(--muted); font-size: 12.5px; margin-top: 2px; }
.toast.err svg.i { color: var(--bad); }
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
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'value') n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c != null && c !== false) n.append(c);
  return n;
}
function icon(name, cls) {
  const t = document.createElement('template');
  t.innerHTML = '<svg class="i' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>';
  return t.content.firstChild;
}
const avatar = (name, cls) => el('span', { class: 'avatar' + (cls ? ' ' + cls : '') }, icon(name));
function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(ts).toLocaleDateString();
}
async function act(fn) {
  try { await fn(); } catch (e) { alertBar(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); }
}
let alertTimer = 0;
function alertBar(msg, err) {
  const bar = $('#alert');
  clearTimeout(alertTimer);
  if (!msg) { bar.hidden = true; return; }
  bar.replaceChildren(icon(err ? 'x' : 'check'), el('span', {}, msg));
  bar.className = 'toast' + (err ? ' err' : '');
  bar.hidden = false;
  alertTimer = setTimeout(() => (bar.hidden = true), 4500);
}
/** replaceChildren, skipping the nulls left by conditional sections */
function fill(target, ...nodes) {
  $(target).replaceChildren(...nodes.filter((n) => n != null && n !== false));
}
function head(title, sub, action) {
  return el('header', { class: 'page-head' }, el('div', { class: 'grow' }, el('h1', {}, title), sub ? el('p', {}, sub) : null), action);
}
const title = (t) => el('div', { class: 'section-title' }, t);
const group = (...items) => el('div', { class: 'group' }, ...items);
const text = (label, hint) => el('div', { class: 'grow' }, el('div', { class: 'label' }, label), hint ? el('div', { class: 'hint' }, hint) : null);

// ---- tabs
document.querySelectorAll('nav button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('nav button, section').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $('#' + b.dataset.tab).classList.add('active');
    $('main').scrollTop = 0;
    if (b.dataset.tab === 'history') runSearch();
  }),
);

function renderSidebar() {
  const online = state.devices.filter((d) => d.online).length;
  $('#brand-status').replaceChildren(el('span', { class: state.paused ? 'dot warn' : state.connected ? 'dot on' : 'dot bad' }), state.paused ? 'Paused' : state.connected ? (state.isHub ? 'Hub' : 'Connected') : 'Not connected');
  $('#devices-count').textContent = state.devices.length ? online + '/' + state.devices.length : '';
  $('#snippets-count').textContent = state.snippets.length || '';
  $('#version').textContent = 'OmniClip ' + state.version;
}

// ---- general
function toggle(label, hint, key) {
  return el('label', { class: 'item' }, text(label, hint),
    el('input', { type: 'checkbox', class: 'switch', checked: !!state[key], onchange: (e) => act(() => api.set(key, e.target.checked)) }),
  );
}
function choice(label, hint, key, options) {
  const select = el('select', { class: 'select', onchange: (e) => act(() => api.set(key, e.target.value)) },
    ...options.map((o) => el('option', { value: o.value }, o.label)));
  select.value = state[key];
  return el('div', { class: 'item' }, text(label, hint), select);
}
function renderGeneral() {
  const name = el('input', { type: 'text', class: 'field', value: state.deviceName, maxlength: '64', 'aria-label': 'Name shown on your other devices' });
  const save = el('button', { class: 'btn primary', onclick: () => act(async () => { await api.rename(name.value); alertBar('Name saved'); }) }, 'Save');
  name.addEventListener('keydown', (e) => e.key === 'Enter' && save.click());
  const enc = state.historyEncryption === 'on'
    ? el('span', { class: 'badge ok' }, icon('lock'), 'History encrypted')
    : state.historyEncryption === 'unavailable' ? el('span', { class: 'badge warn' }, 'History not encrypted') : null;
  fill('#general',
    head('General', 'How this computer shows up and syncs.'),
    el('div', { class: 'me' },
      avatar(state.fileManager === 'Finder' ? 'laptop' : state.fileManager === 'Explorer' ? 'monitor' : 'terminal', 'lg'),
      el('div', { class: 'grow' },
        el('div', { class: 'name-row' }, name, save),
        el('div', { class: 'meta' },
          el('span', { class: state.connected ? 'dot on' : 'dot bad' }), el('span', {}, state.statusLabel), enc),
      ),
    ),
    state.historyEncryption === 'unavailable' ? el('div', { class: 'note' }, historyNote()) : null,
    title('Sync'),
    group(
      toggle('Pause syncing', 'Stop sending and receiving until you turn this off.', 'paused'),
      toggle('Put received files on the clipboard', 'Paste them straight into a folder with ' + state.pasteKey + '.', 'filesToClipboard'),
      choice('Passwords and codes', 'Never saved in history.', 'sensitive', [
        { value: 'expire', label: 'Send, then clear after 1 minute' },
        { value: 'skip', label: 'Never send' },
        { value: 'off', label: 'Treat as normal text' },
      ]),
    ),
    title('Quick paste'),
    group(
      choice('Shortcut', 'Opens your recent clips next to the mouse, from any app.', 'hotkey', state.hotkeys),
      state.hotkeyError ? el('div', { class: 'hotkey-error' }, state.hotkeyError) : null,
      toggle('Paste right away', 'Otherwise the clip is only copied, ready for ' + state.pasteKey + '.' + (state.fileManager === 'Finder' ? ' Needs OmniClip allowed in System Settings → Privacy & Security → Accessibility.' : ''), 'autoPaste'),
    ),
    title('Away from home'),
    relayGroup(),
    el('div', { class: 'note' }, 'A relay lets your devices keep syncing when they’re not on the same Wi-Fi. It only passes along encrypted data, so it can’t read your clips. You can run your own for free on Cloudflare; see “Internet relay” in the OmniClip README.'),
    title('Received files'),
    group(
      el('div', { class: 'item' },
        avatar('folder', 'grey'),
        el('div', { class: 'grow' }, el('div', { class: 'label' }, 'Save to'), el('div', { class: 'path' }, state.downloadDir)),
        el('div', { class: 'end' },
          el('button', { class: 'btn sm', onclick: () => act(() => api.openDownloadDir()) }, 'Open'),
          el('button', { class: 'btn sm', onclick: () => act(() => api.chooseDownloadDir()) }, 'Change…'),
        ),
      ),
    ),
    title('App'),
    group(
      toggle('Open at login', null, 'openAtLogin'),
      el('div', { class: 'item' },
        text('OmniClip ' + state.version, state.update ? 'Version ' + state.update.version + ' is available' : 'Checks for updates every few hours.'),
        el('button', { class: state.update ? 'btn primary sm' : 'btn sm', onclick: () => act(() => api.checkUpdates()) },
          icon(state.update ? 'download' : 'refresh', 'sm'),
          state.update ? (state.update.ready ? 'Restart to update' : 'Download update') : 'Check for updates'),
      ),
    ),
  );
}

function relayGroup() {
  const r = state.relay;
  const input = el('input', { type: 'text', class: 'field', value: r.url, placeholder: 'omniclip-relay.yourname.workers.dev', disabled: !r.editable, spellcheck: 'false' });
  const save = el('button', { class: 'btn', disabled: !r.editable, onclick: () => act(async () => { await api.setRelay(input.value); alertBar(input.value.trim() ? 'Relay saved' : 'Relay turned off'); }) }, 'Save');
  input.addEventListener('keydown', (e) => e.key === 'Enter' && save.click());
  const badge =
    r.via === 'relay' ? el('span', { class: 'badge accent' }, icon('globe'), 'This computer is using the relay')
    : r.status === 'online' ? el('span', { class: 'badge ok' }, icon('check'), 'Hub connected to the relay')
    : r.status === 'connecting' ? el('span', { class: 'badge' }, 'Connecting…')
    : r.status === 'error' ? el('span', { class: 'badge bad' }, r.detail || 'Can’t reach the relay')
    : r.status === 'set' ? el('span', { class: 'badge ok' }, icon('check'), 'Ready for when you leave home')
    : el('span', { class: 'badge' }, 'Off');
  return group(
    el('div', { class: 'item' }, avatar('globe', r.url ? '' : 'grey'), text('Internet relay', r.editable ? 'Set it here once; every device picks it up.' : 'Change it from a computer at home.'), badge),
    el('div', { class: 'item' }, input, save),
  );
}

function historyNote() {
  if (state.historyEncryption === 'on') return 'Saved history is encrypted on this computer.';
  if (state.historyEncryption === 'unavailable') return 'Saved history is not encrypted: this computer has no keychain OmniClip can use.';
  return state.connected ? 'History is kept on ' + state.hubLabel + '.' : '';
}

// ---- rules
function renderRules() {
  const name = el('input', { type: 'text', class: 'field', placeholder: 'App name, e.g. 1Password', maxlength: '100' });
  const add = (app) => act(() => api.ignoreApp(app, true));
  const addBtn = el('button', { class: 'btn', onclick: () => name.value.trim() && add(name.value) }, icon('plus', 'sm'), 'Add');
  name.addEventListener('keydown', (e) => e.key === 'Enter' && addBtn.click());
  const apps = state.ignoredApps.map((a) =>
    el('div', { class: 'item' }, avatar('filter', 'grey'), el('div', { class: 'grow label' }, a), el('button', { class: 'btn ghost sm', onclick: () => act(() => api.ignoreApp(a, false)) }, 'Remove')),
  );
  fill('#rules',
    head('Rules', 'Choose what travels between your devices.'),
    title('Send from this computer'),
    group(
      toggle('Text', 'Text you copy is sent to your other devices.', 'sendText'),
      toggle('Keep formatting', 'Bold, fonts and links paste the same way on your other computers.', 'sendFormatting'),
      toggle('Images', null, 'sendImages'),
      toggle('Files and folders', 'Copied in ' + state.fileManager + '. Up to 20 items and 100 MB; folders travel as a zip and are unpacked on arrival.', 'sendCopiedFiles'),
    ),
    title('Use what other devices send'),
    group(
      toggle('Text', 'Put it on this computer’s clipboard.', 'receiveText'),
      toggle('Images', 'Put them on this computer’s clipboard.', 'receiveImages'),
      toggle('Files and folders', 'Save them to ' + state.downloadDir + '.', 'receiveFiles'),
    ),
    el('div', { class: 'note' }, 'What you turn off still shows up in History. Anything sent to this computer alone always comes through.'),
    title('Ignore these apps'),
    el('div', { class: 'note', style: 'margin:0 4px 10px' }, 'Nothing you copy while one of these apps is in front is sent.' + (state.frontAppHint ? ' ' + state.frontAppHint : '')),
    group(
      ...apps,
      el('div', { class: 'item' }, name, addBtn),
      state.suggestedApps.length
        ? el('div', { class: 'chips' }, ...state.suggestedApps.map((a) => el('button', { class: 'chip dashed', title: 'Ignore ' + a, onclick: () => add(a) }, icon('plus', 'sm'), a)))
        : null,
    ),
  );
}

// ---- devices
function renderDevices() {
  const sorted = [...state.devices].sort((a, b) => (b.id === state.deviceId) - (a.id === state.deviceId) || (!!b.online) - (!!a.online));
  const rows = sorted.map((d) => {
    const me = d.id === state.deviceId;
    const hub = d.id === state.hubDeviceId;
    return el('div', { class: 'item' },
      avatar(ICON[d.platform] || 'devices', d.online ? '' : 'grey'),
      el('div', { class: 'grow' },
        el('div', { class: 'label', style: 'display:flex;align-items:center;gap:8px' }, el('span', { class: 'ellipsis' }, d.name),
          me ? el('span', { class: 'badge accent' }, 'This computer') : null, hub ? el('span', { class: 'badge' }, 'Hub') : null),
        el('div', { class: 'hint', style: 'display:flex;align-items:center;gap:6px' }, el('span', { class: d.online ? 'dot on' : 'dot', style: 'width:6px;height:6px;box-shadow:none' }), d.online ? 'Online' : 'Offline'),
      ),
      el('div', { class: 'end' },
        me || !state.connected ? null
          : el('button', { class: 'btn sm', title: 'Send what is on this computer’s clipboard to ' + d.name, onclick: () => act(async () => { await api.sendClipboardTo(d.id); alertBar('Sent to ' + d.name); }) }, icon('send', 'sm'), 'Send clipboard'),
        me || hub || !state.connected ? null
          : el('button', { class: 'btn ghost icon sm danger', title: 'Remove ' + d.name, 'aria-label': 'Remove ' + d.name, onclick: () => confirmRemove(d) }, icon('trash', 'sm')),
      ),
    );
  });
  const online = state.devices.filter((d) => d.online).length;
  fill('#devices',
    head('Devices', state.devices.length ? online + ' of ' + state.devices.length + ' online' : null,
      state.isHub ? el('button', { class: 'btn primary', onclick: () => act(() => api.pair()) }, icon('qr', 'sm'), 'Pair a device') : null),
    rows.length ? group(...rows)
      : el('div', { class: 'card empty' }, avatar('devices', 'lg'), el('div', { class: 'title' }, state.connected ? 'No devices yet' : 'Not connected'),
          el('div', { class: 'small' }, state.connected ? 'Pair a phone, tablet or another computer to start sharing.' : 'OmniClip is looking for your hub on this network.')),
    el('div', { class: 'note' }, 'Removing a device signs it out. It can pair again with a new code.'),
  );
}
function confirmRemove(d) {
  if (confirmRemove.pending !== d.id) {
    confirmRemove.pending = d.id;
    alertBar('Click again to remove ' + d.name + '.', true);
    setTimeout(() => (confirmRemove.pending = null), 4000);
    return;
  }
  confirmRemove.pending = null;
  act(() => api.removeDevice(d.id));
}

// ---- dialogs
function modal(heading, body, actions) {
  const box = el('div', { class: 'modal', role: 'dialog', 'aria-label': heading }, el('h2', {}, heading), ...body, el('div', { class: 'row-end' }, ...actions));
  const back = el('div', { class: 'modal-backdrop' }, box);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(back);
  setTimeout(() => box.querySelector('textarea, input')?.focus(), 0);
  return close;
}
const field = (label, input, hint) => el('label', {}, label, input, hint ? el('div', { class: 'hint' }, hint) : null);

function editSnippet(sn, presetText) {
  const name = el('input', { type: 'text', class: 'field', maxlength: '100', placeholder: 'e.g. Home address', value: sn?.name || '' });
  const keyword = el('input', { type: 'text', class: 'field kw', maxlength: '40', placeholder: 'addr', value: sn?.keyword || '' });
  const text = el('textarea', { class: 'field', placeholder: 'The text to paste', value: sn?.text ?? presetText ?? '' });
  const save = () => act(async () => {
    await api.saveSnippet(sn?.id ?? null, { name: name.value, keyword: keyword.value, text: text.value });
    close();
    alertBar(sn ? 'Snippet saved' : 'Snippet added');
  });
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(); });
  const close = modal(sn ? 'Edit snippet' : 'New snippet', [
    el('div', { class: 'pair' }, field('Name', name), field('Keyword', keyword, 'Type ;' + 'keyword in the picker')),
    field('Text', text),
    el('div', { class: 'hint' }, 'Placeholders: ', el('code', {}, '{date}'), ' ', el('code', {}, '{time}'), ' ', el('code', {}, '{clipboard}'), ' (what you last copied).'),
  ], [
    sn ? el('button', { class: 'btn ghost danger', onclick: () => act(async () => { await api.deleteSnippet(sn.id); close(); alertBar('Snippet deleted'); }) }, icon('trash', 'sm'), 'Delete') : null,
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
    el('button', { class: 'btn primary', onclick: save }, 'Save'),
  ]);
}

function editAndSend(original) {
  const text = el('textarea', { class: 'field', value: original });
  const target = el('select', { class: 'select' },
    el('option', { value: '' }, 'All devices'),
    ...state.devices.filter((d) => d.id !== state.deviceId).map((d) => el('option', { value: d.id }, d.name + (d.online ? '' : ' (offline)'))));
  const send = () => act(async () => {
    await api.sendText(text.value, target.value || undefined);
    close();
    alertBar(target.value ? 'Sent to ' + target.selectedOptions[0].textContent.replace(' (offline)', '') : 'Sent to all devices');
  });
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); });
  const close = modal('Edit & send', [field('Text', text, 'Change it, then send it as a new clip. The original stays in History.')], [
    el('button', { class: 'btn ghost', onclick: () => { close(); editSnippet(null, text.value); } }, icon('zap', 'sm'), 'Save as snippet'),
    el('span', { class: 'spacer' }),
    target,
    el('button', { class: 'btn primary', onclick: send }, icon('send', 'sm'), 'Send'),
  ]);
}

// ---- snippets
function renderSnippets() {
  const rows = state.snippets.map((sn) =>
    el('div', { class: 'item snippet' },
      avatar('zap'),
      el('div', { class: 'grow' }, el('div', { class: 'label ellipsis' }, sn.name || sn.text.split('\\n')[0]), el('div', { class: 'text' }, sn.text.replace(/\\s+/g, ' '))),
      sn.keyword ? el('span', { class: 'badge accent kw' }, ';' + sn.keyword) : null,
      el('div', { class: 'end' },
        el('button', { class: 'btn ghost icon sm', title: 'Edit', 'aria-label': 'Edit ' + (sn.name || 'snippet'), onclick: () => editSnippet(sn) }, icon('pencil', 'sm')),
      ),
    ),
  );
  fill('#snippets',
    head('Snippets', 'Text you paste often, on every device. In the quick-paste picker (' + state.hotkeyLabel + '), type ; and a keyword.',
      state.connected ? el('button', { class: 'btn primary', onclick: () => editSnippet(null) }, icon('plus', 'sm'), 'New snippet') : null),
    rows.length ? group(...rows)
      : el('div', { class: 'card empty' }, avatar('zap', 'lg'), el('div', { class: 'title' }, state.connected ? 'No snippets yet' : 'Not connected'),
          el('div', { class: 'small' }, state.connected ? 'Save addresses, replies and links you paste again and again.' : 'Snippets appear once OmniClip finds your hub.')),
    el('div', { class: 'note' }, 'Snippets are end-to-end encrypted like your clips, and show up on your phones too.'),
  );
}

// ---- history
function clipRow(c) {
  const isLink = c.kind === 'text' && /^https?:\\/\\/\\S+$/.test((c.text || '').trim());
  const kind = c.sensitive ? 'lock' : c.kind === 'image' ? 'image' : c.kind === 'file' ? (c.folder ? 'folder' : 'file') : isLink ? 'link' : 'text';
  const preview = c.kind !== 'text'
    ? el('div', { class: 'text' }, c.name || c.kind)
    : c.sensitive ? el('div', { class: 'text muted' }, '•••••••• password or code, deleted after a minute') : el('div', { class: 'text' + (isLink ? ' link' : '') }, c.text || '');
  const from = c.sourceDeviceId === state.deviceId ? 'This computer' : c.sourceName;
  const to = c.targetName ? ' → ' + (c.targetDeviceId === state.deviceId ? 'this computer' : c.targetName) : '';
  return el('div', { class: 'item clip' },
    avatar(kind, c.sensitive ? 'warn' : c.sourceDeviceId === state.deviceId ? 'grey' : ''),
    el('div', { class: 'grow' }, preview, el('div', { class: 'meta' }, from + to + ' · ' + ago(c.createdAt))),
    el('div', { class: 'actions' },
      el('button', { class: 'btn ghost icon sm', title: c.kind === 'file' ? 'Save' : 'Copy', 'aria-label': c.kind === 'file' ? 'Save' : 'Copy', onclick: () => act(async () => { await api.copy(c.id); alertBar(c.kind === 'file' ? 'Saved' : 'Copied'); }) }, icon(c.kind === 'file' ? 'download' : 'copy', 'sm')),
      state.connected && c.kind === 'text' && !c.sensitive ? el('button', { class: 'btn ghost icon sm', title: 'Edit & send', 'aria-label': 'Edit & send', onclick: () => editAndSend(c.text || '') }, icon('pencil', 'sm')) : null,
      state.connected ? el('button', { class: 'btn ghost icon sm', title: 'Send to one device', 'aria-label': 'Send to one device', onclick: () => act(() => api.sendTo(c.id)) }, icon('send', 'sm')) : null,
      c.sensitive ? null : el('button', { class: 'btn ghost icon sm pin' + (c.pinned ? ' on' : ''), title: c.pinned ? 'Unpin' : 'Pin', 'aria-label': c.pinned ? 'Unpin' : 'Pin', onclick: () => act(async () => { await api.pin(c.id, !c.pinned); runSearch(); }) }, icon('pin', 'sm')),
    ),
  );
}
function renderHistory() {
  let input = $('#q');
  if (!input) {
    input = el('input', { id: 'q', type: 'search', class: 'field', placeholder: 'Search text and file names', oninput: (e) => { query = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 250); } });
  }
  const bar = input.parentElement || el('div', { class: 'search-bar' }, el('div', { class: 'search-field' }, icon('search'), input));
  const pinned = query ? [] : state.pinned;
  const recent = results.filter((c) => query || !c.pinned);
  const blocks = [];
  if (pinned.length) blocks.push(title('Pinned'), group(...pinned.map(clipRow)));
  blocks.push(title(query ? 'Results' : 'Recent'));
  blocks.push(recent.length ? group(...recent.map(clipRow))
    : el('div', { class: 'card empty' }, avatar(query ? 'search' : 'inbox', 'lg'),
        el('div', { class: 'title' }, !state.connected ? 'Not connected' : query ? 'No matches' : 'Nothing copied yet'),
        el('div', { class: 'small' }, !state.connected ? 'History appears once OmniClip finds your hub.' : query ? 'Nothing you’ve copied matches “' + query + '”.' : 'Copy something on any device and it shows up here.')));
  fill('#history', head('History', 'Everything you’ve copied, on every device.'), bar.closest('.search-bar') || bar, ...blocks);
  input.focus();
}
async function runSearch() {
  if (!state.connected) { results = []; return renderHistory(); }
  try { results = await api.search(query); } catch (e) { results = []; }
  renderHistory();
}

async function refresh() {
  state = await api.get();
  renderSidebar();
  renderGeneral();
  renderRules();
  renderSnippets();
  renderDevices();
  if ($('#history').classList.contains('active')) runSearch();
}
api.onChange(refresh);
refresh().then(() => { if (location.hash === '#history') document.querySelector('[data-tab=history]').click(); });
`;

const NAV: Array<[string, string, keyof typeof ICONS]> = [
  ['general', 'General', 'sliders'],
  ['rules', 'Rules', 'filter'],
  ['snippets', 'Snippets', 'zap'],
  ['devices', 'Devices', 'devices'],
  ['history', 'History', 'clock'],
];

function svg(name: keyof typeof ICONS): string {
  return `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
}

/** `mac` gives the window a translucent sidebar under inset traffic lights (see openSettings in main.ts). */
export function renderSettingsPage(mac = false): string {
  const nav = NAV.map(
    ([id, label, icon], i) =>
      `<button class="${i ? '' : 'active'}" data-tab="${id}">${svg(icon)}${label}${id === 'devices' || id === 'snippets' ? `<span class="count" id="${id}-count"></span>` : ''}</button>`,
  ).join('');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>OmniClip Settings</title><style>${BASE_CSS}${STYLE}</style></head><body class="${mac ? 'mac' : ''}">
<aside class="sidebar">
  <div class="side-brand"><span class="mark">${svg('clipboard')}</span><div><div class="name">OmniClip</div><div class="st" id="brand-status"></div></div></div>
  <nav>${nav}</nav>
  <div class="side-foot" id="version"></div>
</aside>
<main><section id="general" class="active"></section><section id="rules"></section><section id="snippets"></section><section id="devices"></section><section id="history"></section></main>
<div id="alert" class="toast" role="status" hidden></div>
<script>const ICONS = ${JSON.stringify(ICONS)}; const ICON = ${JSON.stringify(PLATFORM_ICON)};${SCRIPT}</script></body></html>`;
}
