import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import WebSocket from 'ws';
import {
  E2E_HEADER,
  RelayConnection,
  decryptBlob,
  decryptClip,
  detectSensitive,
  encryptBlob,
  isEncryptedBlob,
  parseServerMessage,
  sealJson,
  type Clip,
  type ClipPayload,
  type Device,
  type Keyring,
  type PairResponse,
  type Platform,
  type Registry,
  type RelayConfig,
  type ServerMessage,
  type Snippet,
  type SnippetPayload,
  type WebSocketCtor,
} from '@omniclip/protocol';

export interface HubAddress {
  host: string;
  port: number;
}

interface RequestOpts {
  method?: string;
  headers?: Record<string, string | number>;
  body?: Buffer | string;
  ca?: string;
  /** Only for the initial pairing call, before we know the hub's CA. */
  insecure?: boolean;
}

function request(addr: HubAddress, path: string, opts: RequestOpts = {}): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: addr.host,
        port: addr.port,
        path,
        method: opts.method ?? 'GET',
        headers: opts.headers,
        ca: opts.ca,
        rejectUnauthorized: !opts.insecure,
        timeout: 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** Finds the first address of a discovered hub that answers. */
export async function probe(addresses: string[], port: number): Promise<HubAddress | null> {
  for (const host of addresses) {
    try {
      const res = await request({ host, port }, '/api/info', { insecure: true });
      if (res.status === 200 && JSON.parse(res.body.toString()).app === 'omniclip') return { host, port };
    } catch {
      // try next address
    }
  }
  return null;
}

export async function pairWithHub(addr: HubAddress, code: string, name: string, platform: Platform): Promise<PairResponse> {
  const res = await request(addr, '/api/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name, platform }),
    insecure: true,
  });
  const body = JSON.parse(res.body.toString() || '{}');
  if (res.status !== 200) throw new Error(body.error ?? `pairing failed (${res.status})`);
  const pairRes = body as PairResponse;
  // From here on every connection verifies the hub against the CA it just gave us.
  const check = await request(addr, '/api/me', { ca: pairRes.caPem, headers: { authorization: `Bearer ${pairRes.token}` } });
  if (check.status !== 200) throw new Error('hub certificate did not match');
  return pairRes;
}

export interface SendOptions {
  /** Device id to send to; everyone when omitted. */
  to?: string;
  /** Force (true) or skip (false) the hub's password detection. */
  sensitive?: boolean;
  /** The upload is a zipped folder. */
  folder?: boolean;
}

function clipsPath(opts: SendOptions = {}): string {
  const q = new URLSearchParams();
  if (opts.to) q.set('to', opts.to);
  if (opts.sensitive !== undefined) q.set('sensitive', opts.sensitive ? '1' : '0');
  const qs = q.toString();
  return qs ? `/api/clips?${qs}` : '/api/clips';
}

export type ClientStatus = 'connecting' | 'online' | 'offline';

/** A snippet with its contents decrypted. */
export type PlainSnippet = Snippet & SnippetPayload;

/** What a device keeps for end-to-end encryption and the relay; saved with its credential. */
export interface E2EState {
  keys?: Keyring;
  tunnelKey?: string;
  relay?: RelayConfig;
}

/** How long the hub must be unreachable on the local network before trying the relay. */
const RELAY_AFTER_MS = 8000;
/** While on the relay, how often to check whether the hub is reachable directly again. */
const LAN_PROBE_MS = 30_000;

export interface SyncClientEvents {
  status: [ClientStatus];
  hello: [{ deviceId: string; hubDeviceId: string; history: Clip[]; pinned: Clip[]; devices: Device[]; snippets: PlainSnippet[] }];
  /** The keyring, tunnel key or relay changed; save them with the credential. */
  e2e: [E2EState];
  snippets: [PlainSnippet[]];
  clip: [Clip];
  clipUpdate: [Clip];
  clipRemove: [string];
  devices: [Device[]];
  registry: [Registry];
  revoked: [];
}

/** Connection from a desktop to the hub (also used by the hub's own desktop, over loopback). */
export class SyncClient extends EventEmitter<SyncClientEvents> {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retry?: NodeJS.Timeout;
  private ping?: NodeJS.Timeout;
  private delay = 500;
  status: ClientStatus = 'connecting';
  /** When the connection was last healthy; used to decide when to take over as hub. */
  lastOnline = Date.now();
  /** Incoming messages are decrypted one at a time, so they're handled in the order they arrived. */
  private inbox: Promise<void> = Promise.resolve();
  /** Connected through the internet relay instead of directly. */
  private relay?: RelayConnection;
  private mode: 'lan' | 'relay';
  private offlineSince = Date.now();
  private lanProbe?: NodeJS.Timeout;

