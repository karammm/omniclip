import { EventEmitter } from 'node:events';
import path from 'node:path';
import { app, net, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { isNewer } from './version.js';

const REPO = 'karammm/omniclip';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export interface UpdateInfo {
  version: string;
  /** Windows .exe installs download in the background; everything else links to the release page. */
  ready: boolean;
  url: string;
}

/**
 * Background installs only work for the per-user Windows installer (.exe); macOS needs a signed app
 * and MSI installs are managed by IT. Those get a notification with a download link instead.
 */
function canAutoInstall(): boolean {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return false;
  return path.resolve(process.execPath).toLowerCase().startsWith(path.resolve(process.env.LOCALAPPDATA).toLowerCase());
}

export class Updater extends EventEmitter<{ available: [UpdateInfo] }> {
  available: UpdateInfo | null = null;
  private timer?: NodeJS.Timeout;
  private readonly auto = canAutoInstall();

  constructor(private log: (msg: string) => void) {
    super();
    if (this.auto) {
      const { autoUpdater } = electronUpdater;
      autoUpdater.autoDownload = true;
      autoUpdater.on('update-downloaded', (info) => this.found({ version: info.version, ready: true, url: releaseUrl(info.version) }));
      autoUpdater.on('error', (err) => this.log(`auto-update failed: ${String(err)}`));
    }
  }

  start(): void {
    if (!app.isPackaged) return;
    setTimeout(() => void this.check(), 30_000);
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async check(): Promise<UpdateInfo | null> {
    try {
      if (this.auto) {
        await electronUpdater.autoUpdater.checkForUpdates();
        return this.available;
      }
      const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'OmniClip' },
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const release = (await res.json()) as { tag_name: string; html_url: string };
      if (isNewer(release.tag_name, app.getVersion())) this.found({ version: release.tag_name.replace(/^v/, ''), ready: false, url: release.html_url });
    } catch (err) {
      this.log(`update check failed: ${String(err)}`);
    }
    return this.available;
  }

  /** Restarts into the downloaded update, or opens the download page. */
  install(): void {
    if (!this.available) return;
    if (this.available.ready) electronUpdater.autoUpdater.quitAndInstall();
    else void shell.openExternal(this.available.url);
  }

  private found(info: UpdateInfo): void {
    const isNew = this.available?.version !== info.version || this.available.ready !== info.ready;
    this.available = info;
    if (isNew) {
      this.log(`update available: ${info.version}${info.ready ? ' (downloaded)' : ''}`);
      this.emit('available', info);
    }
  }
}

function releaseUrl(version: string): string {
  return `https://github.com/${REPO}/releases/tag/v${version}`;
}
