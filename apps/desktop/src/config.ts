import fs from 'node:fs';
import path from 'node:path';
import type { Registry } from '@omniclip/protocol';

export interface Credential {
  token: string;
  deviceId: string;
  caPem: string;
}

export interface Config {
  deviceName: string;
  /** Pairing credentials per network (networkId -> credential). */
  credentials: Record<string, Credential>;
  /** Last registry received from a hub, used to take over if that hub disappears. */
  registry?: Registry;
  paused: boolean;
  /** Put files that arrive from other devices on the clipboard, ready to paste in Finder/Explorer. */
  filesToClipboard: boolean;
  /** Send files copied in Finder/Explorer to other devices. */
  sendCopiedFiles: boolean;
  /** Where received files are saved; defaults to Downloads/OmniClip. */
  downloadDir?: string;
}

export class ConfigStore {
  private file: string;
  data: Config;

  constructor(dir: string, defaultName: string) {
    this.file = path.join(dir, 'config.json');
    let data: Partial<Config> = {};
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Config>;
    } catch {
      // first run
    }
    this.data = { deviceName: defaultName, credentials: {}, paused: false, filesToClipboard: true, sendCopiedFiles: true, ...data };
    // Macs without a local hostname report names like "Unknown_0e:f6:95:d4:ae:a7"; use the friendly name instead
    if (/^Unknown[_-]/i.test(this.data.deviceName)) this.data.deviceName = defaultName;
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  knownNetworks(): string[] {
    return Object.keys(this.data.credentials);
  }
}
