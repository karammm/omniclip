export type PairPage =
  | { mode: 'hub'; code: string; expiresAt: number; setupUrl: string; qr: string; urls: string[] }
  | { mode: 'join'; hubName: string }
  | { mode: 'info'; message: string };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const STYLE = `
:root { color-scheme: light dark; --bg:#f6f6fb; --card:#fff; --text:#16162a; --muted:#6b6b80; --accent:#4f46e5; --border:#e4e4ee; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f0f1a; --card:#1a1a2b; --text:#ececf5; --muted:#9a9ab0; --accent:#6d64f5; --border:#2a2a40; } }
* { box-sizing: border-box; }
body { margin:0; padding:24px; font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:var(--bg); color:var(--text); text-align:center; -webkit-user-select:none; user-select:none; }
h1 { font-size:18px; margin:0 0 4px; }
p { margin:6px 0; }
.muted { color:var(--muted); }
.qr { background:#fff; padding:10px; border-radius:14px; display:inline-block; margin:14px 0 8px; }
.qr img { display:block; width:240px; height:240px; }
.code { font:600 34px/1 ui-monospace,Menlo,Consolas,monospace; letter-spacing:6px; margin:10px 0 4px; -webkit-user-select:text; user-select:text; }
ol { text-align:left; padding-left:20px; margin:12px 0; }
li { margin:4px 0; }
.urls { font-size:12px; color:var(--muted); word-break:break-all; -webkit-user-select:text; user-select:text; }
input { font:600 28px ui-monospace,Menlo,monospace; letter-spacing:6px; text-align:center; width:220px; padding:10px; border-radius:10px; border:1px solid var(--border); background:var(--card); color:var(--text); margin:16px 0 10px; }
button { font:inherit; font-size:15px; padding:10px 22px; border-radius:10px; border:0; background:var(--accent); color:#fff; cursor:pointer; }
button:disabled { opacity:.5; }
.err { color:#dc2626; min-height:20px; }
.ok { color:#16a34a; }
.sel { -webkit-user-select:text; user-select:text; }
`;

const TRAY_HINT =
  'OmniClip keeps running in the menu bar (Windows: system tray) after you close this window. Open OmniClip again to bring this window back.';

function page(body: string, script = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>OmniClip</title><style>${STYLE}</style></head><body>${body}<script>${script}</script></body></html>`;
}

export function renderPairPage(p: PairPage): string {
  if (p.mode === 'hub') {
    const minutes = Math.max(1, Math.round((p.expiresAt - Date.now()) / 60000));
    const host = p.setupUrl ? new URL(p.setupUrl).hostname : '';
    return page(`
      <h1>Pair a phone or tablet</h1>
      <p class="muted">The device must be on the same Wi-Fi as this computer.</p>
      ${p.qr ? `<div class="qr"><img src="${p.qr}" alt="QR code"></div>` : '<p class="err">No Wi-Fi network address found.</p>'}
      <ol>
        <li><b>OmniClip app</b> (Android/iOS): tap <b>Scan QR code</b>. That's it.</li>
        <li><b>No app?</b> Scan with the phone's camera and follow the setup page in the browser.</li>
      </ol>
      <p class="muted">Or enter this code on the device:</p>
      <div class="code">${esc(p.code)}</div>
      ${host ? `<p class="muted">Hub address: <b class="sel">${esc(host)}</b></p>` : ''}
      <p class="muted">Each code works once and expires in ${minutes} min.</p>
      <p class="urls">${esc(p.setupUrl)}</p>
      <p class="urls">To join another Mac or Windows PC, run OmniClip on it and enter this code.</p>
      <p class="urls">${TRAY_HINT}</p>
    `);
  }
  if (p.mode === 'join') {
    return page(
      `
      <h1>Join ${esc(p.hubName)}</h1>
      <p class="muted">On ${esc(p.hubName)}, open the OmniClip menu → <b>Pair a phone or tablet…</b> and enter the 6-digit code shown there.</p>
      <form id="f">
        <input id="code" inputmode="numeric" maxlength="16" autofocus autocomplete="off" placeholder="000000">
        <div><button id="go">Join</button></div>
      </form>
      <p id="msg" class="err"></p>
    `,
      `
      const f = document.getElementById('f'), code = document.getElementById('code'), go = document.getElementById('go'), msg = document.getElementById('msg');
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        go.disabled = true; msg.className = 'err'; msg.textContent = '';
        try {
          await window.omniclip.join(code.value);
          msg.className = 'ok'; msg.textContent = 'Joined! Your clipboard is now shared.';
        } catch (err) {
          msg.textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
          go.disabled = false;
        }
      });
    `,
    );
  }
  return page(`<h1>OmniClip</h1><p class="muted">${esc(p.message)}</p><p class="urls">${TRAY_HINT}</p>`);
}
