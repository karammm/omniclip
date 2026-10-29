// The hub's connection to the internet relay. Each device that connects through the relay gets an
// end-to-end encrypted tunnel (TunnelServer); requests inside it are replayed into the hub's own
// routes with Fastify's inject(), and its live socket becomes a "virtual socket" the hub treats
// like any other connection.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { TunnelServer, fromBase64, relayUrl, toBase64, type RelayConfig, type TunnelMessage } from '@omniclip/protocol';

export type RelayStatus = 'off' | 'connecting' | 'online' | 'error';

/** What the relay link needs from the hub (kept small so it's easy to test). */
export interface RelayHost {
  networkId: string;
  tunnelKeyFor(deviceId: string): string | undefined;
  /** Runs a request through the hub's routes as `deviceId`, marked as coming through the relay. */
  inject(deviceId: string, req: { method: string; path: string; headers: Record<string, string>; body?: Buffer }): Promise<{ status: number; headers: Record<string, string>; body: Buffer }>;
  /** Attaches a tunnelled live socket for the device owning `token` (must be `deviceId`). False if refused. */
  attachTunnelSocket(deviceId: string, token: string, socket: VirtualSocket): boolean;
}

const OPEN = 1;
const DATA = 2;
const CLOSE = 3;

/** Looks enough like a `ws` WebSocket for the hub: send, close, readyState and 'message'/'close' events. */
export class VirtualSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;

  constructor(private tunnel: TunnelServer) {
    super();
  }

  send(data: string): void {
    if (this.readyState === this.OPEN) this.tunnel.send({ t: 'ws', op: 'msg', d: String(data) });
  }

  close(): void {
    if (this.readyState !== this.OPEN) return;
    this.tunnel.send({ t: 'ws', op: 'close' });
    this.ended();
  }

  /** The device closed it, or its tunnel ended. */
  ended(): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit('close');
  }
}

function frame(type: number, connId: number, payload?: Uint8Array): Buffer {
  const out = Buffer.alloc(5 + (payload?.length ?? 0));
  out[0] = type;
  out.writeUInt32BE(connId, 1);
  if (payload) out.set(payload, 5);
  return out;
}

/** Response headers worth passing back to the device. */
const KEEP_HEADERS = ['content-type', 'content-disposition'];

export class RelayLink extends EventEmitter<{ status: [RelayStatus, string] }> {
  status: RelayStatus = 'off';
  detail = '';
  private ws?: WebSocket;
  private stopped = false;
  private retry?: NodeJS.Timeout;
  private delay = 1000;
  private tunnels = new Map<number, { tunnel: TunnelServer; socket?: VirtualSocket }>();

  constructor(
    private host: RelayHost,
    private relay: RelayConfig,
    private log: (msg: string) => void = () => {},
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
    this.dropTunnels();
    this.ws?.removeAllListeners();
    this.ws?.terminate();
    this.ws = undefined;
    this.setStatus('off', '');
  }

  private setStatus(status: RelayStatus, detail: string): void {
    if (status === this.status && detail === this.detail) return;
    this.status = status;
    this.detail = detail;
    this.emit('status', status, detail);
  }

  private dropTunnels(): void {
    for (const { tunnel, socket } of this.tunnels.values()) {
      socket?.ended();
      tunnel.onClose = undefined;
      tunnel.close();
    }
    this.tunnels.clear();
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus('connecting', '');
    let url: string;
    try {
      url = relayUrl(this.relay.url, this.host.networkId, 'hub');
    } catch {
      return this.setStatus('error', 'That relay address is not valid.');
    }
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.ws = ws;
    ws.on('open', () => ws.send(JSON.stringify({ auth: this.relay.token })));
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const msg = JSON.parse(data.toString()) as { type?: string };
        if (msg.type === 'ready') {
          this.delay = 1000;
          this.setStatus('online', '');
          this.log(`connected to the relay at ${this.relay.url}`);
        }
        return;
      }
      const buf = data as Buffer;
      if (buf.length < 5) return;
      this.onFrame(buf[0]!, buf.readUInt32BE(1), buf.subarray(5));
    });
    ws.on('close', (code, reason) => {
      this.dropTunnels();
      if (this.stopped) return;
      const why = code === 4403 ? 'The relay refused this hub (wrong relay token).' : code === 4409 ? 'Another hub took over this relay.' : reason.toString() || 'Lost the connection to the relay.';
      this.setStatus('error', why);
      // another hub took over: back off for longer so two hubs don't keep replacing each other
      this.retry = setTimeout(() => this.connect(), code === 4409 ? 60_000 : this.delay);
      this.delay = Math.min(this.delay * 2, 30_000);
    });
    ws.on('error', (err) => {
      this.detail = String(err.message);
    });
  }

  private sendFrame(type: number, connId: number, payload?: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame(type, connId, payload));
  }

  private onFrame(type: number, connId: number, payload: Buffer): void {
    if (type === OPEN) {
      const tunnel = new TunnelServer({ send: (d) => this.sendFrame(DATA, connId, d), close: () => this.sendFrame(CLOSE, connId) }, (id) => this.host.tunnelKeyFor(id));
      const entry: { tunnel: TunnelServer; socket?: VirtualSocket } = { tunnel };
      this.tunnels.set(connId, entry);
      tunnel.onMessage = (msg) => void this.onMessage(entry, msg);
      tunnel.onClose = () => {
        entry.socket?.ended();
        this.tunnels.delete(connId);
      };
      return;
    }
    const entry = this.tunnels.get(connId);
    if (!entry) return;
    if (type === DATA) entry.tunnel.receive(new Uint8Array(payload));
    else if (type === CLOSE) {
      entry.tunnel.onClose?.('device left');
      entry.tunnel.onClose = undefined;
      entry.tunnel.close();
    }
  }

  private async onMessage(entry: { tunnel: TunnelServer; socket?: VirtualSocket }, msg: TunnelMessage): Promise<void> {
    const { tunnel } = entry;
    if (msg.t === 'req') {
      try {
        const res = await this.host.inject(tunnel.deviceId, {
          method: String(msg.m),
          path: String(msg.p),
          headers: (msg.h as Record<string, string>) ?? {},
          body: msg.b ? Buffer.from(fromBase64(msg.b as string)) : undefined,
        });
        const headers = Object.fromEntries(KEEP_HEADERS.filter((h) => res.headers[h]).map((h) => [h, res.headers[h]!]));
        tunnel.send({ t: 'res', id: msg.id, s: res.status, h: headers, ...(res.body.length ? { b: toBase64(res.body) } : {}) });
      } catch (err) {
        tunnel.send({ t: 'res', id: msg.id, s: 500, h: {}, b: toBase64(Buffer.from(JSON.stringify({ error: String(err) }))) });
      }
    } else if (msg.t === 'ws') {
      if (msg.op === 'open' && !entry.socket) {
        const token = new URLSearchParams(String(msg.q ?? '').replace(/^\?/, '')).get('token') ?? '';
        const socket = new VirtualSocket(tunnel);
        if (this.host.attachTunnelSocket(tunnel.deviceId, token, socket)) entry.socket = socket;
        else tunnel.send({ t: 'ws', op: 'close' });
      } else if (msg.op === 'msg') entry.socket?.emit('message', Buffer.from(String(msg.d)));
      else if (msg.op === 'close') entry.socket?.ended();
    }
  }
}
