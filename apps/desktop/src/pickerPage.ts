// The quick-paste picker: a small window opened by the global shortcut, listing pinned and recent clips.
// Talks to the main process through window.omniclip.picker (preload.ts). Labels come from other devices,
// so the script only ever uses textContent.

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
:root { color-scheme: light dark; --bg:#fff; --text:#16162a; --muted:#6b6b80; --accent:#4f46e5; --sel:#eef0ff; --border:#e4e4ee; }
@media (prefers-color-scheme: dark) { :root { --bg:#1a1a2b; --text:#ececf5; --muted:#9a9ab0; --accent:#6d64f5; --sel:#2a2a48; --border:#2a2a40; } }
* { box-sizing: border-box; }
html, body { margin:0; height:100%; overflow:hidden; }
body { font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:var(--bg); color:var(--text); display:flex; flex-direction:column; border:1px solid var(--border); border-radius:10px; }
input { font:inherit; margin:10px; padding:8px 10px; border-radius:8px; border:1px solid var(--border); background:transparent; color:var(--text); outline:none; }
input:focus { border-color:var(--accent); }
ul { list-style:none; margin:0; padding:0 6px 6px; overflow-y:auto; flex:1; }
li { display:flex; gap:8px; align-items:center; padding:7px 8px; border-radius:7px; cursor:default; }
li.sel { background:var(--sel); }
.n { width:14px; color:var(--muted); font-size:11px; text-align:right; flex:none; }
.body { flex:1; min-width:0; }
.label { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.meta { color:var(--muted); font-size:11px; }
.empty { color:var(--muted); text-align:center; padding:24px; }
footer { color:var(--muted); font-size:11px; padding:6px 12px; border-top:1px solid var(--border); }
`;

const SCRIPT = `
const api = window.omniclip.picker;
const input = document.querySelector('input');
const list = document.querySelector('ul');
const footer = document.querySelector('footer');
let items = [];
let sel = 0;
let timer = 0;

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(ts).toLocaleDateString();
}
function render() {
  list.replaceChildren();
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = input.value ? 'Nothing matches.' : 'Nothing copied yet.';
    list.append(li);
    return;
  }
  items.forEach((it, i) => {
    const li = document.createElement('li');
    if (i === sel) li.className = 'sel';
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = i < 9 && !input.value ? String(i + 1) : '';
    const body = document.createElement('div');
    body.className = 'body';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = (it.pinned ? '📌 ' : '') + (it.kind === 'image' ? '🖼 ' : it.kind === 'file' ? (it.folder ? '📁 ' : '📄 ') : '') + it.label;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = it.source + ' · ' + ago(it.createdAt);
    body.append(label, meta);
    li.append(n, body);
    li.addEventListener('mousemove', () => { if (sel !== i) { sel = i; render(); } });
    li.addEventListener('click', () => choose(i));
    list.append(li);
  });
  list.children[sel]?.scrollIntoView({ block: 'nearest' });
}
async function load() {
  const res = await api.list(input.value);
  items = res.items;
  footer.textContent = res.hint;
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

export function renderPickerPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>OmniClip</title><style>${STYLE}</style></head><body>
<input type="search" placeholder="Search clips…" autofocus>
<ul></ul>
<footer></footer>
<script>${SCRIPT}</script></body></html>`;
}
