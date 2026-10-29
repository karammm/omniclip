// The end-to-end encrypted tunnel between a device and its hub through the internet relay.
// The relay only forwards opaque frames: it never sees clips, tokens or keys, can't pretend to be
// the hub, and can't replay, reorder or inject frames.
//
// Handshake (plain JSON):  device → hub  { t: 'hi', v: 1, dev, n: nonceD }
//                          hub → device  { t: 'hi', n: nonceH, p: proofH }
//                          device → hub  { t: 'ok', p: proofD }
// Keys come from HKDF-SHA256(tunnelKey, salt = nonceD | nonceH): one AES-GCM key per direction and
// one HMAC key per side for the proofs. The tunnel key is the device's own secret, handed out by
// the hub over the local network only. After the handshake every frame is AES-GCM with a counter
// nonce that both sides track, so a dropped, repeated or reordered frame fails to decrypt.
// Messages are JSON, split into fragments small enough for the relay.

import { fromBase64, toBase64 } from './e2e';

export interface TunnelLink {
  send(data: Uint8Array): void;
  close(): void;
}

export type TunnelMessage = { t: string } & Record<string, unknown>;

const enc = new TextEncoder();
const dec = new TextDecoder();
const INFO = enc.encode('omniclip-tunnel-v1');
const FRAGMENT = 256 * 1024;

const subtle = () => globalThis.crypto.subtle;
const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

interface Keys {
  d2h: CryptoKey;
  h2d: CryptoKey;
  proofHub: CryptoKey;
  proofDevice: CryptoKey;
}

async function deriveKeys(tunnelKey: string, nonceD: Uint8Array, nonceH: Uint8Array): Promise<Keys> {
  const ikm = await subtle().importKey('raw', fromBase64(tunnelKey), 'HKDF', false, ['deriveBits']);
  const bits = new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: concat(nonceD, nonceH), info: INFO }, ikm, 128 * 8));
  const aes = (b: Uint8Array) => subtle().importKey('raw', b as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const mac = (b: Uint8Array) => subtle().importKey('raw', b as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return {
    d2h: await aes(bits.subarray(0, 32)),
    h2d: await aes(bits.subarray(32, 64)),
    proofHub: await mac(bits.subarray(64, 96)),
    proofDevice: await mac(bits.subarray(96, 128)),
  };
}

async function prove(key: CryptoKey, label: string): Promise<string> {
  return toBase64(new Uint8Array(await subtle().sign('HMAC', key, enc.encode(label))));
}

async function verify(key: CryptoKey, label: string, proof: unknown): Promise<boolean> {
  if (typeof proof !== 'string') return false;
  try {
    return await subtle().verify('HMAC', key, fromBase64(proof), enc.encode(label));
  } catch {
    return false;
  }
}

/** One direction of AES-GCM frames with an implicit, strictly increasing counter. */
class Direction {
  private seq = 0n;
  constructor(private key: CryptoKey) {}

  private iv(): Uint8Array<ArrayBuffer> {
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setBigUint64(4, this.seq++);
    return iv;
  }

  async seal(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: this.iv() }, this.key, data as Uint8Array<ArrayBuffer>));
  }

  async open(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: this.iv() }, this.key, data as Uint8Array<ArrayBuffer>));
  }
}

/** Shared by both ends: ordered encrypt/decrypt, fragmenting and reassembling messages. */
abstract class TunnelPeer {
  protected out?: Direction;
  protected in?: Direction;
  private inbox: Promise<void> = Promise.resolve();
  private outbox: Promise<void> = Promise.resolve();
  private fragments: Uint8Array[] = [];
  private closed = false;
  onMessage?: (msg: TunnelMessage) => void;
  onClose?: (reason: string) => void;

  constructor(protected link: TunnelLink) {}

  get ready(): boolean {
    return !!this.out && !this.closed;
  }

  /** Feed a frame from the relay. Frames are processed one at a time, in order. */
  receive(data: Uint8Array): void {
    this.inbox = this.inbox.then(() => (this.closed ? undefined : this.handle(data))).catch((err) => this.close(`tunnel error: ${String(err?.message ?? err)}`));
  }

