import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, ClipboardItem, Menu, Notification, Tray, app, clipboard, dialog, ipcMain, nativeImage, shell, type MenuItemConstructorOptions } from 'electron';
import QRCode from 'qrcode';
import { MAX_TEXT_BYTES, MAX_UPLOAD_BYTES, type Clip, type Device, type Platform } from '@omniclip/protocol';
import { Hub, advertise, discover, shutdownMdns, type DiscoveredHub } from '@omniclip/hub';
import { SyncClient, pairWithHub, probe, type HubAddress } from './client.js';
import { ConfigStore, type Credential } from './config.js';
import { EchoGuard } from './echoGuard.js';
import { decideRole, shouldStepDown } from './election.js';
import { renderPairPage } from './pairPage.js';
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
  hubDeviceId: '',
};

let tray: Tray | null = null;
let pairWin: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
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

// ------------------------------------------------------------------ roles

async function teardown(): Promise<void> {
  clearInterval(watchdog);
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

    if (decision.role === 'hub') return await becomeHub();
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

async function becomeHub(): Promise<void> {
  const seed = cfg.data.registry;
  const hub = new Hub({ dataDir: path.join(userData, 'hub'), webDir, seedRegistry: seed, log });
  try {
    await hub.start();
  } catch (err) {
    state.error = (err as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Port ${hub.ports.tls} is already in use` : String(err);
    setRole('error');
    return;
  }
  state.hub = hub;
  state.hubLabel = 'this computer';
  const cred = hub.createLocalDevice(cfg.data.deviceName, PLATFORM, cfg.data.credentials[hub.networkId]?.token);
  cfg.data.credentials[hub.networkId] = { token: cred.token, deviceId: cred.deviceId, caPem: cred.caPem };
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

function joinAsClient(addr: HubAddress, cred: Credential, networkId: string): void {
  attachClient(addr, cred, networkId);
  setRole('client');
  // take over as hub if the hub disappears
  watchdog = setInterval(() => {
    const c = state.client;
    if (c && c.status !== 'online' && Date.now() - c.lastOnline > TAKEOVER_AFTER_MS) {
      log('lost the hub; re-electing');
      void boot();
    }
  }, 2000);
}

function attachClient(addr: HubAddress, cred: Credential, networkId: string): void {
  const client = new SyncClient(addr, cred.token, cred.caPem);
  state.client = client;
  state.networkId = networkId;
  state.deviceId = cred.deviceId;
  client.on('status', () => {
    updateTray();
    settingsChanged();
  });
  client.on('hello', ({ deviceId, hubDeviceId, history, pinned, devices }) => {
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
    if (!cfg.data.paused && clip.sourceDeviceId !== state.deviceId) void applyClip(clip, true);
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

async function watchTick(): Promise<void> {
  const client = state.client;
  if (!client || client.status !== 'online' || cfg.data.paused) return;
  const files = await exclusive(async () => {
    const snap = await snapshot();
    if (!snap || !guard.isLocalChange(snap.fp)) return;
    if (snap.kind === 'files') return snap.paths; // uploaded outside the lock below
    try {
      if (snap.kind === 'text') {
        if (Buffer.byteLength(snap.text) <= MAX_TEXT_BYTES) await client.sendText(snap.text);
        else await client.sendFile(Buffer.from(snap.text), 'clipboard.txt', 'text/plain', true);
      } else if (snap.png.length <= MAX_IMAGE_BYTES) {
        await client.sendFile(snap.png, 'image.png', 'image/png');
      }
    } catch (err) {
      log(`send failed: ${String(err)}`);
    }
  });
  if (files && cfg.data.sendCopiedFiles) await sendCopiedFiles(files);
}

async function sendCopiedFiles(paths: string[]): Promise<void> {
  const stats = paths.map((p) => {
    try {
      return { p, stat: fs.statSync(p) };
    } catch {
      return null;
    }
  });
  const files = stats.filter((s): s is { p: string; stat: fs.Stats } => !!s?.stat.isFile());
  if (!files.length) return; // only folders were copied
  const total = files.reduce((n, f) => n + f.stat.size, 0);
  if (files.length > AUTO_FILES_MAX || total > AUTO_FILES_MAX_BYTES) {
    notify('OmniClip', `${files.length} files (${Math.round(total / 1048576)} MB) are too many to send automatically. Use "Send file…" in the OmniClip menu.`);
    return;
  }
  await sendPaths(files.map((f) => f.p));
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
  const dest = uniquePath(dir, clip.name ?? 'file');
  fs.writeFileSync(dest, data);
  const pasteHint = cfg.data.filesToClipboard ? ` Press ${process.platform === 'darwin' ? '⌘V' : 'Ctrl+V'} in a folder to paste it.` : '';
  notify(`File from ${clip.sourceName}`, `${path.basename(dest)} saved to ${path.basename(dir)}.${pasteHint}`, () => shell.showItemInFolder(dest));
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
    const uris = files.map((f) => `file://${encodeURI(f)}`).join('\r\n');
    await clipboard.write([new ClipboardItem({ 'text/uri-list': new Blob([uris], { type: 'text/uri-list' }) })]);
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
    await writeClipboard(() => clipboard.writeText(clip.text ?? ''), fromRemote);
  } catch (err) {
    log(`apply failed: ${String(err)}`);
  }
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

async function sendPaths(paths: string[]): Promise<void> {
  const client = state.client;
  if (!client) return;
  for (const p of paths) {
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_UPLOAD_BYTES) {
        notify('OmniClip', `${path.basename(p)} is larger than 200 MB`);
        continue;
      }
      const mime = MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
      await client.sendFile(fs.readFileSync(p), path.basename(p), mime, true);
    } catch (err) {
      notify('OmniClip', `Could not send ${path.basename(p)}: ${String(err)}`);
    }
  }
}

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
    width: 420,
    height: 640,
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
  cfg.data.credentials[res.networkId] = { token: res.token, deviceId: res.deviceId, caPem: res.caPem };
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
      return state.client?.status === 'online' ? `Connected to ${state.hubLabel} · ${onlineCount()} online` : `Reconnecting to ${state.hubLabel}…`;
    case 'unpaired':
      return `Found ${state.pending?.hub.hubName ?? 'a hub'}. Not joined yet.`;
    case 'error':
      return `Error: ${state.error}`;
  }
}

