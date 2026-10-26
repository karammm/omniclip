import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BLOB_BUDGET_BYTES, HISTORY_LIMIT, type Clip, type DeviceRecord } from '@omniclip/protocol';

interface StoreData {
  networkId: string;
  devices: DeviceRecord[];
  clips: Clip[];
}

export interface StoreLimits {
  historyLimit: number;
  blobBudgetBytes: number;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Small JSON-file store. History is capped at a few hundred clips, so a single file
 * rewritten atomically is plenty and avoids native modules in the Electron build.
 */
export class Store {
  readonly blobDir: string;
  private file: string;
  private data: StoreData;
  private limits: StoreLimits;

  constructor(dir: string, seed?: { networkId: string; devices: DeviceRecord[] }, limits?: Partial<StoreLimits>) {
    this.limits = { historyLimit: HISTORY_LIMIT, blobBudgetBytes: BLOB_BUDGET_BYTES, ...limits };
    this.file = path.join(dir, 'store.json');
    this.blobDir = path.join(dir, 'blobs');
    fs.mkdirSync(this.blobDir, { recursive: true });

    let data: StoreData | null = null;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as StoreData;
    } catch {
      data = null;
    }
    if (seed && (!data || data.networkId !== seed.networkId)) {
      // Taking over a network from a previous hub: adopt its identity and devices.
      data = { networkId: seed.networkId, devices: seed.devices, clips: [] };
    } else if (seed && data) {
      const known = new Map(data.devices.map((d) => [d.id, d]));
      for (const d of seed.devices) known.set(d.id, d);
      data.devices = [...known.values()];
    }
    this.data = data ?? { networkId: crypto.randomUUID(), devices: [], clips: [] };
    this.save();
  }

  get networkId(): string {
    return this.data.networkId;
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  // ---- devices ----

  devices(): DeviceRecord[] {
    return [...this.data.devices];
  }

  deviceByToken(token: string): DeviceRecord | undefined {
    const h = hashToken(token);
    return this.data.devices.find((d) => d.tokenHash === h);
  }

  addDevice(device: DeviceRecord): void {
    this.data.devices.push(device);
    this.save();
  }

  renameDevice(id: string, name: string): DeviceRecord | undefined {
    const d = this.data.devices.find((x) => x.id === id);
    if (!d) return undefined;
    d.name = name;
    this.save();
    return d;
  }

  touchDevice(id: string): void {
    const d = this.data.devices.find((x) => x.id === id);
    if (d) {
      d.lastSeen = Date.now();
      this.save();
    }
  }

  removeDevice(id: string): boolean {
    const before = this.data.devices.length;
    this.data.devices = this.data.devices.filter((d) => d.id !== id);
    if (this.data.devices.length === before) return false;
    this.save();
    return true;
  }

  // ---- clips ----

  clips(limit = this.limits.historyLimit): Clip[] {
    return this.data.clips.slice(0, limit);
  }

  clip(id: string): Clip | undefined {
    return this.data.clips.find((c) => c.id === id);
  }

  pinnedClips(): Clip[] {
    return this.data.clips.filter((c) => c.pinned);
  }

  /** Case-insensitive search over text and file names, newest first. */
  search(query: string, limit = this.limits.historyLimit): Clip[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.clips(limit);
    return this.data.clips.filter((c) => (c.text ?? '').toLowerCase().includes(q) || (c.name ?? '').toLowerCase().includes(q)).slice(0, limit);
  }

  setPinned(id: string, pinned: boolean): Clip | undefined {
    const c = this.clip(id);
    if (!c) return undefined;
    if (pinned) c.pinned = true;
    else delete c.pinned;
    this.save();
    return c;
  }

  blobPath(id: string): string {
    // ids are server-generated UUIDs; reject anything else to keep paths inside blobDir
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('bad clip id');
    return path.join(this.blobDir, id);
  }

  /** Adds a clip (newest first) and prunes history/blobs. Returns ids that were pruned. */
  addClip(clip: Clip): string[] {
    this.data.clips.unshift(clip);
    const pruned = this.prune();
    this.save();
    return pruned;
  }

  private prune(): string[] {
    // pinned clips don't count towards either limit and are never removed
    const removed: Clip[] = [];
    let unpinned = 0;
    let blobBytes = 0;
    const keep: Clip[] = [];
    for (const c of this.data.clips) {
      if (c.pinned) {
        keep.push(c);
        continue;
      }
      if (++unpinned > this.limits.historyLimit) {
        removed.push(c);
        continue;
      }
      if (c.kind === 'text') {
        keep.push(c);
        continue;
      }
      // the newest clip is always kept, even if it alone exceeds the budget
      if (unpinned > 1 && blobBytes + c.size > this.limits.blobBudgetBytes) {
        removed.push(c);
        continue;
      }
      blobBytes += c.size;
      keep.push(c);
    }
    this.data.clips = keep;
    for (const c of removed) {
      if (c.kind !== 'text') fs.rmSync(this.blobPath(c.id), { force: true });
    }
    return removed.map((c) => c.id);
  }
}
