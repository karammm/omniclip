import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BrowserWindow,
  ClipboardItem,
  Menu,
  Notification,
  Tray,
  app,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  safeStorage,
  screen,
  shell,
  systemPreferences,
  type MenuItemConstructorOptions,
} from 'electron';
import QRCode from 'qrcode';
import { MAX_RICH_BYTES, MAX_TEXT_BYTES, MAX_UPLOAD_BYTES, detectSensitive, expandSnippet, matchSnippets, normalizeKeyword, type Clip, type Device, type PairResponse, type Platform } from '@omniclip/protocol';
import { Hub, advertise, discover, shutdownMdns, type DiscoveredHub } from '@omniclip/hub';
import { HUB_PORT_TLS, RelayConnection, type WebSocketCtor } from '@omniclip/protocol';
import WebSocket from 'ws';
import { SyncClient, pairWithHub, probe, type HubAddress, type PlainSnippet, type SendOptions } from './client.js';
import { ConfigStore, type Credential, type SensitiveMode } from './config.js';
import { EchoGuard } from './echoGuard.js';
import { decideRole, shouldStepDown } from './election.js';
import { FolderError, measureFolder, unzipFolder, zipFolder } from './folders.js';
import { frontAppNames, matchesApp } from './frontApp.js';
import { renderPairPage } from './pairPage.js';
import { renderPickerPage, type PickerItem } from './pickerPage.js';
import { renderSettingsPage } from './settingsPage.js';
import { Updater } from './updates.js';

/** "Karam's MacBook Pro" on a Mac (the name set in System Settings), the hostname elsewhere. */
function computerName(): string {
  if (process.platform === 'darwin') {
    try {
      const name = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim();
      if (name) return name;
    } catch {
      // fall back to the hostname
    }
  }
  return os.hostname().replace(/\.local$/, '');
}

const PLATFORM: Platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux';
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
// files copied in Finder/Explorer are sent automatically up to these limits; bigger sets need "Send file…"
const AUTO_FILES_MAX = 20;
const AUTO_FILES_MAX_BYTES = 100 * 1024 * 1024;
const TAKEOVER_AFTER_MS = 10_000;
const PASTE_KEY = process.platform === 'darwin' ? '⌘V' : 'Ctrl+V';
/** Shortcut choices offered in Settings ('' turns the picker shortcut off). */
const HOTKEYS = ['CommandOrControl+Shift+V', 'CommandOrControl+Alt+V', 'CommandOrControl+Shift+Space', 'Alt+Shift+V', ''];
const SENSITIVE_MODES: SensitiveMode[] = ['expire', 'skip', 'off'];
/** On/off settings the Settings window may change. */
const BOOLEAN_SETTINGS = [
  'paused',
  'sendCopiedFiles',
  'filesToClipboard',
  'autoPaste',
  'sendText',
  'sendImages',
  'sendFormatting',
  'receiveText',
  'receiveImages',
  'receiveFiles',
] as const;
/** Offered as one-click additions to the ignored apps. */
const PASSWORD_MANAGERS = ['1Password', 'Bitwarden', 'KeePassXC', 'Dashlane', 'Proton Pass', ...(process.platform === 'darwin' ? ['Keychain Access', 'Passwords'] : [])];

if (!app.requestSingleInstanceLock()) app.quit();
if (process.platform === 'win32') app.setAppUserModelId('com.omniclip.app');

const assetsDir = app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.join(__dirname, '../assets');
const webDir = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(__dirname, '../../web/dist');
const userData = app.getPath('userData');
const cfg = new ConfigStore(userData, computerName());
const guard = new EchoGuard();
const updater = new Updater(log);

type Role = 'searching' | 'hub' | 'client' | 'unpaired' | 'error';

const state = {
  role: 'searching' as Role,
  error: '',
  hub: null as Hub | null,
  stopAdvertising: null as (() => void) | null,
  client: null as SyncClient | null,
  /** Discovered hub we could join but aren't paired with yet. */
  pending: null as { hub: DiscoveredHub; addr: HubAddress } | null,
  hubLabel: '',
  networkId: '',
  deviceId: '',
  devices: [] as Device[],
  recent: [] as Clip[],
  pinned: [] as Clip[],
  snippets: [] as PlainSnippet[],
  hubDeviceId: '',
  /** Whether the hub on this computer encrypts saved history ('' when this computer isn't the hub). */
  historyEncryption: '' as '' | 'on' | 'unavailable',
  /** Apps recently copied from, offered in Settings → Rules. */
  recentApps: [] as string[],
};

let tray: Tray | null = null;
let pairWin: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let pickerWin: BrowserWindow | null = null;
let hotkeyError = '';
let watchdog: NodeJS.Timeout | undefined;
let booting = false;

function log(msg: string): void {
  console.log(`[omniclip] ${msg}`);
}

function notify(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: true });
  if (onClick) n.on('click', onClick);
  n.show();
}

// Linux has no login-item API; desktops start whatever is in ~/.config/autostart.
const AUTOSTART_FILE = path.join(os.homedir(), '.config', 'autostart', 'omniclip.desktop');

function openAtLogin(): boolean {
  if (process.platform === 'linux') return fs.existsSync(AUTOSTART_FILE);
  return app.getLoginItemSettings().openAtLogin;
}

function setOpenAtLogin(on: boolean): void {
  if (process.platform !== 'linux') return app.setLoginItemSettings({ openAtLogin: on });
  if (!on) return fs.rmSync(AUTOSTART_FILE, { force: true });
  const exec = process.env.APPIMAGE || process.execPath;
  fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
  fs.writeFileSync(AUTOSTART_FILE, `[Desktop Entry]\nType=Application\nName=OmniClip\nExec="${exec}" --autostart\nX-GNOME-Autostart-enabled=true\n`);
}

function openedAtLogin(): boolean {
  if (process.platform === 'linux') return process.argv.includes('--autostart');
  return !!app.getLoginItemSettings().wasOpenedAtLogin;
}

// ------------------------------------------------------------------ roles

async function teardown(): Promise<void> {
  clearInterval(watchdog);
  state.historyEncryption = '';
  state.client?.stop();
  state.client = null;
  state.stopAdvertising?.();
  state.stopAdvertising = null;
  if (state.hub) {
    await state.hub.stop().catch(() => undefined);
    state.hub = null;
  }
  state.pending = null;
}

async function boot(): Promise<void> {
  if (booting) return;
  booting = true;
  try {
    await teardown();
    setRole('searching');
    // jitter so desktops that lost the same hub don't all decide at the same instant
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 1500));
    const found = await discover(3000);
    const decision = decideRole(found, cfg.knownNetworks());
    log(`discovered ${found.length} hub(s) -> ${decision.role}`);

    if (decision.role === 'hub') {
      // away from home: if the hub is reachable through the relay, join it there instead of starting a second hub
      if (await joinThroughRelay()) return;
      return await becomeHub();
    }
    const addr = await probe(decision.hub.addresses, decision.hub.port);
    if (!addr) {
      log('hub advertised but unreachable; retrying');
      setTimeout(() => void boot(), 5000);
      return;
    }
    state.hubLabel = decision.hub.hubName;
    if (decision.paired) return joinAsClient(addr, cfg.data.credentials[decision.hub.networkId]!, decision.hub.networkId);
    state.pending = { hub: decision.hub, addr };
    setRole('unpaired');
    notify('OmniClip found a hub', `Open the OmniClip menu and choose "Join ${decision.hub.hubName}" to connect this computer.`);
  } finally {
    booting = false;
  }
}

