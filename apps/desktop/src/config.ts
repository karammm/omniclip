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
    this.data = { deviceName: defaultName, credentials: {}, paused: false, ...data };
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
