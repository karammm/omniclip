import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';

// History encryption at rest: AES-256-GCM with a key the desktop keeps in the OS keychain.
// Blobs are laid out as MAGIC | iv | ciphertext | tag, so plaintext blobs from older versions are told apart.

const MAGIC = Buffer.from('OCE\u0001');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES;

export function seal(key: Buffer, data: Buffer): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

/** Throws if the key is wrong or the data was tampered with. */
export function unseal(key: Buffer, sealed: string): Buffer {
  const raw = Buffer.from(sealed, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}

/** Transform that encrypts a blob as it is written. */
export function sealStream(key: Buffer): Transform {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let started = false;
  const header = (t: Transform) => {
    if (!started) t.push(Buffer.concat([MAGIC, iv]));
    started = true;
  };
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      header(this);
      cb(null, cipher.update(chunk));
    },
    flush(cb) {
      header(this);
      this.push(cipher.final());
      this.push(cipher.getAuthTag());
      cb();
    },
  });
}

export function isSealedFile(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(MAGIC.length);
    return fs.readSync(fd, head, 0, MAGIC.length, 0) === MAGIC.length && head.equals(MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

/** Streams a blob back as plaintext, decrypting it if it was stored encrypted. */
export function openBlob(file: string, key: Buffer | undefined): Readable {
  if (!isSealedFile(file)) return fs.createReadStream(file);
  if (!key) throw new Error('this file is encrypted and the history key is not available');
  const { size } = fs.statSync(file);
  if (size < HEADER_BYTES + TAG_BYTES) throw new Error('encrypted file is truncated');
  const fd = fs.openSync(file, 'r');
  const iv = Buffer.alloc(IV_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    fs.readSync(fd, iv, 0, IV_BYTES, MAGIC.length);
    fs.readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    fs.closeSync(fd);
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const body = size - TAG_BYTES > HEADER_BYTES ? fs.createReadStream(file, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 }) : Readable.from([]);
  body.on('error', (err: Error) => decipher.destroy(err));
  return body.pipe(decipher);
}
