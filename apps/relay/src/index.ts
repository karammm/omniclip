// OmniClip relay: lets devices reach their hub when they're not on the same network.
// One Durable Object ("room") per network. The hub keeps a WebSocket open to its room; devices
// connect to the same room, and the relay passes binary frames between them. Those frames are an
// end-to-end encrypted tunnel (packages/protocol/src/tunnel.ts): the relay can't read them.
//
// Hub socket frames: [type u8][connection id u32][payload], type 1 = device connected,
// 2 = data, 3 = device disconnected. Device sockets carry just the payload.
// Both sides first send { auth: relayToken }; the room remembers the token's hash from the first
// hub that connects and accepts only that token afterwards.

interface Env {
  ROOMS: DurableObjectNamespace;
}

type Role = 'hub' | 'device';
interface Attachment {
  role: Role;
  authed: boolean;
  connId: number;
}

const OPEN = 1;
const DATA = 2;
const CLOSE = 3;
const MAX_DEVICES = 64;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const m = /^\/v1\/([0-9a-f-]{36})\/(hub|device|status)$/.exec(url.pathname);
    if (!m) return new Response('OmniClip relay. It forwards end-to-end encrypted frames between your devices.\n', { status: url.pathname === '/' ? 200 : 404 });
    return env.ROOMS.get(env.ROOMS.idFromName(m[1]!)).fetch(req);
  },
};

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

function frame(type: number, connId: number, payload?: ArrayBuffer): ArrayBuffer {
  const out = new Uint8Array(5 + (payload?.byteLength ?? 0));
  out[0] = type;
  new DataView(out.buffer).setUint32(1, connId);
  if (payload) out.set(new Uint8Array(payload), 5);
  return out.buffer;
}

export class RelayRoom {
  constructor(private state: DurableObjectState) {}

  private sockets(): Array<[CfWebSocket, Attachment]> {
    return this.state.getWebSockets().map((ws) => [ws, ws.deserializeAttachment() as Attachment]);
  }

  /** The connected hub (other than `except`, which may be the socket that is closing). */
  private hub(except?: CfWebSocket): CfWebSocket | undefined {
    return this.sockets().find(([ws, a]) => ws !== except && a.role === 'hub' && a.authed)?.[0];
  }

  private devices(): Array<[CfWebSocket, Attachment]> {
    return this.sockets().filter(([, a]) => a.role === 'device' && a.authed);
  }

  private async tokenOk(token: unknown, role: Role): Promise<boolean> {
    if (typeof token !== 'string' || token.length < 16) return false;
    const hash = await sha256(token);
    const known = await this.state.storage.get<string>('tokenHash');
    if (!known) {
      if (role !== 'hub') return false;
      await this.state.storage.put('tokenHash', hash);
      return true;
    }
    return known === hash;
  }

  async fetch(req: Request): Promise<Response> {
    const role = new URL(req.url).pathname.split('/').pop() as Role | 'status';
    if (role === 'status') {
      const token = req.headers.get('authorization')?.replace(/^Bearer /, '');
      const known = await this.state.storage.get<string>('tokenHash');
      if (!token || !known || known !== (await sha256(token))) return new Response('{"error":"unauthorized"}', { status: 401 });
      return Response.json({ hub: !!this.hub() });
    }
    if (req.headers.get('upgrade') !== 'websocket') return new Response('expected a WebSocket', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ role, authed: false, connId: 0 } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: CfWebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment;
    if (!att.authed) {
      let token: unknown;
      try {
        token = typeof message === 'string' ? (JSON.parse(message) as { auth?: unknown }).auth : undefined;
      } catch {
        token = undefined;
      }
      if (!(await this.tokenOk(token, att.role))) return ws.close(4403, 'wrong relay token');
      if (att.role === 'hub') {
        // a reconnecting hub replaces the old connection; devices start new tunnels with it
        for (const [other, a] of this.sockets()) {
          if (other === ws) continue;
          if (a.role === 'hub') other.close(4409, 'replaced by a newer hub connection');
          else other.close(4410, 'hub reconnected');
        }
        ws.serializeAttachment({ ...att, authed: true });
        ws.send(JSON.stringify({ type: 'ready', hub: true }));
        return;
      }
      if (this.devices().length >= MAX_DEVICES) return ws.close(4429, 'too many devices');
      const used = new Set(this.devices().map(([, a]) => a.connId));
      let connId = 0;
      while (!connId || used.has(connId)) connId = crypto.getRandomValues(new Uint32Array(1))[0]!;
      ws.serializeAttachment({ ...att, authed: true, connId });
      const hub = this.hub();
      ws.send(JSON.stringify({ type: 'ready', hub: !!hub }));
      hub?.send(frame(OPEN, connId));
      return;
    }
    if (typeof message === 'string') return; // nothing to do with text once authenticated
    if (att.role === 'device') {
      this.hub()?.send(frame(DATA, att.connId, message));
      return;
    }
    const view = new DataView(message);
    if (message.byteLength < 5) return;
    const type = view.getUint8(0);
    const connId = view.getUint32(1);
    const device = this.devices().find(([, a]) => a.connId === connId)?.[0];
    if (!device) return;
    if (type === DATA) device.send(message.slice(5));
    else if (type === CLOSE) device.close(1000, 'closed by hub');
  }

  async webSocketClose(ws: CfWebSocket, code: number, reason: string): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment;
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      // already closed
    }
    if (!att.authed) return;
    if (att.role === 'device') {
      this.hub()?.send(frame(CLOSE, att.connId));
      return;
    }
    if (this.hub(ws)) return; // a newer hub connection already took over
    for (const [device] of this.devices()) {
      device.send(JSON.stringify({ type: 'hub', online: false }));
      device.close(4404, 'hub offline');
    }
  }

  async webSocketError(ws: CfWebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, 'error');
  }
}