/**
 * The key that encrypts saved history, kept in the OS keychain (Keychain, DPAPI, or the Linux
 * secret service) through safeStorage. Undefined when no keychain is available.
 */
async function historyKey(): Promise<Buffer | undefined> {
  // without a keyring Linux falls back to a fixed password, which protects nothing
  if (!(await safeStorage.isAsyncEncryptionAvailable()) || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) return undefined;
  const file = path.join(userData, 'history.key');
  try {
    if (fs.existsSync(file)) {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(fs.readFileSync(file));
      const key = Buffer.from(result, 'base64');
      if (key.length === 32) {
        if (shouldReEncrypt) fs.writeFileSync(file, await safeStorage.encryptStringAsync(result), { mode: 0o600 });
        return key;
      }
    }
  } catch (err) {
    log(`history key unreadable, making a new one: ${String(err)}`);
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(file, await safeStorage.encryptStringAsync(key.toString('base64')), { mode: 0o600 });
  return key;
}

async function becomeHub(): Promise<void> {
  const seed = cfg.data.registry;
  let key: Buffer | undefined;
  try {
    key = await historyKey();
  } catch (err) {
    log(`history encryption unavailable: ${String(err)}`);
  }
  state.historyEncryption = key ? 'on' : 'unavailable';
  const hub = new Hub({ dataDir: path.join(userData, 'hub'), webDir, seedRegistry: seed, historyKey: key, log });
  try {
    await hub.start();
  } catch (err) {
    state.error = (err as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Port ${hub.ports.tls} is already in use` : String(err);
    state.historyEncryption = '';
    setRole('error');
    return;
  }
  state.hub = hub;
  state.hubLabel = 'this computer';
  const cred = hub.createLocalDevice(cfg.data.deviceName, PLATFORM, cfg.data.credentials[hub.networkId]?.token);
  cfg.data.credentials[hub.networkId] = credentialFrom(cred);
  cfg.data.registry = hub.registry();
  cfg.save();

  const adName = `${cfg.data.deviceName}`;
  state.stopAdvertising = advertise({ port: hub.ports.tls, networkId: hub.networkId, hubName: adName });
  hub.on('pairingCode', (c: { code: string }) => {
    if (!app.isPackaged) log(`pairing code ${c.code}`);
    void refreshPairWindow();
  });
  if (!app.isPackaged) log(`pairing code ${hub.getPairingCode().code}`);
  hub.on('devices', () => {
    cfg.data.registry = hub.registry();
    cfg.save();
  });
  hub.on('relayStatus', () => settingsChanged());

  attachClient({ host: '127.0.0.1', port: hub.ports.tls }, cfg.data.credentials[hub.networkId]!, hub.networkId);
  setRole('hub');

  // split-brain guard: if another hub for this network appears, the lower name wins
  watchdog = setInterval(async () => {
    const found = await discover(2500);
    const ownName = found.find((h) => h.networkId === hub.networkId && h.hubName === adName)?.name ?? `OmniClip ${adName}`;
    if (state.hub === hub && shouldStepDown(found, hub.networkId, ownName)) {
      log('another hub owns this network; stepping down');
      void boot();
    }
  }, 30_000);
}

/**
 * Tries each network this computer belongs to that has a relay: if its hub answers through the
 * relay (the tunnel handshake succeeds, so it's really there), joins it that way.
 */
async function joinThroughRelay(): Promise<boolean> {
  for (const [networkId, cred] of Object.entries(cfg.data.credentials)) {
    if (!cred.relay || !cred.tunnelKey || !cred.keys) continue;
    const test = new RelayConnection(cred.relay, networkId, cred.deviceId, cred.tunnelKey, WebSocket as unknown as WebSocketCtor);
    try {
      await test.open(8000);
    } catch (err) {
      log(`relay: hub not reachable (${String((err as Error).message)})`);
      continue;
    } finally {
      test.close();
    }
    const last = cfg.data.lastHub?.networkId === networkId ? cfg.data.lastHub : undefined;
    log('joining the hub through the relay');
    state.hubLabel = 'your hub';
    joinAsClient(last ? { host: last.host, port: last.port } : { host: '127.0.0.1', port: HUB_PORT_TLS }, cred, networkId, true);
    return true;
  }
  return false;
}

function joinAsClient(addr: HubAddress, cred: Credential, networkId: string, viaRelay = false): void {
  if (!viaRelay) {
    cfg.data.lastHub = { networkId, host: addr.host, port: addr.port };
    cfg.save();
  }
  attachClient(addr, cred, networkId, viaRelay);
  setRole('client');
  // take over as hub if the hub disappears (giving the relay time to step in first)
  watchdog = setInterval(() => {
    const c = state.client;
    const limit = c?.canRelay ? TAKEOVER_AFTER_MS * 3 : TAKEOVER_AFTER_MS;
    if (c && c.status !== 'online' && Date.now() - c.lastOnline > limit) {
      log('lost the hub; re-electing');
      void boot();
    }
  }, 2000);
}

/** What this computer keeps from a pairing: the token, the hub's CA and the end-to-end keys. */
function credentialFrom(res: PairResponse): Credential {
  return {
    token: res.token,
    deviceId: res.deviceId,
    caPem: res.caPem,
    ...(res.keys ? { keys: res.keys } : {}),
    ...(res.tunnelKey ? { tunnelKey: res.tunnelKey } : {}),
    ...(res.relay ? { relay: res.relay } : {}),
  };
}

function attachClient(addr: HubAddress, cred: Credential, networkId: string, viaRelay = false): void {
  const client = new SyncClient(addr, cred.token, cred.caPem, { keys: cred.keys, tunnelKey: cred.tunnelKey, relay: cred.relay }, { networkId, deviceId: cred.deviceId, viaRelay });
  client.on('e2e', (e2e) => {
    const saved = cfg.data.credentials[networkId];
    if (!saved) return;
    for (const k of ['keys', 'tunnelKey', 'relay'] as const) {
      if (e2e[k]) (saved as unknown as Record<string, unknown>)[k] = e2e[k];
      else delete saved[k];
    }
    cfg.save();
    settingsChanged();
  });
  client.on('snippets', (snippets) => {
    state.snippets = snippets;
    settingsChanged();
  });
  state.client = client;
  state.networkId = networkId;
  state.deviceId = cred.deviceId;
  client.on('status', () => {
    updateTray();
    settingsChanged();
  });
  client.on('hello', ({ deviceId, hubDeviceId, history, pinned, devices, snippets }) => {
    state.snippets = snippets;
    state.deviceId = deviceId;
    state.hubDeviceId = hubDeviceId;
    state.devices = devices;
    state.recent = history;
    state.pinned = pinned;
    updateTray();
    settingsChanged();
    // keep the name other devices see in sync with this computer's setting
    const me = devices.find((d) => d.id === deviceId);
    if (me && me.name !== cfg.data.deviceName) client.rename(cfg.data.deviceName).catch((err) => log(`rename failed: ${String(err)}`));
  });
  client.on('clipUpdate', (clip) => {
    state.recent = state.recent.map((c) => (c.id === clip.id ? clip : c));
    state.pinned = clip.pinned ? [clip, ...state.pinned.filter((c) => c.id !== clip.id)] : state.pinned.filter((c) => c.id !== clip.id);
    updateTray();
    settingsChanged();
  });
  client.on('clipRemove', (id) => {
    const clip = [...state.recent, ...state.pinned].find((c) => c.id === id);
    state.recent = state.recent.filter((c) => c.id !== id);
    state.pinned = state.pinned.filter((c) => c.id !== id);
    updateTray();
    settingsChanged();
    // an expired password from another device shouldn't stay pasteable here
    if (clip?.kind === 'text' && clip.sensitive && clip.sourceDeviceId !== state.deviceId) void clearIfHolding(clip.text ?? '');
  });
  client.on('devices', (devices) => {
    state.devices = devices;
    updateTray();
    settingsChanged();
  });
  client.on('registry', (registry) => {
    cfg.data.registry = registry;
    cfg.save();
  });
  client.on('clip', (clip) => {
    state.recent = [clip, ...state.recent.filter((c) => c.id !== clip.id)].slice(0, 50);
    updateTray();
    settingsChanged();
    if (cfg.data.paused || clip.sourceDeviceId === state.deviceId) return;
    // Settings → Rules; a clip sent to this computer alone always comes through
    if (clip.targetDeviceId !== state.deviceId && !receives(clip)) return;
    void applyClip(clip, true);
    if (clip.targetDeviceId === state.deviceId && clip.kind !== 'file') {
      notify(`${clip.sourceName} sent you ${clip.kind === 'image' ? 'an image' : clip.sensitive ? 'a password or code' : 'some text'}`, `It's on your clipboard. Press ${PASTE_KEY} to paste.`);
    }
  });
  client.on('revoked', () => {
    delete cfg.data.credentials[networkId];
    cfg.save();
    notify('OmniClip', 'This computer was removed from the OmniClip network.');
    void boot();
  });
  client.start();
}

