import { describe, expect, it } from 'vitest';
import {
  BLOB_CHUNK,
  decryptBlob,
  decryptClip,
  encryptBlob,
  isEncryptedBlob,
  newKeyring,
  openJson,
  rotateKeyring,
  sealJson,
  sha256Hex,
  type Clip,
} from '../src/index';

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);

describe('end-to-end encryption', () => {
  it('round-trips a clip payload and hides it', async () => {
    const ring = newKeyring();
    const env = await sealJson(ring, { text: 'top secret', name: 'a.txt' });
    expect(atob(env.box)).not.toContain('top secret');
    expect(await openJson(ring, env)).toEqual({ text: 'top secret', name: 'a.txt' });
  });

  it('decrypts a clip into its fields and leaves plain clips alone', async () => {
    const ring = newKeyring();
    const base: Clip = { id: '1', kind: 'text', mime: 'text/plain', size: 5, hash: '', sourceDeviceId: 'd', sourceName: 'D', createdAt: 1 };
    const enc = await sealJson(ring, { text: 'hello', hash: 'abc' });
    const clip = await decryptClip({ ...base, enc }, ring);
    expect(clip.text).toBe('hello');
    expect(clip.hash).toBe('abc');
    expect(clip.enc).toBeUndefined();
    const plain = { ...base, text: 'old' };
    expect(await decryptClip(plain, ring)).toBe(plain);
  });

  it('rejects the wrong key and changed data', async () => {
    const ring = newKeyring();
    const env = await sealJson(ring, { text: 'x' });
    const other = { current: ring.current, keys: { [ring.current]: newKeyring().keys[newKeyring().current]! } };
    await expect(openJson(other, env)).rejects.toThrow();
    const raw = Uint8Array.from(atob(env.box), (c) => c.charCodeAt(0));
    raw[raw.length - 1]! ^= 1;
    await expect(openJson(ring, { ...env, box: btoa(String.fromCharCode(...raw)) })).rejects.toThrow();
  });

  it('keeps reading old clips after the key is rotated', async () => {
    const ring = newKeyring();
    const old = await sealJson(ring, { text: 'before' });
    const next = rotateKeyring(ring);
    expect(next.current).not.toBe(ring.current);
    expect(await openJson(next, old)).toEqual({ text: 'before' });
    expect((await sealJson(next, {})).kid).toBe(next.current);
  });

  it.each([0, 1, BLOB_CHUNK - 1, BLOB_CHUNK, BLOB_CHUNK * 3 + 17])('round-trips a %i-byte file', async (n) => {
    const ring = newKeyring();
    const data = bytes(n);
    const sealed = await encryptBlob(ring, data);
    expect(isEncryptedBlob(sealed)).toBe(true);
    expect(await decryptBlob(ring, sealed)).toEqual(data);
  });

  it('detects a truncated or reordered file', async () => {
    const ring = newKeyring();
    const sealed = await encryptBlob(ring, bytes(BLOB_CHUNK * 2 + 5));
    const header = 4 + 1 + ring.current.length + 8;
    // cut at a chunk boundary: the new last chunk wasn't encrypted as the last one
    await expect(decryptBlob(ring, sealed.subarray(0, header + BLOB_CHUNK + 16))).rejects.toThrow();
    const swapped = new Uint8Array(sealed);
    swapped.set(sealed.subarray(header + BLOB_CHUNK + 16, header + 2 * (BLOB_CHUNK + 16)), header);
    swapped.set(sealed.subarray(header, header + BLOB_CHUNK + 16), header + BLOB_CHUNK + 16);
    await expect(decryptBlob(ring, swapped)).rejects.toThrow();
  });

  it('hashes like node:crypto', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
