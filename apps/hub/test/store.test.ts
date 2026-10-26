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

  it('never prunes pinned clips, and they do not count towards the limits', () => {
    const store = new Store(tmp(), undefined, { historyLimit: 2, blobBudgetBytes: 100 });
    const keep = textClip('keep me');
    store.addClip(keep);
    store.setPinned(keep.id, true);
    const big = fileClip(store, 90);
    store.addClip(big);
    store.setPinned(big.id, true);
    for (let i = 0; i < 4; i++) store.addClip(textClip(`t${i}`));
    store.addClip(fileClip(store, 60)); // would exceed the budget if the pinned file counted
    expect(store.clip(keep.id)?.pinned).toBe(true);
    expect(fs.existsSync(store.blobPath(big.id))).toBe(true);
    expect(store.pinnedClips().map((c) => c.id).sort()).toEqual([keep.id, big.id].sort());
    expect(store.clips().filter((c) => !c.pinned)).toHaveLength(2);
    store.setPinned(keep.id, false);
    expect(store.clip(keep.id)?.pinned).toBeUndefined();
  });

  it('searches text and file names, case-insensitively', () => {
    const store = new Store(tmp());
    store.addClip(textClip('Meeting at 3pm'));
    store.addClip({ ...fileClip(store, 1), name: 'Invoice-March.pdf' });
    store.addClip(textClip('groceries'));
    expect(store.search('meeting').map((c) => c.text)).toEqual(['Meeting at 3pm']);
    expect(store.search('INVOICE').map((c) => c.name)).toEqual(['Invoice-March.pdf']);
    expect(store.search('nothing')).toEqual([]);
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