// ------------------------------------------------------------------ clipboard

function receives(clip: Clip): boolean {
  return clip.kind === 'text' ? cfg.data.receiveText : clip.kind === 'image' ? cfg.data.receiveImages : cfg.data.receiveFiles;
}

function sha(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

type Snapshot =
  | { fp: string; kind: 'text'; text: string }
  | { fp: string; kind: 'image'; png: Buffer }
  | { fp: string; kind: 'files'; paths: string[] }
  | null;

let lastImageCheck = 0;

async function readPng(): Promise<Buffer | null> {
  for (const item of await clipboard.read()) {
    if (!item.types.includes('image/png')) continue;
    const blob = (await item.getType('image/png')) as Blob;
    return Buffer.from(await blob.arrayBuffer());
  }
  return null;
}

/** Files copied in Finder or Explorer show up as file:// entries in text/uri-list. */
async function readFilePaths(): Promise<string[]> {
  if (!(await clipboard.has('text/uri-list'))) return [];
  for (const item of await clipboard.read()) {
    if (!item.types.includes('text/uri-list')) continue;
    const list = await ((await item.getType('text/uri-list')) as Blob).text();
    return list
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('file:'))
      .map((l) => {
        try {
          return fileURLToPath(l);
        } catch {
          return '';
        }
      })
      .filter(Boolean);
  }
  return [];
}

