import { BASE_CSS, ICONS } from '@omniclip/ui';

export type PairPage =
  | { mode: 'hub'; code: string; expiresAt: number; setupUrl: string; qr: string; urls: string[] }
  | { mode: 'join'; hubName: string }
  | { mode: 'info'; message: string };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function svg(name: keyof typeof ICONS, cls = ''): string {
  return `<svg class="i${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
}

const STYLE = `
body {
  min-height: 100vh; padding: 22px 26px 16px; text-align: center; -webkit-user-select: none; user-select: none;
  background: radial-gradient(520px 260px at 50% -90px, color-mix(in srgb, var(--brand-1) 22%, transparent), transparent 75%), var(--bg);
}
.sel { -webkit-user-select: text; user-select: text; }
.mark { display: inline-grid; place-items: center; width: 44px; height: 44px; border-radius: 13px; color: #fff; background: var(--grad); box-shadow: var(--glow); margin-bottom: 10px; }
.mark svg.i { width: 23px; height: 23px; stroke-width: 2; }
h1 { font-size: 21px; font-weight: 700; margin: 0 0 6px; }
.lead { margin: 0 auto; max-width: 320px; color: var(--text-2); font-size: 13.5px; }
.qr { position: relative; display: inline-block; margin: 16px 0 14px; padding: 10px; border-radius: 20px; background: #fff; box-shadow: var(--shadow-2); }
.qr img { display: block; width: 188px; height: 188px; image-rendering: pixelated; }
.code { display: flex; justify-content: center; gap: 6px; margin: 8px 0 6px; }
.code span { display: grid; place-items: center; width: 38px; height: 48px; border-radius: 10px; font: 600 24px var(--mono); background: var(--surface); box-shadow: var(--shadow-1); }
.code .gap { width: 6px; background: none; box-shadow: none; }
.caption { font-size: 12.5px; color: var(--muted); margin: 6px 0; }
.caption b { color: var(--text-2); }
.divider { display: flex; align-items: center; gap: 10px; margin: 14px 0 8px; font-size: 12px; color: var(--muted); }
.divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: var(--line-2); }
.steps { list-style: none; padding: 0; margin: 0; text-align: left; display: flex; flex-direction: column; gap: 8px; }
.steps li { display: flex; gap: 12px; align-items: center; padding: 10px 12px; border-radius: var(--r); background: var(--surface); box-shadow: var(--shadow-1); font-size: 13px; color: var(--text-2); }
.steps li b { color: var(--text); }
.steps .avatar { width: 30px; height: 30px; border-radius: 9px; }
.steps .avatar svg.i { width: 16px; height: 16px; }
.foot { margin-top: 10px; font-size: 11.5px; color: var(--muted); line-height: 1.5; }
.foot .url { word-break: break-all; }
form { display: flex; flex-direction: column; align-items: center; gap: 12px; margin-top: 22px; }
.otp { font: 600 30px var(--mono); letter-spacing: 0.4em; text-align: center; width: 250px; padding: 14px 0 14px 0.4em; border-radius: 14px; }
form .btn { width: 250px; }
.msg { min-height: 22px; font-size: 13px; margin-top: 4px; }
.msg.err { color: var(--bad); }
.msg.ok { color: var(--ok); font-weight: 500; }
.info { margin-top: 40px; }
`;

const TRAY_HINT =
  'OmniClip keeps running in the menu bar (Windows: system tray) after you close this window. Open OmniClip again to bring this window back.';

const MENU_BAR = process.platform === 'darwin' ? 'menu bar' : 'system tray';

function page(body: string, script = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>OmniClip</title><style>${BASE_CSS}${STYLE}</style></head><body>${body}<script>${script}</script></body></html>`;
}

/** Shows a 6-digit code as two groups of three boxes; anything else as one group. */
function codeBoxes(code: string): string {
  const chars = [...code].map((c) => `<span>${esc(c)}</span>`);
  if (chars.length === 6) chars.splice(3, 0, '<span class="gap"></span>');
  return `<div class="code sel" aria-label="Pairing code ${esc(code)}">${chars.join('')}</div>`;
}

export function renderPairPage(p: PairPage): string {
  if (p.mode === 'hub') {
    const minutes = Math.max(1, Math.round((p.expiresAt - Date.now()) / 60000));
    const host = p.setupUrl ? new URL(p.setupUrl).hostname : '';
    return page(`
      <div class="mark">${svg('qr')}</div>
      <h1>Pair a device</h1>
      <p class="lead">Scan with your phone or tablet. It must be on the same Wi-Fi as this computer.</p>
      ${p.qr ? `<div class="qr"><img src="${p.qr}" alt="QR code"></div>` : '<p class="msg err">No Wi-Fi network address found.</p>'}
      <ol class="steps">
        <li><span class="avatar">${svg('phone')}</span><span><b>OmniClip app:</b> tap <b>Scan QR code</b>. That's it.</span></li>
        <li><span class="avatar">${svg('camera')}</span><span><b>No app?</b> Scan with the camera and follow the setup page.</span></li>
      </ol>
      <div class="divider">or enter this code</div>
      ${codeBoxes(p.code)}
      <p class="caption">${host ? `Hub address <b class="sel">${esc(host)}</b> · ` : ''}works once, expires in ${minutes} min</p>
      <p class="foot">Adding another Mac or PC? Run OmniClip on it and enter this code.<br>Closing this window keeps OmniClip running in the ${MENU_BAR}.</p>
    `);
  }
  if (p.mode === 'join') {
    return page(
      `
      <div class="mark">${svg('devices')}</div>
      <h1>Join ${esc(p.hubName)}</h1>
      <p class="lead">On ${esc(p.hubName)}, open the OmniClip menu → <b>Pair a phone or tablet…</b> and enter the 6-digit code shown there.</p>
      <form id="f">
        <input id="code" class="field otp" inputmode="numeric" maxlength="16" autofocus autocomplete="off" placeholder="000000">
        <button id="go" class="btn primary lg">Join</button>
      </form>
      <p id="msg" class="msg"></p>
    `,
      `
      const f = document.getElementById('f'), code = document.getElementById('code'), go = document.getElementById('go'), msg = document.getElementById('msg');
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        go.disabled = true; msg.className = 'msg'; msg.textContent = '';
        try {
          await window.omniclip.join(code.value);
          msg.className = 'msg ok'; msg.textContent = 'Joined! Your clipboard is now shared.';
        } catch (err) {
          msg.className = 'msg err';
          msg.textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
          go.disabled = false;
        }
      });
    `,
    );
  }
  return page(`<div class="info"><div class="mark">${svg('clipboard')}</div><h1>OmniClip</h1><p class="lead">${esc(p.message)}</p><p class="foot">${TRAY_HINT}</p></div>`);
}
