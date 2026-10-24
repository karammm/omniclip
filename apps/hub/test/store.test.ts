import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Clip } from '@omniclip/protocol';
import { Store, hashToken } from '../src/store.js';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'omniclip-store-'));
  dirs.push(d);
  return d;
}
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function fileClip(store: Store, size: number): Clip {
  const id = crypto.randomUUID();
  fs.writeFileSync(store.blobPath(id), Buffer.alloc(size));
  return { id, kind: 'file', mime: 'application/octet-stream', size, hash: id, sourceDeviceId: 'd', sourceName: 'x', createdAt: Date.now() };
}

function textClip(text: string): Clip {
  return { id: crypto.randomUUID(), kind: 'text', text, mime: 'text/plain', size: text.length, hash: text, sourceDeviceId: 'd', sourceName: 'x', createdAt: Date.now() };
}

describe('Store', () => {
  it('caps history and keeps newest first', () => {
    const store = new Store(tmp(), undefined, { historyLimit: 3 });
    for (let i = 0; i < 5; i++) store.addClip(textClip(`t${i}`));
    expect(store.clips().map((c) => c.text)).toEqual(['t4', 't3', 't2']);
  });

  it('prunes oldest blobs over the byte budget and deletes their files', () => {
    const store = new Store(tmp(), undefined, { blobBudgetBytes: 100 });
    const a = fileClip(store, 60);
    const b = fileClip(store, 60);
    store.addClip(a);
    const pruned = store.addClip(b);
    expect(pruned).toEqual([a.id]);
    expect(fs.existsSync(store.blobPath(a.id))).toBe(false);
    expect(store.clips().map((c) => c.id)).toEqual([b.id]);
  });

  it('persists devices and finds them by token', () => {
    const dir = tmp();
    const store = new Store(dir);
    store.addDevice({ id: 'dev1', name: 'Phone', platform: 'ios', createdAt: 1, lastSeen: 1, tokenHash: hashToken('secret') });
    const reopened = new Store(dir);
    expect(reopened.networkId).toBe(store.networkId);
    expect(reopened.deviceByToken('secret')?.id).toBe('dev1');
    expect(reopened.deviceByToken('wrong')).toBeUndefined();
  });

  it('adopts a seeded network on takeover', () => {
    const store = new Store(tmp(), { networkId: 'net-1', devices: [{ id: 'd', name: 'Win', platform: 'windows', createdAt: 1, lastSeen: 1, tokenHash: hashToken('t') }] });
    expect(store.networkId).toBe('net-1');
    expect(store.deviceByToken('t')?.name).toBe('Win');
  });

  it('rejects path traversal in blob ids', () => {
    const store = new Store(tmp());
    expect(() => store.blobPath('../../etc/passwd')).toThrow();
  });
});