/** HTML and RTF that came with copied text (none if they're too big to send). */
async function readRich(): Promise<{ html?: string; rtf?: string }> {
  const rich: { html?: string; rtf?: string } = {};
  try {
    for (const item of await clipboard.read()) {
      for (const [type, key] of [['text/html', 'html'], ['text/rtf', 'rtf']] as const) {
        if (rich[key] || !item.types.includes(type)) continue;
        let value = await ((await item.getType(type)) as Blob).text();
        // Chromium adds this when reading; the receiving side adds its own
        if (key === 'html') value = value.replace(/^<meta charset=['"]?utf-8['"]?>/i, '');
        if (value && Buffer.byteLength(value) <= MAX_RICH_BYTES) rich[key] = value;
      }
    }
  } catch (err) {
    log(`could not read formatting: ${String(err)}`);
  }
  return rich;
}

async function snapshot(forceImage = false): Promise<Snapshot> {
  // before text: Finder also puts the file's name on the clipboard as plain text
  const paths = await readFilePaths();
  if (paths.length) return { fp: `f:${sha(paths.join('\n'))}`, kind: 'files', paths };
  // (checked before text even when file sending is off, so a file's name is never sent as text)
  const text = await clipboard.readText();
  if (text) return { fp: `t:${sha(text)}`, kind: 'text', text };
  // reading images is costly; check at most every 1.5s
  if (!forceImage && Date.now() - lastImageCheck < 1500) return null;
  lastImageCheck = Date.now();
  if (!(await clipboard.has('image/png'))) return null;
  const png = await readPng();
  return png?.length ? { fp: `i:${sha(png)}`, kind: 'image', png } : null;
}

/** Serialises clipboard access so the watcher never reads while a remote clip is being written. */
let busy = false;
async function exclusive<T>(fn: () => Promise<T>): Promise<T | undefined> {
  if (busy) return undefined;
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

function sendsKind(kind: NonNullable<Snapshot>['kind']): boolean {
  return kind === 'text' ? cfg.data.sendText : kind === 'image' ? cfg.data.sendImages : cfg.data.sendCopiedFiles;
}

/** The front app's name if it's one the user excluded. Also remembers recent apps for Settings. */
async function ignoredFrontApp(): Promise<string | null> {
  // asking Windows costs a PowerShell start, so only when there are rules to check
  if (process.platform === 'win32' && !cfg.data.ignoredApps.length) return null;
  const names = await frontAppNames();
  const name = names.find((n) => n.trim());
  if (name && !/^(omniclip|electron)$/i.test(name)) {
    state.recentApps = [name, ...state.recentApps.filter((a) => a.toLowerCase() !== name.toLowerCase())].slice(0, 5);
    settingsChanged();
  }
  return matchesApp(names, cfg.data.ignoredApps);
}

async function watchTick(): Promise<void> {
  const client = state.client;
  if (!client || client.status !== 'online' || cfg.data.paused) return;
  const change = await exclusive(async () => {
    const snap = await snapshot();
    if (!snap || !guard.isLocalChange(snap.fp)) return;
    const rich = snap.kind === 'text' && cfg.data.sendText && cfg.data.sendFormatting ? await readRich() : {};
    return { snap, rich };
  });
  if (!change || !sendsKind(change.snap.kind)) return;
  const { snap, rich } = change;
  const app = await ignoredFrontApp();
  if (app) return log(`not sending a copy made in ${app}`);
  try {
    if (snap.kind === 'files') await sendCopiedFiles(snap.paths);
    else if (snap.kind === 'text') {
      const sensitive = await sensitiveOption(snap.text);
      if (sensitive === 'skip') return;
      if (Buffer.byteLength(snap.text) <= MAX_TEXT_BYTES) await client.sendText(snap.text, { sensitive }, sensitive ? {} : rich);
      else await client.sendFile(Buffer.from(snap.text), 'clipboard.txt', 'text/plain', true);
    } else if (snap.png.length <= MAX_IMAGE_BYTES) {
      await client.sendFile(snap.png, 'image.png', 'image/png');
    }
  } catch (err) {
    log(`send failed: ${String(err)}`);
  }
}

/** Password managers mark what they copy so clipboard tools can leave it alone. */
async function isConcealed(): Promise<boolean> {
  const raw =
    process.platform === 'darwin' ? ['org.nspasteboard.ConcealedType'] : process.platform === 'win32' ? ['ExcludeClipboardContentFromMonitorProcessing'] : [];
  try {
    for (const f of raw) if (await clipboard.has(`electron application/osclipboard;format="${f}"`)) return true;
    if (process.platform === 'linux' && (await clipboard.has('x-kde-passwordManagerHint'))) return true;
  } catch {
    // format checks are best effort
  }
  return false;
}

/** How to send this text under the "Passwords and codes" setting: flagged, not flagged, or not at all. */
async function sensitiveOption(text: string): Promise<boolean | 'skip'> {
  if (cfg.data.sensitive === 'off') return false;
  const secret = detectSensitive(text) !== null || (await isConcealed());
  if (secret && cfg.data.sensitive === 'skip') return 'skip';
  return secret;
}

async function clearIfHolding(text: string): Promise<void> {
  while (busy) await new Promise((r) => setTimeout(r, 20));
  await exclusive(async () => {
    if ((await clipboard.readText()) !== text) return;
    clipboard.clear();
    guard.prime(null);
    log('cleared an expired password or code from the clipboard');
  });
}

async function sendCopiedFiles(paths: string[]): Promise<void> {
  const stats = paths.map((p) => {
    try {
      return { p, stat: fs.statSync(p) };
    } catch {
      return null;
    }
  });
  const items = stats.filter((s): s is { p: string; stat: fs.Stats } => !!s && (s.stat.isFile() || s.stat.isDirectory()));
  if (!items.length) return;
  // folders count with everything inside them
  let count = 0;
  let total = 0;
  for (const { p, stat } of items) {
    if (stat.isFile()) {
      count++;
      total += stat.size;
      continue;
    }
    const size = measureFolder(p, AUTO_FILES_MAX_BYTES - total, 5000);
    count++;
    total += size.bytes;
    if (size.tooBig) total = Infinity;
  }
  if (count > AUTO_FILES_MAX || total > AUTO_FILES_MAX_BYTES) {
    const what = Number.isFinite(total) ? `${count} items (${Math.round(total / 1048576)} MB)` : 'That folder';
    notify('OmniClip', `${what} is too much to send automatically. Use "Send file…" in the OmniClip menu.`);
    return;
  }
  await sendPaths(items.map((f) => f.p));
}

function uniquePath(dir: string, name: string): string {
  const clean = path.basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'file';
  const ext = path.extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  let candidate = path.join(dir, clean);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

function downloadDir(): string {
  return cfg.data.downloadDir || path.join(app.getPath('downloads'), 'OmniClip');
}

async function saveFile(clip: Clip, data: Buffer): Promise<void> {
  const dir = downloadDir();
  fs.mkdirSync(dir, { recursive: true });
  let dest: string;
  if (clip.folder) {
    try {
      dest = await unzipFolder(data, dir, (clip.name ?? 'Folder').replace(/\.zip$/i, ''));
    } catch (err) {
      // keep the zip rather than lose the folder
      log(`could not unpack ${clip.name}: ${String(err)}`);
      dest = uniquePath(dir, clip.name ?? 'folder.zip');
      fs.writeFileSync(dest, data);
    }
  } else {
    dest = uniquePath(dir, clip.name ?? 'file');
    fs.writeFileSync(dest, data);
  }
  const what = clip.folder && fs.statSync(dest).isDirectory() ? 'Folder' : 'File';
  const pasteHint = cfg.data.filesToClipboard ? ` Press ${PASTE_KEY} in a folder to paste it.` : '';
  notify(`${what} from ${clip.sourceName}`, `${path.basename(dest)} saved to ${path.basename(dir)}.${pasteHint}`, () => shell.showItemInFolder(dest));
  if (cfg.data.filesToClipboard) queueFileForClipboard(dest);
}

// Files sent together arrive as separate clips; gather them so one paste brings them all.
let incomingFiles: string[] = [];
let incomingTimer: NodeJS.Timeout | undefined;

function queueFileForClipboard(file: string): void {
  incomingFiles.push(file);
  clearTimeout(incomingTimer);
  incomingTimer = setTimeout(() => {
    const files = incomingFiles;
    incomingFiles = [];
    void writeClipboard(() => writeFilesToClipboard(files), true).catch((err) => log(`file clipboard failed: ${String(err)}`));
  }, 1500);
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

/** Puts file references on the clipboard, the same way Finder/Explorer do when you copy files. */
async function writeFilesToClipboard(files: string[]): Promise<void> {
  if (process.platform === 'darwin') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array>${files.map((f) => `<string>${xmlEscape(f)}</string>`).join('')}</array></plist>`;
    await clipboard.write([new ClipboardItem({ 'electron application/osclipboard;format="NSFilenamesPboardType"': new Blob([plist], { type: 'text/plain' }) })]);
  } else if (process.platform === 'win32') {
    const list = files.map((f) => `'${f.replace(/'/g, "''")}'`).join(',');
    await new Promise<void>((resolve, reject) =>
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Set-Clipboard -LiteralPath ${list}`], { windowsHide: true, timeout: 15_000 }, (err) =>
        err ? reject(err) : resolve(),
      ),
    );
  } else {
    const uris = files.map((f) => pathToFileURL(f).href);
    const uriList = new Blob([uris.join('\r\n')], { type: 'text/uri-list' });
    try {
      // GNOME Files and most Linux file managers paste from this format
      const gnome = new Blob([`copy\n${uris.join('\n')}`], { type: 'text/plain' });
      await clipboard.write([new ClipboardItem({ 'text/uri-list': uriList, 'electron application/osclipboard;format="x-special/gnome-copied-files"': gnome })]);
    } catch {
      await clipboard.write([new ClipboardItem({ 'text/uri-list': uriList })]);
    }
  }
}

/** Puts a clip on the local clipboard (or saves it, for files). */
async function applyClip(clip: Clip, fromRemote: boolean): Promise<void> {
  const client = state.client;
  try {
    // fetch before taking the lock so a big download doesn't stall the watcher
    const data = clip.kind === 'text' || !client ? null : await client.fetchBlob(clip);
    if (clip.kind === 'file' && data) return await saveFile(clip, data);
    if (clip.kind === 'image' && data) {
      const png = clip.mime === 'image/png' ? data : nativeImage.createFromBuffer(data).toPNG();
      if (!png.length) return await saveFile(clip, data); // e.g. HEIC on Windows
      return void (await writeClipboard(async () => clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]), fromRemote));
    }
    await writeClipboard(() => writeTextClip(clip), fromRemote);
  } catch (err) {
    log(`apply failed: ${String(err)}`);
  }
}

/** Writes text with its formatting, when it has any. */
async function writeTextClip(clip: Clip): Promise<void> {
  const text = clip.text ?? '';
  if (!clip.html && !clip.rtf) return clipboard.writeText(text);
  const types: Record<string, Blob> = { 'text/plain': new Blob([text], { type: 'text/plain' }) };
  if (clip.html) types['text/html'] = new Blob([clip.html], { type: 'text/html' });
  if (clip.rtf) types['text/rtf'] = new Blob([clip.rtf], { type: 'text/rtf' });
  await clipboard.write([new ClipboardItem(types)]);
}

async function writeClipboard(write: () => Promise<void>, fromRemote: boolean): Promise<void> {
  // wait for any in-flight watcher read, then write and record what the OS now holds
  while (busy) await new Promise((r) => setTimeout(r, 20));
  await exclusive(async () => {
    await write();
    const snap = await snapshot(true);
    if (snap) guard.markApplied(snap.fp);
  });
  if (!fromRemote) notify('OmniClip', 'Copied to clipboard');
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.zip': 'application/zip', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
};

async function sendPaths(paths: string[], to?: string): Promise<void> {
  const client = state.client;
  if (!client) return;
  for (const p of paths) {
    try {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        const zipped = await zipFolder(p, MAX_UPLOAD_BYTES);
        await client.sendFile(zipped.data, `${zipped.name}.zip`, 'application/zip', true, { to, folder: true });
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > MAX_UPLOAD_BYTES) {
        notify('OmniClip', `${path.basename(p)} is larger than 200 MB`);
        continue;
      }
      const mime = MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
      await client.sendFile(fs.readFileSync(p), path.basename(p), mime, true, { to });
    } catch (err) {
      notify('OmniClip', err instanceof FolderError ? err.message : `Could not send ${path.basename(p)}: ${String(err)}`);
    }
  }
}

// ------------------------------------------------------------------ send to one device

function otherDevices(): Device[] {
  return state.devices.filter((d) => d.id !== state.deviceId);
}

function deviceByIdOrThrow(id: string): Device {
  const d = state.devices.find((x) => x.id === id);
  if (!d) throw new Error('That device is no longer paired.');
  return d;
}

/** Sends whatever is on this computer's clipboard to one device. */
async function sendClipboardTo(device: Device): Promise<void> {
  const client = connectedClient();
  const snap = await snapshot(true);
  if (!snap) throw new Error('The clipboard is empty.');
  const to = device.id;
  if (snap.kind === 'files') await sendPaths(snap.paths, to);
  else if (snap.kind === 'image') await client.sendFile(snap.png, 'image.png', 'image/png', false, { to });
  else {
    const sensitive = await sensitiveOption(snap.text);
    if (sensitive === 'skip') throw new Error('That looks like a password or code, and Settings say never to send those.');
    await client.sendText(snap.text, { to, sensitive }, sensitive || !cfg.data.sendFormatting ? {} : await readRich());
  }
  notify('OmniClip', `Sent your clipboard to ${device.name}`);
}

/** Sends a clip from the history to one device. */
async function resendClip(clip: Clip, device: Device): Promise<void> {
  const client = connectedClient();
  const opts: SendOptions = { to: device.id };
  if (clip.kind === 'text') await client.sendText(clip.text ?? '', { ...opts, sensitive: !!clip.sensitive }, { html: clip.html, rtf: clip.rtf });
  else await client.sendFile(await client.fetchBlob(clip), clip.name ?? 'file', clip.mime, clip.kind === 'file', { ...opts, folder: clip.folder });
  notify('OmniClip', `Sent to ${device.name}`);
}

/** macOS can pick files and folders in one dialog; Windows and Linux need one or the other. */
async function chooseAndSendFiles(device?: Device, folders = false): Promise<void> {
  const properties: Electron.OpenDialogOptions['properties'] =
    process.platform === 'darwin' ? ['openFile', 'openDirectory', 'multiSelections'] : folders ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'];
  const res = await dialog.showOpenDialog({ title: device ? `Send to ${device.name}` : 'Send to all devices', properties });
  if (!res.canceled) await sendPaths(res.filePaths, device?.id);
}

function deviceLabel(d: Device): string {
  return `${d.online ? '●' : '○'}  ${d.name}`;
}

// ------------------------------------------------------------------ quick paste

function acceleratorLabel(acc: string): string {
  if (!acc) return 'Off';
  if (process.platform !== 'darwin') return acc.replace('CommandOrControl', 'Ctrl');
  return acc.replace('CommandOrControl', '⌘').replace('Alt', '⌥').replace('Shift', '⇧').replace('Space', 'Space').replace(/\+/g, '');
}

function registerHotkey(): void {
  globalShortcut.unregisterAll();
  hotkeyError = '';
  const acc = cfg.data.hotkey;
  if (!acc) return;
  try {
    if (!globalShortcut.register(acc, () => void openPicker())) hotkeyError = `${acceleratorLabel(acc)} is used by another app. Pick a different shortcut.`;
  } catch (err) {
    hotkeyError = String(err);
  }
  if (hotkeyError) log(hotkeyError);
}

function secretLabel(c: Clip): string {
  const kind = detectSensitive(c.text ?? '');
  return `•••••••• (${kind === 'code' ? 'code' : kind === 'card' ? 'card number' : 'password'}, hidden)`;
}

function sourceLabel(c: Clip): string {
  const from = c.sourceDeviceId === state.deviceId ? 'This computer' : c.sourceName;
  return c.targetName ? `${from} → ${c.targetDeviceId === state.deviceId ? 'you' : c.targetName}` : from;
}

function pickerItem(c: Clip): PickerItem {
  const label = c.kind !== 'text' ? (c.name ?? c.kind) : c.sensitive ? secretLabel(c) : (c.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return { id: c.id, kind: c.kind, label, source: sourceLabel(c), createdAt: c.createdAt, pinned: !!c.pinned, sensitive: !!c.sensitive, folder: !!c.folder };
}

async function pickerClips(query: string): Promise<Clip[]> {
  const q = query.trim().toLowerCase();
  const local = [...state.pinned, ...state.recent].filter((c, i, all) => all.findIndex((x) => x.id === c.id) === i);
  if (!q) return local.slice(0, 50);
  if (state.client?.status === 'online') {
    try {
      return await state.client.search(q, 50);
    } catch {
      // fall back to what this computer already has
    }
  }
  return local.filter((c) => !c.sensitive && ((c.text ?? '').toLowerCase().includes(q) || (c.name ?? '').toLowerCase().includes(q)));
}

async function openPicker(): Promise<void> {
  if (!pickerWin || pickerWin.isDestroyed()) {
    const mac = process.platform === 'darwin';
    pickerWin = new BrowserWindow({
      width: 460,
      height: 470,
      frame: false,
      resizable: false,
      show: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
      // macOS: a frosted popover with the system's rounded corners; elsewhere the page draws its own frame
      ...(mac ? { vibrancy: 'popover' as const, visualEffectState: 'active' as const, backgroundColor: '#00000000', roundedCorners: true } : { transparent: false }),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    pickerWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    pickerWin.on('blur', () => pickerWin?.hide());
    pickerWin.on('closed', () => (pickerWin = null));
    await pickerWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderPickerPage(mac))}`);
  }
  // open next to the mouse, kept inside the screen it's on
  const cursor = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  const [w, h] = pickerWin.getSize() as [number, number];
  const x = Math.min(Math.max(cursor.x - 24, area.x + 8), area.x + area.width - w - 8);
  const below = cursor.y + 16;
  const y = below + h <= area.y + area.height ? below : Math.max(area.y + 8, cursor.y - h - 16);
  pickerWin.setPosition(Math.round(x), Math.round(y));
  pickerWin.show();
  pickerWin.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
  pickerWin.webContents.send('picker:show');
}

/** Hides the picker and hands the keyboard back to the app the user was in. */
function closePicker(): void {
  if (!pickerWin?.isVisible()) return;
  pickerWin.hide();
  const othersOpen = [pairWin, settingsWin].some((w) => w && !w.isDestroyed() && w.isVisible());
  if (process.platform === 'darwin' && !othersOpen) app.hide();
}

let askedForAccessibility = false;

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err) => (err ? reject(err) : resolve())));
}

