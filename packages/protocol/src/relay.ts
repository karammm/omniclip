// A device's connection to its hub through the internet relay: the relay WebSocket, the encrypted
// tunnel inside it, and on top the same API requests and live socket used on the local network.
//
// Relay rules (apps/relay): the first text message authenticates ({ auth: relayToken }); the relay
// answers { type: 'ready', hub: boolean } and later { type: 'hub', online } when the hub comes or
// goes. Binary messages are tunnel frames, passed through untouched.

import { fromBase64, toBase64 } from './e2e';
import { TunnelClient, type TunnelMessage } from './tunnel';

export interface RelaySettings {
  url: string;
  token: string;
}

export interface RelayResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array<ArrayBuffer>;
}

/** The parts of the WebSocket API used here; browsers, Node 22+ and the `ws` package all fit. */
interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

/** `wss://…/v1/<networkId>/<role>` from what the user typed (https:// or wss://, with or without a path). */
export function relayUrl(base: string, networkId: string, role: 'hub' | 'device' | 'status'): string {
  const u = new URL(/^[a-z]+:\/\//i.test(base.trim()) ? base.trim() : `https://${base.trim()}`);
  const ws = role !== 'status';
  u.protocol = u.protocol === 'http:' || u.protocol === 'ws:' ? (ws ? 'ws:' : 'http:') : ws ? 'wss:' : 'https:';
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/v1/${encodeURIComponent(networkId)}/${role}`;
  u.search = '';
  return u.toString();
}

/** Asks the relay whether the network's hub is connected to it. */
export async function relayHubOnline(relay: RelaySettings, networkId: string, timeoutMs = 5000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(relayUrl(relay.url, networkId, 'status'), { headers: { authorization: `Bearer ${relay.token}` }, signal: ctrl.signal });
    return res.ok && ((await res.json()) as { hub?: boolean }).hub === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export class RelayConnection {
  private ws?: WebSocketLike;
  private tunnel?: TunnelClient;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (r: RelayResponse) => void; reject: (e: Error) => void }>();
  private closed = false;
  /** A message on the live socket (the same JSON the hub sends over its WebSocket). */
  onSocketMessage?: (data: string) => void;
  onSocketClose?: () => void;
  /** The relay connection ended (network, relay restart, hub went away). */
  onClose?: (reason: string) => void;

  constructor(
    private relay: RelaySettings,
    private networkId: string,
    private deviceId: string,
    private tunnelKey: string,
    private WS: WebSocketCtor = globalThis.WebSocket as unknown as WebSocketCtor,
  ) {}

  /** Connects and completes the handshake with the hub; throws if the hub isn't on the relay. */
  open(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('the relay did not answer')), timeoutMs);
      let settled = false;
      const fail = (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
        this.close(err.message);
      };
      const ws = new this.WS(relayUrl(this.relay.url, this.networkId, 'device'));
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => ws.send(JSON.stringify({ auth: this.relay.token }));
      ws.onerror = () => fail(new Error('could not reach the relay'));
      ws.onclose = (ev) => {
        const reason = ev.reason || `relay closed (${ev.code ?? 0})`;
        if (!settled) fail(new Error(reason));
        else this.close(reason);
      };
      ws.onmessage = (ev) => {
        const bytes = bytesOf(ev.data);
        if (bytes) return this.tunnel?.receive(bytes);
        const msg = JSON.parse(String(ev.data)) as { type?: string; hub?: boolean; online?: boolean };
        if (msg.type === 'ready') {
          if (!msg.hub) return fail(new Error('your hub computer is not connected to the relay'));
          const tunnel = new TunnelClient({ send: (d) => ws.send(d), close: () => ws.close() }, this.deviceId, this.tunnelKey);
          this.tunnel = tunnel;
          tunnel.onMessage = (m) => this.handle(m);
          tunnel.onClose = (reason) => this.close(reason);
          tunnel.start().then(() => {
            settled = true;
            clearTimeout(timer);
            resolve();
          }, fail);
        } else if (msg.type === 'hub' && msg.online === false) this.close('your hub computer left the relay');
      };
    });
  }

  private handle(msg: TunnelMessage): void {
    if (msg.t === 'res') {
      const w = this.waiting.get(msg.id as number);
      if (!w) return;
      this.waiting.delete(msg.id as number);
      w.resolve({ status: msg.s as number, headers: (msg.h as Record<string, string>) ?? {}, body: msg.b ? fromBase64(msg.b as string) : new Uint8Array() });
    } else if (msg.t === 'ws') {
      if (msg.op === 'msg') this.onSocketMessage?.(msg.d as string);
      else if (msg.op === 'close') this.onSocketClose?.();
    }
  }

  get connected(): boolean {
    return !this.closed && !!this.tunnel?.ready;
  }

  /** An API request to the hub, as if it were made on the local network. */
  request(method: string, path: string, headers: Record<string, string> = {}, body?: Uint8Array): Promise<RelayResponse> {
    if (!this.tunnel?.ready || this.closed) return Promise.reject(new Error('not connected through the relay'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.tunnel!.send({ t: 'req', id, m: method, p: path, h: headers, ...(body?.length ? { b: toBase64(body) } : {}) });
    });
  }

  /** Opens the live socket; `query` is what would follow /ws on the local network (?token=…&e2e=1). */
  openSocket(query: string): void {
    this.tunnel?.send({ t: 'ws', op: 'open', q: query });
  }

  sendSocket(data: string): void {
    this.tunnel?.send({ t: 'ws', op: 'msg', d: data });
  }

  close(reason = 'closed'): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiting.values()) w.reject(new Error(reason));
    this.waiting.clear();
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
    this.onSocketClose?.();
    this.onClose?.(reason);
  }
}