  private async handle(data: Uint8Array): Promise<void> {
    if (!this.in) return this.handshake(JSON.parse(dec.decode(data)) as TunnelMessage);
    const plain = await this.in.open(data);
    this.fragments.push(plain.subarray(1));
    if (plain[0] === 1) return; // more fragments follow
    const whole = concat(...this.fragments);
    this.fragments = [];
    this.onMessage?.(JSON.parse(dec.decode(whole)) as TunnelMessage);
  }

  protected abstract handshake(msg: TunnelMessage): Promise<void>;

  protected sendPlain(msg: TunnelMessage): void {
    this.link.send(enc.encode(JSON.stringify(msg)));
  }

  /** Sends an encrypted message (after the handshake). */
  send(msg: TunnelMessage): void {
    const out = this.out;
    if (!out || this.closed) return;
    const bytes = enc.encode(JSON.stringify(msg));
    this.outbox = this.outbox
      .then(async () => {
        for (let at = 0; at < bytes.length || at === 0; at += FRAGMENT) {
          const part = bytes.subarray(at, at + FRAGMENT);
          const more = at + FRAGMENT < bytes.length;
          if (this.closed) return;
          this.link.send(await out.seal(concat(new Uint8Array([more ? 1 : 0]), part)));
          if (!more) break;
        }
      })
      .catch((err) => this.close(`tunnel error: ${String(err?.message ?? err)}`));
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.link.close();
    this.onClose?.(reason);
  }
}

/** The hub's end of one device's tunnel. `keyFor` returns the device's tunnel key, if it has one. */
export class TunnelServer extends TunnelPeer {
  deviceId = '';
  private pending?: { keys: Keys };
  onReady?: () => void;

  constructor(
    link: TunnelLink,
    private keyFor: (deviceId: string) => string | undefined,
  ) {
    super(link);
  }

  protected async handshake(msg: TunnelMessage): Promise<void> {
    if (!this.pending) {
      const key = typeof msg.dev === 'string' ? this.keyFor(msg.dev) : undefined;
      if (msg.t !== 'hi' || msg.v !== 1 || typeof msg.n !== 'string' || !key) return this.close('unknown device');
      const nonceH = random(16);
      const keys = await deriveKeys(key, fromBase64(msg.n), nonceH);
      this.deviceId = msg.dev as string;
      this.pending = { keys };
      this.sendPlain({ t: 'hi', n: toBase64(nonceH), p: await prove(keys.proofHub, 'hub') });
      return;
    }
    const { keys } = this.pending;
    if (msg.t !== 'ok' || !(await verify(keys.proofDevice, 'device', msg.p))) return this.close('device proof failed');
    this.in = new Direction(keys.d2h);
    this.out = new Direction(keys.h2d);
    this.onReady?.();
  }
}

/** A device's end of the tunnel. `start()` resolves once the hub has proven it knows the tunnel key. */
export class TunnelClient extends TunnelPeer {
  private nonceD = random(16);
  private settle?: { resolve: () => void; reject: (err: Error) => void };

  constructor(
    link: TunnelLink,
    private deviceId: string,
    private tunnelKey: string,
  ) {
    super(link);
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.settle = { resolve, reject };
      const prevClose = this.onClose;
      this.onClose = (reason) => {
        this.settle?.reject(new Error(reason));
        this.settle = undefined;
        prevClose?.(reason);
      };
      this.sendPlain({ t: 'hi', v: 1, dev: this.deviceId, n: toBase64(this.nonceD) });
    });
  }

  protected async handshake(msg: TunnelMessage): Promise<void> {
    if (msg.t !== 'hi' || typeof msg.n !== 'string') return this.close('bad handshake');
    const keys = await deriveKeys(this.tunnelKey, this.nonceD, fromBase64(msg.n));
    // only the real hub knows this device's tunnel key
    if (!(await verify(keys.proofHub, 'hub', msg.p))) return this.close('the relay answered, but not your hub');
    this.out = new Direction(keys.d2h);
    this.in = new Direction(keys.h2d);
    this.sendPlain({ t: 'ok', p: await prove(keys.proofDevice, 'device') });
    this.settle?.resolve();
    this.settle = undefined;
  }
}