// macOS: post ⌘V through Core Graphics (needs Accessibility, but not control of System Events)
const MAC_PASTE = `ObjC.import('CoreGraphics');
var src = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState);
[true, false].forEach(function (down) {
  var e = $.CGEventCreateKeyboardEvent(src, 9, down);
  $.CGEventSetFlags(e, $.kCGEventFlagMaskCommand);
  $.CGEventPost($.kCGHIDEventTap, e);
});`;

/** Presses ⌘V / Ctrl+V in the front app. Falls back to a hint when the OS doesn't allow it. */
async function pasteIntoFrontApp(): Promise<void> {
  try {
    if (process.platform === 'darwin') {
      if (!systemPreferences.isTrustedAccessibilityClient(false)) {
        // shows the macOS prompt that leads to Privacy & Security → Accessibility (once per run)
        if (!askedForAccessibility) systemPreferences.isTrustedAccessibilityClient(true);
        askedForAccessibility = true;
        throw new Error('not trusted');
      }
      await run('osascript', ['-l', 'JavaScript', '-e', MAC_PASTE]);
    } else if (process.platform === 'win32') {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "(New-Object -ComObject WScript.Shell).SendKeys('^v')"]);
    } else {
      await run('xdotool', ['key', '--clearmodifiers', 'ctrl+v']).catch(() => run('wtype', ['-M', 'ctrl', 'v', '-m', 'ctrl']));
    }
  } catch {
    const how =
      process.platform === 'darwin'
        ? ' To paste automatically, allow OmniClip in System Settings → Privacy & Security → Accessibility.'
        : process.platform === 'linux'
          ? ' To paste automatically, install xdotool (X11) or wtype (Wayland).'
          : '';
    notify('OmniClip', `Copied. Press ${PASTE_KEY} to paste.${how}`);
  }
}