function clipLabel(c: Clip): string {
  const src = c.sourceDeviceId === state.deviceId ? 'this computer' : c.sourceName;
  if (c.kind === 'text') {
    const t = (c.text ?? '').replace(/\s+/g, ' ').trim();
    return `${t.length > 42 ? `${t.slice(0, 42)}…` : t}   (${src})`;
  }
  return `${c.kind === 'image' ? '🖼' : '📄'} ${c.name ?? c.kind}   (${src})`;
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
  settingsWin = new BrowserWindow({
    width: 560,
    height: 640,
    minWidth: 440,
    minHeight: 420,
    title: 'OmniClip Settings',
    show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  settingsWin.once('ready-to-show', () => settingsWin?.show());
  settingsWin.on('closed', () => (settingsWin = null));
  await settingsWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderSettingsPage())}${tab ? `#${tab}` : ''}`);
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
    paused: cfg.data.paused,
    sendCopiedFiles: cfg.data.sendCopiedFiles,
    filesToClipboard: cfg.data.filesToClipboard,
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    downloadDir: downloadDir(),
    update: updater.available,
    fileManager: process.platform === 'darwin' ? 'Finder' : 'Explorer',
    pasteKey: process.platform === 'darwin' ? '⌘V' : 'Ctrl+V',
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
  if (key === 'openAtLogin') app.setLoginItemSettings({ openAtLogin: on });
  else if (key === 'paused' || key === 'sendCopiedFiles' || key === 'filesToClipboard') {
    cfg.data[key] = on;
    cfg.save();
    // don't flush whatever was copied while paused
    if (key === 'paused') void snapshot(true).then((snap) => guard.prime(snap?.fp ?? null));
  } else throw new Error(`unknown setting ${key}`);
  updateTray();
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
      label: 'Send file…',
      enabled: connected,
      click: async () => {
        const res = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
        if (!res.canceled) await sendPaths(res.filePaths);
      },
    },
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
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
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

app.on('second-instance', () => void openPairWindow());
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
  guard.prime((await snapshot(true))?.fp ?? null);
  setInterval(() => void watchTick(), 500);
  await boot();
  // The tray icon can be hidden (MacBook notch, menu bar settings), so show a window on a manual launch.
  if (!app.getLoginItemSettings().wasOpenedAtLogin) await openPairWindow();
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  void (async () => {
    await teardown();
    await shutdownMdns();
    app.exit(0);
  })();
});
