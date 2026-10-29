// The quick-paste picker: a small window opened by the global shortcut, listing pinned and recent clips.
// Talks to the main process through window.omniclip.picker (preload.ts). Labels come from other devices,
// so the script only ever uses textContent; icons are constants from @omniclip/ui.
import { BASE_CSS, ICONS } from '@omniclip/ui';

export interface PickerItem {
  id: string;
  kind: 'text' | 'image' | 'file';
  label: string;
  source: string;
  createdAt: number;
  pinned: boolean;
  sensitive: boolean;
  folder: boolean;
}

const STYLE = `
html, body { height: 100%; overflow: hidden; background: transparent; }
body { font-size: 13px; -webkit-user-select: none; user-select: none; }
.frame {
  height: 100%; display: flex; flex-direction: column; overflow: hidden;
  background: var(--surface); box-shadow: inset 0 0 0 1px var(--line-2);
}
body.mac .frame { box-shadow: none; background: color-mix(in srgb, var(--surface) 55%, transparent); }
.top { display: flex; align-items: center; gap: 10px; padding: 0 14px; height: 52px; flex: none; box-shadow: inset 0 -1px 0 var(--line); }
.top svg.i { color: var(--muted); }
.top input { flex: 1; min-width: 0; height: 100%; border: 0; outline: none; background: none; color: var(--text); font: 15px var(--font); }
.top input::placeholder { color: var(--muted); }
ul { list-style: none; margin: 0; padding: 6px; overflow-y: auto; flex: 1; scrollbar-width: thin; }
li { display: flex; gap: 10px; align-items: center; height: 46px; padding: 0 8px; border-radius: 9px; cursor: default; }
li.sel { background: var(--accent-soft); }
li.sel .avatar { color: #fff; background: var(--grad); }
.avatar.sm { width: 28px; height: 28px; }
.body { flex: 1; min-width: 0; }
.label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 13.5px; font-weight: 500; line-height: 1.3; }
.label.secret { letter-spacing: 1px; color: var(--text-2); }
.meta { color: var(--muted); font-size: 11.5px; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.end { display: flex; align-items: center; gap: 6px; flex: none; color: var(--muted); }
.end svg.i { width: 13px; height: 13px; }
li:not(.sel) .enter { display: none; }
li.sel .num { display: none; }
.enter { color: var(--accent-ink); background: color-mix(in srgb, var(--accent-soft), var(--accent) 6%); box-shadow: none; }
.empty { list-style: none; height: auto; padding: 40px 16px; }
footer { display: flex; align-items: center; gap: 12px; flex: none; height: 36px; padding: 0 12px; font-size: 11.5px; color: var(--muted); box-shadow: inset 0 1px 0 var(--line); }
footer .note { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
footer .k { display: flex; align-items: center; gap: 5px; }
footer kbd { height: 18px; min-width: 18px; font-size: 10.5px; }
`;

const SCRIPT = `
const api = window.omniclip.picker;
const input = document.querySelector('input');
const list = document.querySelector('ul');
const note = document.querySelector('.note');
const actionLabel = document.querySelector('#action');
let items = [];
let sel = 0;
let timer = 0;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function icon(name, cls) {
  const t = document.createElement('template');
  t.innerHTML = '<svg class="i' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + ICONS[name] + '</svg>';
  return t.content.firstChild;
}
function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(ts).toLocaleDateString();
}
function kindIcon(it) {
  if (it.sensitive) return 'lock';
  if (it.kind === 'image') return 'image';
  if (it.kind === 'file') return it.folder ? 'folder' : 'file';
  return /^https?:\\/\\/\\S+$/.test(it.label.trim()) ? 'link' : 'text';
}
function render() {
  list.replaceChildren();
  if (!items.length) {
    const li = el('li', 'empty');
    const box = el('div', 'empty');
    const av = el('span', 'avatar lg');
    av.append(icon(input.value ? 'search' : 'inbox'));
    box.append(av, el('div', 'title', input.value ? 'No matches' : 'Nothing copied yet'));
    li.append(box);
    list.append(li);
    return;
  }
  items.forEach((it, i) => {
    const li = el('li', i === sel ? 'sel' : '');
    const av = el('span', 'avatar sm' + (it.sensitive ? ' warn' : ''));
    av.append(icon(kindIcon(it)));
    const body = el('div', 'body');
    body.append(el('div', 'label' + (it.sensitive ? ' secret' : ''), it.label), el('div', 'meta', it.source + ' · ' + ago(it.createdAt)));
    const end = el('div', 'end');
    if (it.pinned) end.append(icon('pin'));
    if (i < 9 && !input.value) end.append(el('kbd', 'num', String(i + 1)));
    end.append(el('kbd', 'enter', '↵'));
    li.append(av, body, end);
    li.addEventListener('mousemove', () => { if (sel !== i) { sel = i; render(); } });
    li.addEventListener('click', () => choose(i));
    list.append(li);
  });
  list.children[sel]?.scrollIntoView({ block: 'nearest' });
}
async function load() {
  const res = await api.list(input.value);
  items = res.items;
  note.textContent = res.note;
  actionLabel.textContent = res.action;
  sel = Math.min(sel, Math.max(0, items.length - 1));
  render();
}
function choose(i) {
  const it = items[i];
  if (it) api.choose(it.id);
}
input.addEventListener('input', () => { sel = 0; clearTimeout(timer); timer = setTimeout(load, 150); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); api.close(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); render(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
  else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
  else if (!input.value && /^[1-9]$/.test(e.key)) { e.preventDefault(); choose(Number(e.key) - 1); }
});
api.onShow(() => { input.value = ''; sel = 0; input.focus(); load(); });
input.focus();
load();
`;

function svg(name: keyof typeof ICONS): string {
  return `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
}

/** `mac`: the window is translucent (vibrancy), so the frame lets the blur show through. */
export function renderPickerPage(mac = false): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>OmniClip</title><style>${BASE_CSS}${STYLE}</style></head><body class="${mac ? 'mac' : ''}">
<div class="frame">
  <div class="top">${svg('search')}<input type="search" placeholder="Search your clips" autofocus><kbd>esc</kbd></div>
  <ul></ul>
  <footer><span class="note"></span><span class="k"><kbd>↑</kbd><kbd>↓</kbd> Choose</span><span class="k"><kbd>↵</kbd> <span id="action">Paste</span></span></footer>
</div>
<script>const ICONS = ${JSON.stringify(ICONS)};${SCRIPT}</script></body></html>`;
}