function snippetItem(sn: PlainSnippet): PickerItem {
  const keyword = normalizeKeyword(sn.keyword);
  return {
    id: `snippet:${sn.id}`,
    kind: 'snippet',
    label: sn.name || sn.text.replace(/\s+/g, ' ').trim().slice(0, 80),
    source: keyword ? `Snippet · ;${keyword}` : 'Snippet',
    createdAt: sn.updatedAt,
    pinned: false,
    sensitive: false,
    folder: false,
  };
}

ipcMain.handle('picker:list', async (_e, query: string) => {
  const q = String(query ?? '');
  const snippets = matchSnippets(state.snippets, q).map(snippetItem);
  const items = [...snippets, ...(q.trim().startsWith(';') ? [] : (await pickerClips(q)).map(pickerItem))];
  const action = cfg.data.autoPaste ? 'Paste' : 'Copy';
  const offline = state.client?.status !== 'online';
  const note = offline ? 'Offline: showing clips this computer already has' : state.snippets.length && !q ? 'Type ; for snippets' : '';
  return { items, action, note };
});
/** Puts a snippet on the clipboard (placeholders filled in) and pastes it like a picked clip. */
async function chooseSnippet(id: string): Promise<void> {
  const sn = state.snippets.find((x) => x.id === id);
  closePicker();
  if (!sn) return;
  const text = expandSnippet(sn.text, await clipboard.readText());
  await writeClipboard(async () => clipboard.writeText(text), true);
  if (!cfg.data.autoPaste) return notify('OmniClip', `Copied. Press ${PASTE_KEY} to paste.`);
  await new Promise((r) => setTimeout(r, process.platform === 'darwin' ? 200 : 120));
  await pasteIntoFrontApp();
}

ipcMain.handle('picker:choose', async (_e, id: string) => {
  if (String(id).startsWith('snippet:')) return chooseSnippet(String(id).slice('snippet:'.length));
  const clip = await findClip(String(id));
  closePicker();
  await applyClip(clip, true);
  // files are saved and put on the clipboard; pasting them blindly could drop them anywhere
  if (clip.kind === 'file' || !cfg.data.autoPaste) {
    if (clip.kind !== 'file') notify('OmniClip', `Copied. Press ${PASTE_KEY} to paste.`);
    return;
  }
  await new Promise((r) => setTimeout(r, process.platform === 'darwin' ? 200 : 120));
  await pasteIntoFrontApp();
});
ipcMain.handle('picker:close', () => closePicker());

// ------------------------------------------------------------------ pairing window

async function pairPageHtml(): Promise<string> {
  if (state.role === 'hub' && state.hub) {
    const { code, expiresAt } = state.hub.getPairingCode();
    const httpUrl = state.hub.urls().http[0];
    const setupUrl = httpUrl ? `${httpUrl}/setup#pair=${code}&ca=${state.hub.caPin}` : '';
    const qr = setupUrl ? await QRCode.toDataURL(setupUrl, { margin: 1, width: 280 }) : '';
    return renderPairPage({ mode: 'hub', code, expiresAt, setupUrl, qr, urls: state.hub.urls().tls });
  }
  if (state.role === 'unpaired' && state.pending) return renderPairPage({ mode: 'join', hubName: state.pending.hub.hubName });
  return renderPairPage({ mode: 'info', message: stateLabel() });
}

async function refreshPairWindow(): Promise<void> {
  if (!pairWin || pairWin.isDestroyed()) return;
  await pairWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(await pairPageHtml())}`);
}

async function openPairWindow(): Promise<void> {
  if (pairWin && !pairWin.isDestroyed()) {
    pairWin.show();
    pairWin.focus();
    return;
  }
  pairWin = new BrowserWindow({
    width: 440,
    height: 760,
    resizable: false,
    title: 'OmniClip',
    show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  pairWin.once('ready-to-show', () => pairWin?.show());
  pairWin.on('closed', () => (pairWin = null));
  await refreshPairWindow();
  if (process.platform === 'darwin') app.focus({ steal: true });
}

ipcMain.handle('omniclip:join', async (_e, code: string) => {
  const pending = state.pending;
  if (!pending) throw new Error('No hub to join');
  const res = await pairWithHub(pending.addr, String(code).trim(), cfg.data.deviceName, PLATFORM);
  cfg.data.credentials[res.networkId] = credentialFrom(res);
  cfg.save();
  state.pending = null;
  joinAsClient(pending.addr, cfg.data.credentials[res.networkId]!, res.networkId);
  setTimeout(() => pairWin?.close(), 900);
  return true;
});

// ------------------------------------------------------------------ tray

function onlineCount(): number {
  return state.devices.filter((d) => d.online).length;
}

function stateLabel(): string {
  switch (state.role) {
    case 'searching':
      return 'Looking for devices…';
    case 'hub':
      return `Hub · ${onlineCount()} of ${state.devices.length} devices online`;
    case 'client':
      if (state.client?.status !== 'online') return `Reconnecting to ${state.hubLabel}…`;
      return `${state.client.via === 'relay' ? 'Connected through the relay' : `Connected to ${state.hubLabel}`} · ${onlineCount()} online`;
    case 'unpaired':
      return `Found ${state.pending?.hub.hubName ?? 'a hub'}. Not joined yet.`;
    case 'error':
      return `Error: ${state.error}`;
  }
}

function clipLabel(c: Clip): string {
  const src = sourceLabel(c);
  if (c.kind === 'text') {
    const t = c.sensitive ? secretLabel(c) : (c.text ?? '').replace(/\s+/g, ' ').trim();
    return `${t.length > 42 ? `${t.slice(0, 42)}…` : t}   (${src})`;
  }
  return `${c.kind === 'image' ? '🖼' : c.folder ? '📁' : '📄'} ${c.name ?? c.kind}   (${src})`;
}

// ------------------------------------------------------------------ settings window

function settingsChanged(): void {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:changed');
}

async function openSettings(tab?: 'history'): Promise<void> {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  const mac = process.platform === 'darwin';
  settingsWin = new BrowserWindow({
    width: 780,
    height: 620,
    minWidth: 640,
    minHeight: 440,
    title: 'OmniClip Settings',
    show: false,
    autoHideMenuBar: true,
    // macOS: translucent sidebar under inset traffic lights, like System Settings
    ...(mac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 18 }, vibrancy: 'sidebar' as const, backgroundColor: '#00000000' } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  settingsWin.once('ready-to-show', () => settingsWin?.show());
  settingsWin.on('closed', () => (settingsWin = null));
  await settingsWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderSettingsPage(mac))}${tab ? `#${tab}` : ''}`);
  if (process.platform === 'darwin') app.focus({ steal: true });
}

