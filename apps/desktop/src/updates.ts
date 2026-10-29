import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { app, net, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { isNewer } from './version.js';

const REPO = 'karammm/omniclip';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export interface UpdateInfo {
  version: string;
  /** Signed Mac apps, Windows .exe and Linux AppImage installs download in the background; everything else links to the release page. */
  ready: boolean;
  url: string;
}

/**
 * Background installs work for a Developer ID–signed Mac app, the per-user Windows installer (.exe)
 * and the Linux AppImage. Unsigned Mac builds can't replace themselves, and MSI and .deb installs are
 * managed by the system; those get a notification with a download link instead.
 */
async function canAutoInstall(): Promise<boolean> {
  if (process.platform === 'darwin') return isDeveloperIdSigned();
  if (process.platform === 'linux') return !!process.env.APPIMAGE;
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return false;
  return path.resolve(process.execPath).toLowerCase().startsWith(path.resolve(process.env.LOCALAPPDATA).toLowerCase());
}

/** True when this .app is signed with a Developer ID certificate (not ad-hoc), which the macOS updater requires. */
function isDeveloperIdSigned(): Promise<boolean> {
  const bundle = path.resolve(process.execPath, '../../..');
  return new Promise((resolve) =>
    execFile('codesign', ['-dv', '--verbose=2', bundle], { timeout: 5000 }, (err, _out, details) =>
      resolve(!err && /^Authority=Developer ID Application:/m.test(String(details))),
    ),
  );
}

export class Updater extends EventEmitter<{ available: [UpdateInfo] }> {
  available: UpdateInfo | null = null;
  private timer?: NodeJS.Timeout;
  private auto = false;
  private readonly ready: Promise<void>;

  constructor(private log: (msg: string) => void) {
    super();
    this.ready = (app.isPackaged ? canAutoInstall() : Promise.resolve(false)).then((auto) => {
      this.auto = auto;
      if (!auto) return;
      const { autoUpdater } = electronUpdater;
      autoUpdater.autoDownload = true;
      autoUpdater.on('update-downloaded', (info) => this.found({ version: info.version, ready: true, url: releaseUrl(info.version) }));
      autoUpdater.on('error', (err) => this.log(`auto-update failed: ${String(err)}`));
    });
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
      await this.ready;
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
