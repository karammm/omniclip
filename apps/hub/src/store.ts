import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable, Writable } from 'node:stream';
import { BLOB_BUDGET_BYTES, HISTORY_LIMIT, type Clip, type DeviceRecord } from '@omniclip/protocol';
import { isSealedFile, openBlob, seal, sealStream, unseal } from './seal.js';

interface StoreData {
  networkId: string;
  devices: DeviceRecord[];
  clips: Clip[];
}

/** On disk, clips are replaced by `sealed` (encrypted JSON) when a history key is set. */
type StoreFile = Omit<StoreData, 'clips'> & { clips?: Clip[]; sealed?: string };

export interface StoreLimits {
  historyLimit: number;
  blobBudgetBytes: number;
}

/** Clips sent to one device are only visible to that device and the sender. */
export function visibleTo(clip: Clip, deviceId?: string): boolean {
  return !deviceId || !clip.targetDeviceId || clip.targetDeviceId === deviceId || clip.sourceDeviceId === deviceId;
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
  /** History couldn't be decrypted (the key changed or is missing) and was started over. */
  readonly historyLost: boolean = false;

  /** With `key` (32 bytes), clips and files are encrypted on disk. */
  constructor(
    dir: string,
    seed?: { networkId: string; devices: DeviceRecord[] },
    limits?: Partial<StoreLimits>,
    private readonly key?: Buffer,
  ) {
    if (key && key.length !== 32) throw new Error('history key must be 32 bytes');
    this.limits = { historyLimit: HISTORY_LIMIT, blobBudgetBytes: BLOB_BUDGET_BYTES, ...limits };
    this.file = path.join(dir, 'store.json');
    this.blobDir = path.join(dir, 'blobs');
    fs.mkdirSync(this.blobDir, { recursive: true });

    let data: StoreData | null = null;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as StoreFile;
      let clips = raw.clips ?? [];
      if (raw.sealed) {
        try {
          if (!key) throw new Error('no key');
          clips = JSON.parse(unseal(key, raw.sealed).toString('utf8')) as Clip[];
        } catch {
          clips = [];
          this.historyLost = true;
        }
      }
      data = { networkId: raw.networkId, devices: raw.devices, clips };
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
    this.removeOrphanBlobs();
    this.save();
  }

  get networkId(): string {
    return this.data.networkId;
  }

  /** Whether clips and files are encrypted on disk. */
  get encrypted(): boolean {
    return !!this.key;
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    // passwords and codes stay in memory only
    const clips = this.data.clips.filter((c) => !c.sensitive);
    const { networkId, devices } = this.data;
    const out: StoreFile = this.key ? { networkId, devices, sealed: seal(this.key, Buffer.from(JSON.stringify(clips))) } : { networkId, devices, clips };
    fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Deletes blob files no clip refers to (left over from a crash, or history that couldn't be decrypted). */
  private removeOrphanBlobs(): void {
    const known = new Set(this.data.clips.filter((c) => c.kind !== 'text').map((c) => c.id));
    for (const name of fs.readdirSync(this.blobDir)) {
      if (!known.has(name)) fs.rmSync(path.join(this.blobDir, name), { force: true });
    }
  }

  /** Streams to pipe a new blob into (encrypting it when a key is set). */
  blobSink(id: string): [Writable] | [Writable, Writable] {
    const file = fs.createWriteStream(this.blobPath(id), { mode: 0o600 });
    return this.key ? [sealStream(this.key), file] : [file];
  }

  /** The blob's plaintext. */
  openBlob(id: string): Readable {
    return openBlob(this.blobPath(id), this.key);
  }

  /** Encrypts files saved before encryption was turned on. Returns how many were converted. */
  async encryptExistingBlobs(): Promise<number> {
    if (!this.key) return 0;
    let n = 0;
    for (const c of this.data.clips) {
      if (c.kind === 'text') continue;
      const file = this.blobPath(c.id);
      if (!fs.existsSync(file) || isSealedFile(file)) continue;
      const tmp = `${file}.tmp`;
      try {
        await pipeline(fs.createReadStream(file), sealStream(this.key), fs.createWriteStream(tmp, { mode: 0o600 }));
        // the clip may have been pruned meanwhile
        if (fs.existsSync(file)) fs.renameSync(tmp, file);
        else fs.rmSync(tmp, { force: true });
        n++;
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
    }
    return n;
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

  /** Newest first. With `viewer`, only the clips that device may see. */
  clips(limit = this.limits.historyLimit, viewer?: string): Clip[] {
    return this.data.clips.filter((c) => visibleTo(c, viewer)).slice(0, limit);
  }

  clip(id: string, viewer?: string): Clip | undefined {
    const c = this.data.clips.find((x) => x.id === id);
    return c && visibleTo(c, viewer) ? c : undefined;
  }

  pinnedClips(viewer?: string): Clip[] {
    return this.data.clips.filter((c) => c.pinned && visibleTo(c, viewer));
  }

  /** Case-insensitive search over text and file names, newest first. Sensitive clips never match. */
  search(query: string, limit = this.limits.historyLimit, viewer?: string): Clip[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.clips(limit, viewer);
    return this.data.clips
      .filter((c) => visibleTo(c, viewer) && !c.sensitive && ((c.text ?? '').toLowerCase().includes(q) || (c.name ?? '').toLowerCase().includes(q)))
      .slice(0, limit);
  }

  removeClip(id: string): Clip | undefined {
    const c = this.clip(id);
    if (!c) return undefined;
    this.data.clips = this.data.clips.filter((x) => x.id !== id);
    if (c.kind !== 'text') fs.rmSync(this.blobPath(c.id), { force: true });
    if (!c.sensitive) this.save();
    return c;
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
    if (!clip.sensitive || pruned.length) this.save();
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