function settingsState() {
  return {
    deviceName: cfg.data.deviceName,
    version: app.getVersion(),
    statusLabel: stateLabel(),
    connected: state.client?.status === 'online',
    isHub: state.role === 'hub',
    deviceId: state.deviceId,
    hubDeviceId: state.hubDeviceId,
    devices: state.devices,
    pinned: state.pinned,
    snippets: [...state.snippets].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
    paused: cfg.data.paused,
    sendCopiedFiles: cfg.data.sendCopiedFiles,
    filesToClipboard: cfg.data.filesToClipboard,
    openAtLogin: openAtLogin(),
    downloadDir: downloadDir(),
    update: updater.available,
    fileManager: process.platform === 'darwin' ? 'Finder' : process.platform === 'win32' ? 'Explorer' : 'your file manager',
    pasteKey: PASTE_KEY,
    sensitive: cfg.data.sensitive,
    hotkey: cfg.data.hotkey,
    hotkeys: HOTKEYS.map((value) => ({ value, label: acceleratorLabel(value) })),
    hotkeyError,
    hotkeyLabel: cfg.data.hotkey ? acceleratorLabel(cfg.data.hotkey) : 'set a shortcut in General',
    autoPaste: cfg.data.autoPaste,
    sendText: cfg.data.sendText,
    sendImages: cfg.data.sendImages,
    sendFormatting: cfg.data.sendFormatting,
    receiveText: cfg.data.receiveText,
    receiveImages: cfg.data.receiveImages,
    receiveFiles: cfg.data.receiveFiles,
    ignoredApps: cfg.data.ignoredApps,
    suggestedApps: [...new Set([...state.recentApps, ...PASSWORD_MANAGERS])].filter((a) => !matchesApp([a], cfg.data.ignoredApps)),
    frontAppHint: process.platform === 'linux' ? 'Needs xdotool, and works on X11 only.' : '',
    historyEncryption: state.historyEncryption,
    relay: relayState(),
    hubLabel: state.hubLabel,
  };
}

/** For Settings → Away from home: the relay address and how it's going. */
function relayState(): { url: string; status: string; detail: string; via: string; editable: boolean } {
  const cred = state.networkId ? cfg.data.credentials[state.networkId] : undefined;
  const url = state.hub?.relay?.url ?? cred?.relay?.url ?? '';
  const hub = state.hub?.relayStatus;
  return {
    url,
    status: hub ? hub.status : url ? 'set' : 'off',
    detail: hub?.detail ?? '',
    via: state.client?.via ?? 'lan',
    editable: state.role === 'hub' || (state.role === 'client' && state.client?.via === 'lan'),
  };
}

function connectedClient(): SyncClient {
  const c = state.client;
  if (!c || c.status !== 'online') throw new Error('Not connected to the hub right now.');
  return c;
}

async function findClip(id: string): Promise<Clip> {
  const known = [...state.pinned, ...state.recent].find((c) => c.id === id);
  if (known) return known;
  const found = (await connectedClient().search('', 200)).find((c) => c.id === id);
  if (!found) throw new Error('That clip is no longer in the history.');
  return found;
}

