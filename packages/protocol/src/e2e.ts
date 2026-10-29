// End-to-end encryption of clips, with WebCrypto so the same code runs in Node, Electron, browsers
// and the phone apps' WebView. Every paired device holds the network keyring; the hub stores and
// forwards ciphertext. The Swift share extension implements the same formats with CryptoKit.
//
// Text and metadata: AES-256-GCM over JSON, as `{ v: 1, kid, box }` where box = base64(iv | ct | tag).
// Files: "OCB1" | kid length (1 byte) | kid | nonce prefix (8 bytes) | chunks, each chunk being
// AES-GCM of up to 64 KiB with nonce = prefix | counter (u32 BE) and AAD "ocb1" + a last-chunk flag,
// so reordering, dropping or truncating chunks fails to decrypt.

/** `current` encrypts new clips; older keys stay so earlier history can still be read. */
export interface Keyring {
  current: string;
  keys: Record<string, string>;
}

export interface Envelope {
  v: 1;
  kid: string;
  box: string;
}

/** The parts of a clip that only paired devices can read. */
export interface ClipPayload {
  text?: string;
  html?: string;
  rtf?: string;
  name?: string;
  mime?: string;
  hash?: string;
}

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('end-to-end encryption needs a secure context (HTTPS)');
  return s;
};

/** WebCrypto is only available on HTTPS pages (and in Node/Electron). */
export function e2eAvailable(): boolean {
  return !!globalThis.crypto?.subtle;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const CLIP_AAD = enc.encode('omniclip-clip-v1');
const MAGIC = enc.encode('OCB1');
export const BLOB_CHUNK = 64 * 1024;
const TAG = 16;

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function random(n: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function newKeyring(): Keyring {
  const kid = hex(random(4));
  return { current: kid, keys: { [kid]: toBase64(random(32)) } };
}

/** Adds a fresh key and makes it current (after a device is removed). */
export function rotateKeyring(ring: Keyring): Keyring {
  const next = newKeyring();
  return { current: next.current, keys: { ...ring.keys, ...next.keys } };
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function cryptoKey(ring: Keyring, kid: string): Promise<CryptoKey> {
  const raw = ring.keys[kid];
  if (!raw) return Promise.reject(new Error(`unknown key ${kid}`));
  let key = keyCache.get(raw);
  if (!key) {
    key = subtle().importKey('raw', fromBase64(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
    keyCache.set(raw, key);
  }
  return key;
}

export async function sealJson(ring: Keyring, value: unknown): Promise<Envelope> {
  const iv = random(12);
  const key = await cryptoKey(ring, ring.current);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: CLIP_AAD }, key, enc.encode(JSON.stringify(value))));
  // WebCrypto returns ciphertext | tag; stored as iv | ciphertext | tag
  const box = new Uint8Array(12 + ct.length);
  box.set(iv);
  box.set(ct, 12);
  return { v: 1, kid: ring.current, box: toBase64(box) };
}

/** Throws if the key is missing or the data was changed. */
export async function openJson<T>(ring: Keyring, env: Envelope): Promise<T> {
  const raw = fromBase64(env.box);
  const key = await cryptoKey(ring, env.kid);
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: CLIP_AAD }, key, raw.subarray(12));
  return JSON.parse(dec.decode(pt)) as T;
}

/** sha256 of text or bytes, as hex; devices compare it to skip their own echoes. */
export async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(new Uint8Array(await subtle().digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data)));
}

/** Replaces an encrypted clip's envelope with its contents. Clips without one pass through. */
export async function decryptClip<C extends { enc?: Envelope; hash: string }>(clip: C, ring: Keyring | undefined): Promise<C> {
  if (!clip.enc) return clip;
  if (!ring) throw new Error('this clip is end-to-end encrypted and this device has no key');
  const payload = await openJson<ClipPayload>(ring, clip.enc);
  const { enc: _e, ...rest } = clip;
  return { ...rest, ...payload, hash: payload.hash ?? '' } as C;
}

export function isEncryptedBlob(data: Uint8Array): boolean {
  return data.length >= MAGIC.length && MAGIC.every((b, i) => data[i] === b);
}

function chunkNonce(prefix: Uint8Array, counter: number): Uint8Array<ArrayBuffer> {
  const n = new Uint8Array(12);
  n.set(prefix);
  new DataView(n.buffer).setUint32(8, counter);
  return n;
}

function chunkAad(last: boolean): Uint8Array<ArrayBuffer> {
  return new Uint8Array([...enc.encode('ocb1'), last ? 1 : 0]);
}

export async function encryptBlob(ring: Keyring, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const key = await cryptoKey(ring, ring.current);
  const kid = enc.encode(ring.current);
  const prefix = random(8);
  const chunks = Math.max(1, Math.ceil(data.length / BLOB_CHUNK));
  const headerLen = MAGIC.length + 1 + kid.length + prefix.length;
  const out = new Uint8Array(headerLen + data.length + chunks * TAG);
  out.set(MAGIC);
  out[MAGIC.length] = kid.length;
  out.set(kid, MAGIC.length + 1);
  out.set(prefix, MAGIC.length + 1 + kid.length);
  let offset = headerLen;
  for (let i = 0; i < chunks; i++) {
    const part = data.subarray(i * BLOB_CHUNK, (i + 1) * BLOB_CHUNK);
    const ct = new Uint8Array(
      await subtle().encrypt({ name: 'AES-GCM', iv: chunkNonce(prefix, i), additionalData: chunkAad(i === chunks - 1) }, key, part as Uint8Array<ArrayBuffer>),
    );
    out.set(ct, offset);
    offset += ct.length;
  }
  return out;
}

export async function decryptBlob(ring: Keyring, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (!isEncryptedBlob(data)) throw new Error('not an encrypted file');
  const kidLen = data[MAGIC.length]!;
  const kid = dec.decode(data.subarray(MAGIC.length + 1, MAGIC.length + 1 + kidLen));
  const key = await cryptoKey(ring, kid);
  let offset = MAGIC.length + 1 + kidLen;
  const prefix = data.subarray(offset, offset + 8);
  offset += 8;
  const parts: Uint8Array[] = [];
  let size = 0;
  for (let i = 0; offset < data.length; i++) {
    const len = Math.min(BLOB_CHUNK + TAG, data.length - offset);
    const last = offset + len === data.length;
    const pt = new Uint8Array(
      await subtle().decrypt({ name: 'AES-GCM', iv: chunkNonce(prefix, i), additionalData: chunkAad(last) }, key, data.subarray(offset, offset + len) as Uint8Array<ArrayBuffer>),
    );
    parts.push(pt);
    size += pt.length;
    offset += len;
  }
  if (!parts.length) throw new Error('encrypted file is truncated');
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