  constructor(
    readonly addr: HubAddress,
    private token: string,
    private caPem: string,
    /** Without a keyring (a hub older than v0.8) clips travel as plain text over TLS, as before. */
    readonly e2e: E2EState = {},
    /** Needed for the relay: which network and device this is. `viaRelay`: start on the relay. */
    private ids: { networkId?: string; deviceId?: string; viaRelay?: boolean } = {},
  ) {
    super();
    this.mode = ids.viaRelay && this.canRelay ? 'relay' : 'lan';
  }

  /** How the hub is reached right now. */
  get via(): 'lan' | 'relay' {
    return this.relay ? 'relay' : 'lan';
  }

  /** Whether this device can fall back to the relay (a relay is set up and it has its tunnel key). */
  get canRelay(): boolean {
    return !!(this.e2e.relay && this.e2e.tunnelKey && this.e2e.keys && this.ids.networkId && this.ids.deviceId);
  }

  get keys(): Keyring | undefined {
    return this.e2e.keys;
  }

  private async decrypt(clip: Clip): Promise<Clip | null> {
    try {
      return await decryptClip(clip, this.e2e.keys);
    } catch {
      return null;
    }
  }

  private async decryptAll(clips: Clip[]): Promise<Clip[]> {
    return (await Promise.all(clips.map((c) => this.decrypt(c)))).filter((c): c is Clip => !!c);
  }

  private async decryptSnippets(snippets: Snippet[]): Promise<PlainSnippet[]> {
    const out = await Promise.all(
      snippets.map((s) =>
        decryptClip({ ...s, hash: '' }, this.e2e.keys).then(
          ({ hash: _h, ...rest }) => rest as PlainSnippet,
          () => null,
        ),
      ),
    );
    return out.filter((s): s is PlainSnippet => !!s && !!s.text);
  }

  private updateE2E(next: E2EState): void {
    const changed = (Object.keys(next) as (keyof E2EState)[]).some((k) => JSON.stringify(next[k]) !== JSON.stringify(this.e2e[k]));
    Object.assign(this.e2e, next);
    if (changed) this.emit('e2e', { ...this.e2e });
  }

