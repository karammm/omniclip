import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import WebSocket from 'ws';
import { parseServerMessage, type Clip, type Device, type PairResponse, type Platform, type Registry } from '@omniclip/protocol';

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

export interface SyncClientEvents {
  status: [ClientStatus];
  hello: [{ deviceId: string; hubDeviceId: string; history: Clip[]; pinned: Clip[]; devices: Device[] }];
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

  constructor(
    readonly addr: HubAddress,
    private token: string,
    private caPem: string,
  ) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.ping);
    this.ws?.removeAllListeners();
    this.ws?.terminate();
    this.ws = null;
  }

  private setStatus(s: ClientStatus): void {
    if (s === 'online') this.lastOnline = Date.now();
    if (this.status !== s) {
      this.status = s;
      this.emit('status', s);
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus('connecting');
    const ws = new WebSocket(`wss://${this.addr.host}:${this.addr.port}/ws?token=${encodeURIComponent(this.token)}`, {
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
      if (msg.type === 'hello') this.emit('hello', { deviceId: msg.deviceId, hubDeviceId: msg.hubDeviceId, history: msg.history, pinned: msg.pinned ?? [], devices: msg.devices });
      else if (msg.type === 'clip:new') this.emit('clip', msg.clip);
      else if (msg.type === 'clip:update') this.emit('clipUpdate', msg.clip);
      else if (msg.type === 'clip:remove') this.emit('clipRemove', msg.id);
      else if (msg.type === 'devices') this.emit('devices', msg.devices);
      else if (msg.type === 'registry') this.emit('registry', msg.registry);
      else if (msg.type === 'revoked') {
        this.stop();
        this.emit('revoked');
      }
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
        this.retry = setTimeout(() => this.connect(), this.delay);
        this.delay = Math.min(this.delay * 2, 5000);
      }
    });
    ws.on('error', () => {
      // 'close' follows and handles the retry
    });
  }

  private auth(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }

  async sendText(text: string, opts?: SendOptions, rich: { html?: string; rtf?: string } = {}): Promise<void> {
    const res = await request(this.addr, clipsPath(opts), {
      method: 'POST',
      ca: this.caPem,
      headers: { ...this.auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ text, ...rich }),
    });
    if (res.status !== 200) throw new Error(`send failed (${res.status})`);
  }

  async sendFile(data: Buffer, name: string, mime: string, asFile = false, opts?: SendOptions): Promise<void> {
    const boundary = `----omniclip${crypto.randomBytes(12).toString('hex')}`;
    const parts: Buffer[] = [];
    const field = (name: string, value: string) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    if (asFile) parts.push(field('kind', 'file'));
    if (opts?.folder) parts.push(field('folder', '1'));
    const safeName = name.replace(/["\r\n]/g, '_');
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${mime}\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    );
    const body = Buffer.concat(parts);
    const res = await request(this.addr, clipsPath(opts), {
      method: 'POST',
      ca: this.caPem,
      headers: { ...this.auth(), 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.length },
      body,
    });
    if (res.status !== 200) throw new Error(`upload failed (${res.status})`);
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await request(this.addr, path, {
      method,
      ca: this.caPem,
      headers: { ...this.auth(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = JSON.parse(res.body.toString() || '{}');
    if (res.status !== 200) throw new Error(parsed.error ?? `request failed (${res.status})`);
    return parsed as T;
  }

  /** Searches all history on the hub (newest first). An empty query returns the latest clips. */
  search(query: string, limit = 100): Promise<Clip[]> {
    return this.json('GET', `/api/clips?limit=${limit}${query ? `&q=${encodeURIComponent(query)}` : ''}`);
  }

  pinned(): Promise<Clip[]> {
    return this.json('GET', '/api/clips?pinned=1');
  }

  setPinned(id: string, pinned: boolean): Promise<Clip> {
    return this.json('POST', `/api/clips/${encodeURIComponent(id)}/pin`, { pinned });
  }

  rename(name: string): Promise<{ name: string }> {
    return this.json('PATCH', '/api/me', { name });
  }

  removeDevice(id: string): Promise<{ ok: true }> {
    return this.json('DELETE', `/api/devices/${encodeURIComponent(id)}`);
  }

  async fetchBlob(clip: Clip): Promise<Buffer> {
    const res = await request(this.addr, `/api/clips/${clip.id}/blob`, { ca: this.caPem, headers: this.auth() });
    if (res.status !== 200) throw new Error(`download failed (${res.status})`);
    return res.body;
  }
}