ipcMain.handle('settings:get', () => settingsState());
ipcMain.handle('settings:set', (_e, key: string, value: unknown) => {
  const on = !!value;
  if (key === 'openAtLogin') setOpenAtLogin(on);
  else if (key === 'hotkey' || key === 'sensitive') {
    if (key === 'hotkey' && HOTKEYS.includes(String(value))) cfg.data.hotkey = String(value);
    else if (key === 'sensitive' && SENSITIVE_MODES.includes(value as SensitiveMode)) cfg.data.sensitive = value as SensitiveMode;
    else throw new Error(`bad value for ${key}`);
    cfg.save();
    if (key === 'hotkey') registerHotkey();
  } else if ((BOOLEAN_SETTINGS as readonly string[]).includes(key)) {
    cfg.data[key as (typeof BOOLEAN_SETTINGS)[number]] = on;
    cfg.save();
    // don't flush whatever was copied while paused
    if (key === 'paused') void snapshot(true).then((snap) => guard.prime(snap?.fp ?? null));
  } else throw new Error(`unknown setting ${key}`);
  updateTray();
  settingsChanged();
});
ipcMain.handle('settings:ignoreApp', (_e, name: string, ignore: boolean) => {
  const clean = String(name).trim().slice(0, 100);
  if (!clean) throw new Error('Type the name of the app.');
  const rest = cfg.data.ignoredApps.filter((a) => a.toLowerCase() !== clean.toLowerCase());
  cfg.data.ignoredApps = ignore ? [...rest, clean] : rest;
  cfg.save();
  settingsChanged();
});
ipcMain.handle('settings:rename', async (_e, name: string) => {
  const clean = String(name).trim().slice(0, 64);
  if (!clean) throw new Error('The name cannot be empty.');
  cfg.data.deviceName = clean;
  cfg.save();
  if (state.client?.status === 'online') await state.client.rename(clean);
  if (state.hub) {
    // re-advertise so other computers see the new hub name
    state.stopAdvertising?.();
    state.stopAdvertising = advertise({ port: state.hub.ports.tls, networkId: state.hub.networkId, hubName: clean });
  }
  settingsChanged();
});
ipcMain.handle('settings:chooseDownloadDir', async () => {
  const res = await dialog.showOpenDialog({ title: 'Save received files to', defaultPath: downloadDir(), properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths[0]) return;
  cfg.data.downloadDir = res.filePaths[0];
  cfg.save();
  settingsChanged();
});
ipcMain.handle('settings:openDownloadDir', async () => {
  fs.mkdirSync(downloadDir(), { recursive: true });
  await shell.openPath(downloadDir());
});
ipcMain.handle('settings:removeDevice', async (_e, id: string) => {
  if (state.hub) {
    if (!state.hub.revokeDevice(id)) throw new Error('That device could not be removed.');
  } else await connectedClient().removeDevice(id);
});
ipcMain.handle('settings:search', (_e, query: string) => connectedClient().search(String(query ?? ''), 100));
ipcMain.handle('settings:pin', (_e, id: string, pinned: boolean) => connectedClient().setPinned(id, !!pinned));
ipcMain.handle('settings:copy', async (_e, id: string) => applyClip(await findClip(id), false));
ipcMain.handle('settings:pair', () => openPairWindow());
ipcMain.handle('settings:setRelay', async (_e, url: string) => {
  const clean = String(url ?? '').trim();
  if (state.hub) state.hub.useRelayUrl(clean);
  else await connectedClient().setRelay(clean);
  settingsChanged();
});
ipcMain.handle('settings:saveSnippet', async (_e, id: string | null, snippet: { name?: string; keyword?: string; text?: string }) => {
  const text = String(snippet?.text ?? '');
  if (!text.trim()) throw new Error('A snippet needs some text.');
  const keyword = normalizeKeyword(snippet.keyword);
  const clash = state.snippets.find((x) => keyword && normalizeKeyword(x.keyword) === keyword && x.id !== id);
  if (clash) throw new Error(`;${keyword} is already used by "${clash.name || 'another snippet'}".`);
  await connectedClient().saveSnippet(id || crypto.randomUUID(), { name: String(snippet.name ?? '').trim().slice(0, 100), ...(keyword ? { keyword } : {}), text });
});
ipcMain.handle('settings:deleteSnippet', (_e, id: string) => connectedClient().deleteSnippet(String(id)));
// "Edit & send": text typed or changed in Settings, to every device or one
ipcMain.handle('settings:sendText', async (_e, text: string, deviceId?: string) => {
  const t = String(text ?? '');
  if (!t.trim()) throw new Error('There is nothing to send.');
  await connectedClient().sendText(t, deviceId ? { to: deviceByIdOrThrow(String(deviceId)).id } : {});
});
ipcMain.handle('settings:sendClipboardTo', (_e, deviceId: string) => sendClipboardTo(deviceByIdOrThrow(String(deviceId))));
// pops a native menu of devices under the mouse; resolves once one is picked (or the menu is dismissed)
ipcMain.handle('settings:sendTo', async (_e, clipId: string) => {
  const clip = await findClip(String(clipId));
  const others = otherDevices();
  if (!others.length) throw new Error('There are no other devices to send to.');
  await new Promise<void>((resolve, reject) => {
    const menu = Menu.buildFromTemplate([
      { label: 'Send to', enabled: false },
      ...others.map((d) => ({ label: deviceLabel(d), click: () => resendClip(clip, d).then(resolve, reject) })),
    ]);
    menu.popup({ window: settingsWin ?? undefined, callback: () => setTimeout(resolve, 0) });
  });
});
ipcMain.handle('settings:checkUpdates', async () => {
  if (updater.available) return updater.install();
  const found = await updater.check();
  if (!found) notify('OmniClip', `You're on the latest version (${app.getVersion()}).`);
  settingsChanged();
});

function updateTray(): void {
  if (!tray) return;
  const connected = state.client?.status === 'online';
  const devices: MenuItemConstructorOptions[] = state.devices.map((d) => {
    const label = `${d.online ? '●' : '○'}  ${d.name}${d.id === state.deviceId ? ' (this computer)' : ''}`;
    if (!connected || d.id === state.deviceId || d.id === state.hubDeviceId) return { label, enabled: false };
    return {
      label,
      submenu: [
        {
          label: `Remove ${d.name}`,
          click: () => {
            if (state.hub) state.hub.revokeDevice(d.id);
            else state.client?.removeDevice(d.id).catch((err) => notify('OmniClip', `Could not remove ${d.name}: ${String(err)}`));
          },
        },
      ],
    };
  });

  const update = updater.available;
  const template: MenuItemConstructorOptions[] = [
    { label: stateLabel(), enabled: false },
    ...(update ? [{ label: update.ready ? `Restart to update to ${update.version}` : `Update available: ${update.version}…`, click: () => updater.install() }] : []),
    { type: 'separator' },
  ];
  if (state.role === 'hub') template.push({ label: 'Pair a phone or tablet…', click: () => void openPairWindow() });
  if (state.role === 'unpaired') template.push({ label: `Join ${state.pending?.hub.hubName ?? 'hub'}…`, click: () => void openPairWindow() });
  if (state.role === 'error' || state.role === 'unpaired') template.push({ label: 'Search again', click: () => void boot() });
  template.push(
    ...(state.pinned.length
      ? [{ label: 'Pinned', submenu: state.pinned.slice(0, 20).map((c) => ({ label: `📌 ${clipLabel(c)}`, click: () => void applyClip(c, false) })) }]
      : []),
    {
      label: 'Recent',
      enabled: state.recent.length > 0,
      submenu: [
        ...state.recent.slice(0, 12).map((c) => ({ label: clipLabel(c), click: () => void applyClip(c, false) })),
        { type: 'separator' as const },
        { label: 'Search history…', click: () => void openSettings('history') },
      ],
    },
    {
      label: 'Quick paste…',
      accelerator: cfg.data.hotkey || undefined,
      registerAccelerator: false,
      click: () => void openPicker(),
    },
    {
      label: 'Send clipboard to',
      enabled: connected && otherDevices().length > 0,
      submenu: otherDevices().map((d) => ({
        label: deviceLabel(d),
        click: () => sendClipboardTo(d).catch((err) => notify('OmniClip', err instanceof Error ? err.message : String(err))),
      })),
    },
    ...sendFileMenus(connected),
    { type: 'separator' },
    {
      label: 'Pause syncing',
      type: 'checkbox',
      checked: cfg.data.paused,
      click: (item) => {
        cfg.data.paused = item.checked;
        cfg.save();
        updateTray();
        // don't flush whatever was copied while paused
        void snapshot(true).then((snap) => guard.prime(snap?.fp ?? null));
      },
    },
    { label: 'Devices', enabled: devices.length > 0, submenu: devices },
    {
      label: 'Open at login',
      type: 'checkbox',
      checked: openAtLogin(),
      click: (item) => setOpenAtLogin(item.checked),
    },
    { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => void openSettings() },
    {
      label: 'Check for updates',
      enabled: app.isPackaged,
      click: async () => {
        const found = await updater.check();
        if (!found) notify('OmniClip', `You're on the latest version (${app.getVersion()}).`);
      },
    },
    { label: `Version ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit OmniClip', role: 'quit' },
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(`OmniClip: ${stateLabel()}`);
}

/** "Send file or folder" on macOS; separate "Send file" and "Send folder" menus elsewhere. */
function sendFileMenus(connected: boolean): MenuItemConstructorOptions[] {
  const menu = (label: string, folders: boolean): MenuItemConstructorOptions => ({
    label,
    enabled: connected,
    submenu: [
      { label: 'To all devices…', click: () => void chooseAndSendFiles(undefined, folders) },
      ...(otherDevices().length ? [{ type: 'separator' as const }] : []),
      ...otherDevices().map((d) => ({ label: `To ${d.name}…`, click: () => void chooseAndSendFiles(d, folders) })),
    ],
  });
  return process.platform === 'darwin' ? [menu('Send file or folder', false)] : [menu('Send file', false), menu('Send folder', true)];
}

function setRole(role: Role): void {
  state.role = role;
  if (role !== 'hub' && role !== 'client') {
    state.devices = [];
  }
  updateTray();
  void refreshPairWindow();
}

function createTray(): void {
  const icon =
    process.platform === 'darwin'
      ? nativeImage.createFromPath(path.join(assetsDir, 'trayTemplate.png'))
      : nativeImage.createFromPath(path.join(assetsDir, 'tray-win.png'));
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  if (process.platform !== 'darwin') tray.on('click', () => tray?.popUpContextMenu());
  tray.on('drop-files', (_e, files) => void sendPaths(files));
  updateTray();
}

// ------------------------------------------------------------------ lifecycle

app.on('second-instance', () => openPairWindow().catch((err) => log(`could not open the window: ${String(err)}`)));
app.on('window-all-closed', () => {
  // tray app: keep running
});

app.whenReady().then(async () => {
  app.dock?.hide();
  createTray();
  updater.on('available', (u) => {
    updateTray();
    notify(
      'OmniClip update',
      u.ready ? `Version ${u.version} is ready. Choose "Restart to update" in the OmniClip menu.` : `Version ${u.version} is available. Click to download.`,
      () => updater.install(),
    );
  });
  updater.start();
  registerHotkey();
  guard.prime((await snapshot(true))?.fp ?? null);
  setInterval(() => void watchTick(), 500);
  await boot();
  // The tray icon can be hidden (MacBook notch, menu bar settings), so show a window on a manual launch.
  if (!openedAtLogin()) await openPairWindow();
}).catch((err) => log(`startup failed: ${String(err)}`));

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  void (async () => {
    globalShortcut.unregisterAll();
    await teardown();
    await shutdownMdns();
    app.exit(0);
  })();
});