  private async handle(msg: ServerMessage): Promise<void> {
    if (msg.type === 'hello') {
      this.updateE2E({ ...(msg.keys ? { keys: msg.keys } : {}), ...(msg.tunnelKey ? { tunnelKey: msg.tunnelKey } : {}), ...(msg.relay ? { relay: msg.relay } : {}) });
      this.emit('hello', {
        deviceId: msg.deviceId,
        hubDeviceId: msg.hubDeviceId,
        history: await this.decryptAll(msg.history),
        pinned: await this.decryptAll(msg.pinned ?? []),
        devices: msg.devices,
        snippets: await this.decryptSnippets(msg.snippets ?? []),
      });
    } else if (msg.type === 'clip:new' || msg.type === 'clip:update') {
      const clip = await this.decrypt(msg.clip);
      if (clip) this.emit(msg.type === 'clip:new' ? 'clip' : 'clipUpdate', clip);
    } else if (msg.type === 'clip:remove') this.emit('clipRemove', msg.id);
    else if (msg.type === 'devices') this.emit('devices', msg.devices);
    else if (msg.type === 'registry') this.emit('registry', msg.registry);
    else if (msg.type === 'keys') this.updateE2E({ keys: msg.keys });
    else if (msg.type === 'relay') {
      if (msg.relay) this.updateE2E({ relay: msg.relay });
      else if (this.e2e.relay) {
        delete this.e2e.relay;
        this.emit('e2e', { ...this.e2e });
      }
    } else if (msg.type === 'snippets') this.emit('snippets', await this.decryptSnippets(msg.snippets));
    else if (msg.type === 'revoked') {
      this.stop();
      this.emit('revoked');
    }
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.ping);
    clearInterval(this.lanProbe);
    const relay = this.relay;
    this.relay = undefined;
    if (relay) {
      relay.onClose = undefined;
      relay.close();
    }
    this.ws?.removeAllListeners();
    this.ws?.terminate();
    this.ws = null;
  }

  private setStatus(s: ClientStatus): void {
    if (s === 'online') this.lastOnline = Date.now();
    else if (this.status === 'online') this.offlineSince = Date.now();
    if (this.status !== s) {
      this.status = s;
      this.emit('status', s);
    }
  }

  private connect(): void {
    if (this.stopped) return;
    if (this.mode === 'relay') return this.connectRelay();
    this.setStatus('connecting');
    // always ask for end-to-end mode: a device paired before v0.8 gets the keyring in `hello`
    const e2e = '&e2e=1';
    const ws = new WebSocket(`wss://${this.addr.host}:${this.addr.port}/ws?token=${encodeURIComponent(this.token)}${e2e}`, {
      ca: this.caPem,
      handshakeTimeout: 8000,
    });
    this.ws = ws;
    ws.on('open', () => {
      this.delay = 500;
      this.setStatus('online');
      this.ping = setInterval(() => {
        if (ws.readyState === ws.OPEN) ws.send('{"type":"ping"}');
        this.lastOnline = Date.now();
      }, 15_000);
    });
    ws.on('message', (raw) => {
      const msg = parseServerMessage(raw.toString());
      if (!msg) return;
      this.inbox = this.inbox.then(() => this.handle(msg)).catch(() => {});
    });
    ws.on('close', (code) => {
      clearInterval(this.ping);
      if (code === 4401) {
        this.stop();
        this.emit('revoked');
        return;
      }
      this.setStatus('offline');
      if (!this.stopped) {
        // away from home: after a few seconds without the hub, go through the relay
        if (this.canRelay) {
          const left = RELAY_AFTER_MS - (Date.now() - this.offlineSince);
          if (left <= 0) this.mode = 'relay';
          // don't let the backoff push the relay attempt far past the moment it's due
          this.delay = left <= 0 ? 300 : Math.min(this.delay, left + 50);
        }
        this.retry = setTimeout(() => this.connect(), this.delay);
        this.delay = Math.min(this.delay * 2, 5000);
      }
    });
    ws.on('error', () => {
      // 'close' follows and handles the retry
    });
  }

  private connectRelay(): void {
    const { relay: cfg, tunnelKey } = this.e2e;
    if (!cfg || !tunnelKey || !this.ids.networkId || !this.ids.deviceId) {
      this.mode = 'lan';
      return this.connect();
    }
    this.setStatus('connecting');
    const relay = new RelayConnection(cfg, this.ids.networkId, this.ids.deviceId, tunnelKey, WebSocket as unknown as WebSocketCtor);
    const retry = () => {
      if (this.stopped) return;
      // try the local network again next, then the relay, backing off
      this.mode = 'lan';
      this.setStatus('offline');
      this.retry = setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 15_000);
    };
    relay.open().then(
      () => {
        if (this.stopped) return relay.close();
        this.relay = relay;
        this.delay = 500;
        relay.onSocketMessage = (raw) => {
          const msg = parseServerMessage(raw);
          if (msg) this.inbox = this.inbox.then(() => this.handle(msg)).catch(() => {});
        };
        relay.onClose = () => {
          clearInterval(this.ping);
          clearInterval(this.lanProbe);
          if (this.relay === relay) this.relay = undefined;
          retry();
        };
        relay.openSocket(`?token=${encodeURIComponent(this.token)}&e2e=1`);
        this.setStatus('online');
        this.ping = setInterval(() => {
          relay.sendSocket('{"type":"ping"}');
          this.lastOnline = Date.now();
        }, 15_000);
        // back home: switch to the direct connection as soon as the hub answers on the local network
        this.lanProbe = setInterval(() => {
          request(this.addr, '/api/info', { ca: this.caPem })
            .then((res) => {
              if (res.status === 200 && this.relay === relay) relay.close('back on the local network');
            })
            .catch(() => {});
        }, LAN_PROBE_MS);
      },
      () => retry(),
    );
  }

  /** An API call to the hub, directly or through the relay. */
  private call(path: string, opts: RequestOpts = {}): Promise<{ status: number; body: Buffer }> {
    const relay = this.relay;
    if (!relay) return request(this.addr, path, opts);
    const headers = Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k, String(v)]));
    const body = typeof opts.body === 'string' ? Buffer.from(opts.body) : opts.body;
    return relay.request(opts.method ?? 'GET', path, headers, body).then((res) => ({ status: res.status, body: Buffer.from(res.body.buffer, res.body.byteOffset, res.body.byteLength) }));
  }

  private auth(): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...(this.e2e.keys ? { [E2E_HEADER]: '1' } : {}) };
  }

  async sendText(text: string, opts: SendOptions = {}, rich: { html?: string; rtf?: string } = {}): Promise<void> {
    const keys = this.e2e.keys;
    let body: string;
    let sendOpts = opts;
    if (keys) {
      // the hub can't read encrypted text, so this device decides whether it's a password
      sendOpts = { ...opts, sensitive: opts.sensitive ?? detectSensitive(text) !== null };
      const payload: ClipPayload = { text, ...(sendOpts.sensitive ? {} : rich), hash: sha256(text) };
      body = JSON.stringify({ enc: await sealJson(keys, payload), size: Buffer.byteLength(text) });
    } else body = JSON.stringify({ text, ...rich });
    const res = await this.call(clipsPath(sendOpts), {
      method: 'POST',
      ca: this.caPem,
      headers: { ...this.auth(), 'content-type': 'application/json' },
      body,
    });
    if (res.status !== 200) throw new Error(`send failed (${res.status})`);
  }

  async sendFile(data: Buffer, name: string, mime: string, asFile = false, opts?: SendOptions): Promise<void> {
    const boundary = `----omniclip${crypto.randomBytes(12).toString('hex')}`;
    const parts: Buffer[] = [];
    const field = (name: string, value: string) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    const keys = this.e2e.keys;
    let file = data;
    if (keys) {
      // name, type and contents are encrypted; the hub only learns whether it's an image or a file
      parts.push(field('kind', asFile || opts?.folder || !mime.startsWith('image/') ? 'file' : 'image'));
      parts.push(field('size', String(data.length)));
      parts.push(field('enc', JSON.stringify(await sealJson(keys, { name, mime, hash: sha256(data) } satisfies ClipPayload))));
      const sealed = await encryptBlob(keys, data);
      file = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
    } else if (asFile) parts.push(field('kind', 'file'));
    if (opts?.folder) parts.push(field('folder', '1'));
    const safeName = keys ? 'blob' : name.replace(/["\r\n]/g, '_');
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${keys ? 'application/octet-stream' : mime}\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    );
    const body = Buffer.concat(parts);
    const res = await this.call(clipsPath(opts), {
      method: 'POST',
      ca: this.caPem,
      headers: { ...this.auth(), 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.length },
      body,
    });
    if (res.status !== 200) throw new Error(`upload failed (${res.status})`);
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.call(path, {
      method,
      ca: this.caPem,
      headers: { ...this.auth(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = JSON.parse(res.body.toString() || '{}');
    if (res.status !== 200) throw new Error(parsed.error ?? `request failed (${res.status})`);
    return parsed as T;
  }

  /**
   * Searches all history (newest first). An empty query returns the latest clips. With end-to-end
   * encryption the hub can't read clips, so this device fetches the history and searches it itself.
   */
  async search(query: string, limit = 100): Promise<Clip[]> {
    if (!this.e2e.keys) return this.json('GET', `/api/clips?limit=${limit}${query ? `&q=${encodeURIComponent(query)}` : ''}`);
    const all = await this.decryptAll(await this.json<Clip[]>('GET', '/api/clips'));
    const q = query.trim().toLowerCase();
    const found = q ? all.filter((c) => !c.sensitive && ((c.text ?? '').toLowerCase().includes(q) || (c.name ?? '').toLowerCase().includes(q))) : all;
    return found.slice(0, limit);
  }

  async pinned(): Promise<Clip[]> {
    return this.decryptAll(await this.json<Clip[]>('GET', '/api/clips?pinned=1'));
  }

  async setPinned(id: string, pinned: boolean): Promise<Clip> {
    const clip = await this.json<Clip>('POST', `/api/clips/${encodeURIComponent(id)}/pin`, { pinned });
    return (await this.decrypt(clip)) ?? clip;
  }

  /** The relay address and whether the hub is connected to it. */
  relayInfo(): Promise<{ url: string; status: string; detail: string }> {
    return this.json('GET', '/api/relay');
  }

  /** Sets the relay address on the hub (computers only); an empty string turns the relay off. */
  setRelay(url: string): Promise<{ url: string; status: string; detail: string }> {
    return this.json('PUT', '/api/relay', { url });
  }

  async snippets(): Promise<PlainSnippet[]> {
    return this.decryptSnippets(await this.json<Snippet[]>('GET', '/api/snippets'));
  }

  async saveSnippet(id: string, snippet: SnippetPayload): Promise<void> {
    const keys = this.e2e.keys;
    await this.json('PUT', `/api/snippets/${encodeURIComponent(id)}`, keys ? { enc: await sealJson(keys, snippet) } : snippet);
  }

  async deleteSnippet(id: string): Promise<void> {
    await this.json('DELETE', `/api/snippets/${encodeURIComponent(id)}`);
  }

  rename(name: string): Promise<{ name: string }> {
    return this.json('PATCH', '/api/me', { name });
  }

  removeDevice(id: string): Promise<{ ok: true }> {
    return this.json('DELETE', `/api/devices/${encodeURIComponent(id)}`);
  }

  async fetchBlob(clip: Clip): Promise<Buffer> {
    const res = await this.call(`/api/clips/${clip.id}/blob`, { ca: this.caPem, headers: this.auth() });
    if (res.status !== 200) throw new Error(`download failed (${res.status})`);
    if (!this.e2e.keys || !isEncryptedBlob(res.body)) return res.body;
    const plain = await decryptBlob(this.e2e.keys, res.body);
    return Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength);
  }
}

function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
