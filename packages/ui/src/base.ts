// The design system every OmniClip screen shares: colour tokens, type, and the basic controls
// (buttons, switches, fields, cards, chips, list rows, toasts). The phone app injects it at start-up;
// the desktop windows inline it into their pages.

export const BASE_CSS = `
:root {
  color-scheme: light dark;
  --font: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
  --mono: ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace;
  --brand-1: #5b4cf0;
  --brand-2: #8f3cff;
  --grad: linear-gradient(135deg, var(--brand-1) 0%, var(--brand-2) 100%);
  --bg: #f3f3f7;
  --surface: #ffffff;
  --surface-2: #f7f7fa;
  --raised: #ffffff;
  --hover: rgb(24 24 60 / 0.045);
  --press: rgb(24 24 60 / 0.085);
  --text: #11111d;
  --text-2: #4b4b60;
  --muted: #868699;
  --line: rgb(17 17 45 / 0.075);
  --line-2: rgb(17 17 45 / 0.14);
  --accent: #5b4cf0;
  --accent-ink: #4a3bdf;
  --accent-soft: rgb(91 76 240 / 0.1);
  --accent-ring: rgb(91 76 240 / 0.28);
  --ok: #10a35f;
  --ok-soft: rgb(16 163 95 / 0.12);
  --warn: #c77700;
  --warn-soft: rgb(245 158 11 / 0.14);
  --bad: #e5484d;
  --bad-soft: rgb(229 72 77 / 0.1);
  --shadow-1: 0 1px 2px rgb(16 16 40 / 0.05), 0 0 0 1px var(--line);
  --shadow-2: 0 12px 32px -10px rgb(16 16 40 / 0.18), 0 2px 6px rgb(16 16 40 / 0.05), 0 0 0 1px var(--line);
  --shadow-3: 0 24px 60px -12px rgb(16 16 40 / 0.35), 0 0 0 1px var(--line);
  --glow: 0 10px 28px -10px rgb(91 76 240 / 0.7), inset 0 1px 0 rgb(255 255 255 / 0.22);
  --r-sm: 8px;
  --r: 12px;
  --r-lg: 18px;
  --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #09090f;
    --surface: #131320;
    --surface-2: #191927;
    --raised: #1c1c2b;
    --hover: rgb(255 255 255 / 0.05);
    --press: rgb(255 255 255 / 0.09);
    --text: #f3f3f8;
    --text-2: #b9b9cb;
    --muted: #7d7d95;
    --line: rgb(255 255 255 / 0.07);
    --line-2: rgb(255 255 255 / 0.13);
    --accent: #7867ff;
    --accent-ink: #ada3ff;
    --accent-soft: rgb(120 103 255 / 0.16);
    --accent-ring: rgb(120 103 255 / 0.4);
    --ok: #3dd68c;
    --ok-soft: rgb(61 214 140 / 0.13);
    --warn: #ffb224;
    --warn-soft: rgb(255 178 36 / 0.13);
    --bad: #ff6369;
    --bad-soft: rgb(255 99 105 / 0.13);
    --shadow-1: inset 0 1px 0 rgb(255 255 255 / 0.03), 0 0 0 1px var(--line);
    --shadow-2: 0 16px 40px -12px rgb(0 0 0 / 0.6), inset 0 1px 0 rgb(255 255 255 / 0.04), 0 0 0 1px var(--line);
    --shadow-3: 0 28px 70px -12px rgb(0 0 0 / 0.75), inset 0 1px 0 rgb(255 255 255 / 0.05), 0 0 0 1px var(--line-2);
    --glow: 0 10px 30px -10px rgb(120 103 255 / 0.75), inset 0 1px 0 rgb(255 255 255 / 0.18);
  }
}

*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; }
body {
  font: 15px/1.5 var(--font);
  color: var(--text);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  -webkit-tap-highlight-color: transparent;
  text-rendering: optimizeLegibility;
}
h1, h2, h3 { letter-spacing: -0.015em; line-height: 1.2; }
a { color: var(--accent-ink); text-decoration: none; }
a:hover { text-decoration: underline; }
b, strong { font-weight: 600; }
code, .mono { font-family: var(--mono); font-size: 0.9em; }
::selection { background: var(--accent-ring); }

svg.i { width: 18px; height: 18px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
svg.i.sm { width: 15px; height: 15px; }
svg.i.lg { width: 22px; height: 22px; }

.muted { color: var(--muted); }
.soft { color: var(--text-2); }
.small { font-size: 13px; }
.tiny { font-size: 12px; }
.grow { flex: 1; min-width: 0; }
.ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* buttons */
.btn {
  -webkit-appearance: none; appearance: none;
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  min-height: 36px; padding: 0 14px; border: 0; border-radius: 10px;
  font: 500 14px/1 var(--font); letter-spacing: -0.005em; white-space: nowrap;
  color: var(--text); background: var(--raised); box-shadow: var(--shadow-1);
  cursor: pointer; text-decoration: none; user-select: none; -webkit-user-select: none;
  transition: background 0.15s var(--ease), box-shadow 0.15s var(--ease), transform 0.12s var(--ease), color 0.15s;
}
.btn:hover { background: color-mix(in srgb, var(--raised), var(--text) 4%); text-decoration: none; }
.btn:active { transform: scale(0.97); }
.btn:focus-visible, .switch:focus-visible, .chip:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-ring); }
.btn:disabled { opacity: 0.45; cursor: default; transform: none; }
.btn.primary { color: #fff; background: var(--grad); box-shadow: var(--glow); }
.btn.primary:hover { filter: brightness(1.07); }
.btn.tint { color: var(--accent-ink); background: var(--accent-soft); box-shadow: none; }
.btn.tint:hover { background: color-mix(in srgb, var(--accent-soft), var(--accent) 8%); }
.btn.ghost { background: transparent; box-shadow: none; color: var(--text-2); }
.btn.ghost:hover { background: var(--hover); color: var(--text); }
.btn.danger { color: var(--bad); }
.btn.danger:hover { background: var(--bad-soft); }
.btn.sm { min-height: 30px; padding: 0 11px; font-size: 13px; border-radius: 8px; gap: 6px; }
.btn.lg { min-height: 48px; padding: 0 20px; font-size: 15px; border-radius: 13px; }
.btn.icon { padding: 0; width: 36px; }
.btn.icon.sm { width: 30px; }
.btn.on { color: var(--accent-ink); }

/* switch */
.switch {
  -webkit-appearance: none; appearance: none; flex: none; margin: 0;
  position: relative; width: 40px; height: 24px; border-radius: 999px; cursor: pointer;
  background: var(--line-2); transition: background 0.2s var(--ease);
}
.switch::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgb(0 0 0 / 0.25), 0 0 0 0.5px rgb(0 0 0 / 0.04);
  transition: transform 0.22s var(--ease);
}
.switch:checked { background: var(--accent); }
.switch:checked::after { transform: translateX(16px); }
.switch:disabled { opacity: 0.5; cursor: default; }

/* fields */
.field, .select {
  -webkit-appearance: none; appearance: none;
  font: 14px/1.4 var(--font); color: var(--text); width: 100%;
  background: var(--surface-2); border: 1px solid var(--line-2); border-radius: 10px;
  padding: 9px 12px; outline: none; transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}
.field::placeholder { color: var(--muted); }
.field:focus, .select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); background: var(--surface); }
textarea.field { resize: none; line-height: 1.5; }
.select {
  width: auto; padding-right: 32px; cursor: pointer;
  background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%);
  background-position: calc(100% - 17px) 52%, calc(100% - 12px) 52%;
  background-size: 5px 5px, 5px 5px; background-repeat: no-repeat;
}
.search-field { position: relative; display: flex; align-items: center; }
.search-field > svg.i { position: absolute; left: 12px; color: var(--muted); pointer-events: none; }
.search-field > .field { padding-left: 38px; }
input[type=search]::-webkit-search-cancel-button { -webkit-appearance: none; }

/* surfaces */
.card { background: var(--surface); border-radius: var(--r-lg); box-shadow: var(--shadow-1); }
.group { background: var(--surface); border-radius: var(--r); box-shadow: var(--shadow-1); overflow: hidden; }
.group > .item + .item { box-shadow: inset 0 1px 0 var(--line); }
.item { display: flex; align-items: center; gap: 12px; padding: 12px 14px; min-height: 52px; }
.item .label { font-weight: 500; }
.item .hint { color: var(--muted); font-size: 12.5px; margin-top: 2px; line-height: 1.4; }
label.item { cursor: pointer; }
.section-title { font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); margin: 22px 4px 8px; }

/* avatars, chips, badges */
.avatar {
  display: inline-grid; place-items: center; flex: none; width: 34px; height: 34px; border-radius: 10px;
  color: var(--accent-ink); background: var(--accent-soft);
}
.avatar.sm { width: 26px; height: 26px; border-radius: 8px; }
.avatar.sm svg.i { width: 15px; height: 15px; }
.avatar.lg { width: 48px; height: 48px; border-radius: 14px; }
.avatar.lg svg.i { width: 24px; height: 24px; }
.avatar.grey { color: var(--text-2); background: var(--hover); }
.avatar.ok { color: var(--ok); background: var(--ok-soft); }
.avatar.warn { color: var(--warn); background: var(--warn-soft); }
.chip {
  -webkit-appearance: none; appearance: none; display: inline-flex; align-items: center; gap: 6px; flex: none;
  height: 32px; padding: 0 12px; border: 0; border-radius: 999px; cursor: pointer;
  font: 500 13px/1 var(--font); color: var(--text-2); background: var(--surface); box-shadow: var(--shadow-1);
  transition: background 0.15s, color 0.15s, box-shadow 0.15s;
}
.chip:hover { color: var(--text); }
.chip.active { color: #fff; background: var(--grad); box-shadow: var(--glow); }
.chip.dashed { background: transparent; box-shadow: inset 0 0 0 1px var(--line-2); }
.badge {
  display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border-radius: 999px;
  font: 500 11.5px/1 var(--font); color: var(--text-2); background: var(--hover); white-space: nowrap;
}
.badge.accent { color: var(--accent-ink); background: var(--accent-soft); }
.badge.ok { color: var(--ok); background: var(--ok-soft); }
.badge.warn { color: var(--warn); background: var(--warn-soft); }
.badge.bad { color: var(--bad); background: var(--bad-soft); }
.badge svg.i { width: 13px; height: 13px; }
.dot { display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--line-2); }
.dot.on { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
.dot.warn { background: var(--warn); box-shadow: 0 0 0 3px var(--warn-soft); }
.dot.bad { background: var(--bad); box-shadow: 0 0 0 3px var(--bad-soft); }
.dot.pulse { animation: pulse 1.4s ease-in-out infinite; }
kbd {
  display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 6px;
  font: 500 11px/1 var(--font); color: var(--text-2); background: var(--hover); box-shadow: inset 0 -1px 0 var(--line-2);
}

/* feedback */
.toast {
  position: fixed; left: 50%; bottom: calc(24px + env(safe-area-inset-bottom, 0px)); z-index: 50;
  display: flex; align-items: center; gap: 8px; max-width: calc(100vw - 32px);
  padding: 10px 16px 10px 12px; border-radius: 999px; font-size: 14px; font-weight: 500;
  color: var(--text); background: color-mix(in srgb, var(--raised) 88%, transparent);
  -webkit-backdrop-filter: blur(20px) saturate(1.6); backdrop-filter: blur(20px) saturate(1.6);
  box-shadow: var(--shadow-3); transform: translateX(-50%); animation: toast-in 0.32s var(--ease);
}
.toast svg.i { color: var(--ok); }
.empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 36px 16px; text-align: center; color: var(--muted); }
.empty .avatar { margin-bottom: 6px; }
.empty .title { color: var(--text); font-weight: 600; }

@keyframes toast-in { from { opacity: 0; transform: translate(-50%, 12px) scale(0.96); } }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } }
@keyframes fade { from { opacity: 0; } }
@keyframes pulse { 50% { opacity: 0.35; } }
@keyframes spin { to { transform: rotate(360deg); } }
.rise { animation: rise 0.35s var(--ease) both; }
.spinner { width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--line-2); border-top-color: var(--accent); animation: spin 0.8s linear infinite; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
`;
