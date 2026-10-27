import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import {
  HUB_PORT_HTTP,
  HUB_PORT_TLS,
  MAX_TEXT_BYTES,
  MAX_UPLOAD_BYTES,
  PROTOCOL_VERSION,
  PairRequestSchema,
  SENSITIVE_TTL_MS,
  PinRequestSchema,
  RenameRequestSchema,
  TextClipRequestSchema,
  detectSensitive,
  isDesktopPlatform,
  type Clip,
  type Device,
  type DeviceRecord,
  type PairResponse,
  type Platform,
  type Registry,
  type ServerMessage,
} from '@omniclip/protocol';
import { ensureCerts, pinFingerprint, type KeyPair } from './certs.js';
import { lanAddresses } from './net.js';
import { Store, hashToken, visibleTo } from './store.js';

export interface HubOptions {
  dataDir: string;
  /** Built PWA (apps/web/dist). Optional so the hub can run headless in tests. */
  webDir?: string;
  /** Registry handed over from a previous hub on the same network (failover). */
  seedRegistry?: Registry;
  portTls?: number;
  portHttp?: number;
  /** Extra IPs to put in the server cert (tests). */
  extraIps?: string[];
  /** How long passwords and codes live (tests shorten it). */
  sensitiveTtlMs?: number;
  log?: (msg: string) => void;
}

export interface ClipOptions {
  /** Deliver to this device only. */
  to?: DeviceRecord;
  /** true: the sender says it's a secret (e.g. copied from a password manager); false: don't guess. */
  sensitive?: boolean;
}

export class ClipError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface PairingCode {
  code: string;
  expiresAt: number;
}

const PAIR_CODE_TTL = 10 * 60 * 1000;
const MAX_FAILED_PAIRS = 10;

export class Hub extends EventEmitter {
  readonly store: Store;
  private opts: Required<Pick<HubOptions, 'portTls' | 'portHttp'>> & HubOptions;
  private ca!: KeyPair;
  private servers: FastifyInstance[] = [];
  private sockets = new Map<string, Set<WebSocket>>();
  private pairing: PairingCode = { code: '', expiresAt: 0 };
  private failedPairs = 0;
  private rotateTimer?: NodeJS.Timeout;
  private ips: string[] = [];
  localDeviceId = '';
  /** Where each connected desktop reached us from; any of them may become the next hub. */
  private peerAddresses = new Map<string, string[]>();
  private expiry = new Map<string, NodeJS.Timeout>();

  constructor(opts: HubOptions) {
    super();
    this.opts = { portTls: HUB_PORT_TLS, portHttp: HUB_PORT_HTTP, ...opts };
    fs.mkdirSync(opts.dataDir, { recursive: true });
    this.store = new Store(
      opts.dataDir,
      opts.seedRegistry ? { networkId: opts.seedRegistry.networkId, devices: opts.seedRegistry.devices } : undefined,
    );
    this.rotatePairingCode();
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  get networkId(): string {
    return this.store.networkId;
  }

  /** Pin for the network's CA, carried in the pairing QR so the phone apps can trust it. */
  get caPin(): string {
    return pinFingerprint(this.ca.certPem);
  }

  get caPem(): string {
    return this.ca.certPem;
  }

  get ports(): { tls: number; http: number } {
    return { tls: this.opts.portTls, http: this.opts.portHttp };
  }

  urls(): { tls: string[]; http: string[] } {
    return {
      tls: this.ips.map((ip) => `https://${ip}:${this.opts.portTls}`),
      http: this.ips.map((ip) => `http://${ip}:${this.opts.portHttp}`),
    };
  }

  getPairingCode(): PairingCode {
    if (Date.now() > this.pairing.expiresAt) this.rotatePairingCode();
    return this.pairing;
  }

  rotatePairingCode(): PairingCode {
    this.pairing = { code: crypto.randomInt(0, 1_000_000).toString().padStart(6, '0'), expiresAt: Date.now() + PAIR_CODE_TTL };
    this.failedPairs = 0;
    this.emit('pairingCode', this.pairing);
    return this.pairing;
  }

  async start(): Promise<void> {
    this.ips = lanAddresses();
    const certIps = [...new Set(['127.0.0.1', ...this.ips, ...(this.opts.extraIps ?? [])])];
    const dnsNames = ['localhost', `${os.hostname().replace(/\.local$/, '')}.local`];
    const { ca, server } = ensureCerts(path.join(this.opts.dataDir, 'certs'), certIps, dnsNames, this.opts.seedRegistry?.ca);
    this.ca = ca;

    const tls = this.buildServer({ key: server.keyPem, cert: server.certPem });
    const http = this.buildServer();
    this.servers = [tls, http];
    await tls.listen({ port: this.opts.portTls, host: '0.0.0.0' });
    await http.listen({ port: this.opts.portHttp, host: '0.0.0.0' });
    this.rotateTimer = setInterval(() => this.getPairingCode(), 30_000);
    this.log(`hub ${this.networkId} listening on ${this.urls().tls.join(', ') || `:${this.opts.portTls}`}`);
  }

  async stop(): Promise<void> {
    clearInterval(this.rotateTimer);
    for (const t of this.expiry.values()) clearTimeout(t);
    this.expiry.clear();
    for (const set of this.sockets.values()) for (const ws of set) ws.close();
    this.sockets.clear();
    await Promise.all(this.servers.map((s) => s.close()));
    this.servers = [];
  }

  // ---- devices ----

  private issueDevice(name: string, platform: Platform): PairResponse {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const record: DeviceRecord = { id: crypto.randomUUID(), name, platform, createdAt: now, lastSeen: now, tokenHash: hashToken(token) };
    this.store.addDevice(record);
    this.devicesChanged();
    return { token, deviceId: record.id, networkId: this.networkId, caPem: this.ca.certPem };
  }

  /** Registers the desktop running this hub as a device without needing a pairing code. */
  createLocalDevice(name: string, platform: Platform, existingToken?: string): PairResponse {
    const existing = existingToken ? this.store.deviceByToken(existingToken) : undefined;
    const res = existing
      ? { token: existingToken!, deviceId: existing.id, networkId: this.networkId, caPem: this.ca.certPem }
      : this.issueDevice(name, platform);
    this.localDeviceId = res.deviceId;
    return res;
  }

  listDevices(): Device[] {
    return this.store.devices().map(({ tokenHash: _t, ...d }) => {
      const online = (this.sockets.get(d.id)?.size ?? 0) > 0;
      const addresses = d.id === this.localDeviceId ? this.ips : this.peerAddresses.get(d.id);
      return { ...d, online, ...(online && addresses?.length ? { addresses } : {}) };
    });
  }

  revokeDevice(id: string): boolean {
    if (id === this.localDeviceId) return false;
    const removed = this.store.removeDevice(id);
    for (const ws of this.sockets.get(id) ?? []) {
      this.send(ws, { type: 'revoked' });
      ws.close();
    }
    this.sockets.delete(id);
    if (removed) this.devicesChanged();
    return removed;
  }

  registry(): Registry {
    return { networkId: this.networkId, devices: this.store.devices(), ca: this.ca };
  }

  private devicesChanged(): void {
    const devices = this.listDevices();
    this.broadcast({ type: 'devices', devices });
    const registry: ServerMessage = { type: 'registry', registry: this.registry() };
    for (const d of this.store.devices()) {
      if (!isDesktopPlatform(d.platform) || d.id === this.localDeviceId) continue;
      for (const ws of this.sockets.get(d.id) ?? []) this.send(ws, registry);
    }
    this.emit('devices', devices);
  }

  // ---- clips ----

  addTextClip(device: DeviceRecord, text: string, opts: ClipOptions = {}): Clip {
    const sensitive = opts.sensitive ?? detectSensitive(text) !== null;
    const clip: Clip = {
      id: crypto.randomUUID(),
      kind: 'text',
      text,
      mime: 'text/plain',
      size: Buffer.byteLength(text),
      hash: crypto.createHash('sha256').update(text).digest('hex'),
      sourceDeviceId: device.id,
      sourceName: device.name,
      createdAt: Date.now(),
      ...target(opts),
      ...(sensitive ? { sensitive: true, expiresAt: Date.now() + (this.opts.sensitiveTtlMs ?? SENSITIVE_TTL_MS) } : {}),
    };
    this.publishClip(clip);
    return clip;
  }

  /** Streams an upload into the blob store. Returns null if the upload hit the size limit. */
  private async addBlobClip(
    device: DeviceRecord,
    source: Readable & { truncated?: boolean },
    mimeType: string,
    filename: string | undefined,
    forceFile: boolean,
    opts: ClipOptions,
  ): Promise<Clip | null> {
    const id = crypto.randomUUID();
    const dest = this.store.blobPath(id);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    try {
      await pipeline(source, tap, fs.createWriteStream(dest));
    } catch (err) {
      fs.rmSync(dest, { force: true });
      throw err;
    }
    if (source.truncated) {
      fs.rmSync(dest, { force: true });
      return null;
    }
    const mime = mimeType || 'application/octet-stream';
    const kind = forceFile || !mime.startsWith('image/') ? 'file' : 'image';
    const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
    const clip: Clip = {
      id,
      kind,
      mime,
      size,
      name: filename || (kind === 'image' ? `image.${ext}` : `file.${ext}`),
      hash: hash.digest('hex'),
      sourceDeviceId: device.id,
      sourceName: device.name,
      createdAt: Date.now(),
      ...target(opts),
    };
    this.publishClip(clip);
    return clip;
  }

  private publishClip(clip: Clip): void {
    this.store.addClip(clip);
    this.deliver(clip, { type: 'clip:new', clip });
    if (clip.expiresAt) this.expiry.set(clip.id, setTimeout(() => this.removeClip(clip.id), clip.expiresAt - Date.now()));
    this.emit('clip', clip);
  }

  /** Deletes a clip and tells every device that could see it. */
  removeClip(id: string): boolean {
    clearTimeout(this.expiry.get(id));
    this.expiry.delete(id);
    const clip = this.store.removeClip(id);
    if (clip) this.deliver(clip, { type: 'clip:remove', id });
    return !!clip;
  }

  /** Sends a clip message to the devices allowed to see the clip. */
  private deliver(clip: Clip, msg: ServerMessage): void {
    if (!clip.targetDeviceId) return this.broadcast(msg);
    const raw = JSON.stringify(msg);
    for (const [id, set] of this.sockets) {
      if (!visibleTo(clip, id)) continue;
      for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(raw);
    }
  }

  /** Reads `?to=<deviceId>&sensitive=0|1` from a clip upload. */
  private clipOptions(req: FastifyRequest): ClipOptions {
    const query = req.query as Record<string, string | undefined>;
    const opts: ClipOptions = {};
    if (query.to) {
      opts.to = this.store.devices().find((d) => d.id === query.to);
      if (!opts.to) throw new ClipError(404, 'That device is no longer paired.');
    }
    if (query.sensitive === '1' || query.sensitive === '0') opts.sensitive = query.sensitive === '1';
    return opts;
  }

  // ---- transport ----

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage): void {
    const raw = JSON.stringify(msg);
    for (const set of this.sockets.values()) for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(raw);
  }

  private authenticate(req: FastifyRequest): DeviceRecord | undefined {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.query as Record<string, string | undefined>).token;
    return token ? this.store.deviceByToken(token) : undefined;
  }

  private requireDevice(req: FastifyRequest, reply: FastifyReply): DeviceRecord | undefined {
    const device = this.authenticate(req);
    if (!device) void reply.code(401).send({ error: 'unauthorized' });
    return device;
  }

  private buildServer(https?: { key: string; cert: string }): FastifyInstance {
    const app = Fastify({ logger: false, bodyLimit: MAX_TEXT_BYTES * 2, ...(https ? { https } : {}) }) as unknown as FastifyInstance;

    app.register(fastifyMultipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
    app.register(fastifyWebsocket);
    app.addContentTypeParser(/^(image|video|audio|application\/(octet-stream|pdf|zip))/, { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) =>
      done(null, body),
    );

    app.addHook('onSend', async (req, reply) => {
      // allow the Apple Shortcut / other origins to call the API with a bearer token
      if (req.url.startsWith('/api/') || req.url === '/ca.crt') {
        reply.header('Access-Control-Allow-Origin', '*');
        reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Filename');
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      }
    });
    app.options('/api/*', async (_req, reply) => reply.code(204).send());

    app.get('/api/info', async () => ({ app: 'omniclip', networkId: this.networkId, version: PROTOCOL_VERSION, secure: !!https }));

    app.get('/ca.crt', async (_req, reply) =>
      reply
        .header('Content-Type', 'application/x-x509-ca-cert')
        .header('Content-Disposition', 'attachment; filename="OmniClip-CA.crt"')
        .send(this.ca.certPem),
    );

    app.post('/api/pair', async (req, reply) => {
      const parsed = PairRequestSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });
      const current = this.getPairingCode();
      const a = Buffer.from(parsed.data.code.padEnd(16));
      const b = Buffer.from(current.code.padEnd(16));
      if (!crypto.timingSafeEqual(a, b)) {
        if (++this.failedPairs >= MAX_FAILED_PAIRS) this.rotatePairingCode();
        return reply.code(403).send({ error: 'wrong or expired pairing code' });
      }
      const res = this.issueDevice(parsed.data.name, parsed.data.platform);
      this.rotatePairingCode();
      this.log(`paired ${parsed.data.name} (${parsed.data.platform})`);
      return res;
    });

    app.get('/api/me', async (req, reply) => {
      const device = this.requireDevice(req, reply);
      if (!device) return;
      return { deviceId: device.id, name: device.name, networkId: this.networkId };
    });

    app.get('/api/devices', async (req, reply) => {
      if (!this.requireDevice(req, reply)) return;
      return this.listDevices();
    });

    app.get('/api/clips', async (req, reply) => {
      const device = this.requireDevice(req, reply);
      if (!device) return;
      const query = req.query as Record<string, string>;
      const limit = Number(query.limit) || undefined;
      if (query.pinned === '1') return this.store.pinnedClips(device.id);
      return query.q ? this.store.search(query.q, limit, device.id) : this.store.clips(limit, device.id);
    });

    app.post('/api/clips/:id/pin', async (req, reply) => {
      const device = this.requireDevice(req, reply);
      if (!device) return;
      const body = PinRequestSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'expected {"pinned": true|false}' });
      const id = (req.params as { id: string }).id;
      const existing = this.store.clip(id, device.id);
      if (!existing) return reply.code(404).send({ error: 'not found' });
      if (existing.sensitive) return reply.code(400).send({ error: "Passwords and codes can't be pinned." });
      const clip = this.store.setPinned(id, body.data.pinned)!;
      this.deliver(clip, { type: 'clip:update', clip });
      return clip;
    });

    app.patch('/api/me', async (req, reply) => {
      const device = this.requireDevice(req, reply);
      if (!device) return;
      const body = RenameRequestSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'expected {"name": "..."} (1-64 characters)' });
      this.store.renameDevice(device.id, body.data.name);
      this.devicesChanged();
      return { deviceId: device.id, name: body.data.name, networkId: this.networkId };
    });

    // desktops can remove devices (phones can't); a device can always remove itself
    app.delete('/api/devices/:id', async (req, reply) => {
      const device = this.requireDevice(req, reply);
      if (!device) return;
      const id = (req.params as { id: string }).id;
      if (id !== device.id && !isDesktopPlatform(device.platform)) return reply.code(403).send({ error: 'only computers can remove other devices' });
      if (!this.revokeDevice(id)) return reply.code(404).send({ error: 'not found (the hub computer itself cannot be removed)' });
      return { ok: true };
    });

    // optional query: ?to=<deviceId> sends to one device; ?sensitive=1|0 overrides password detection
    app.post('/api/clips', async (req, reply) => {
      const device = this.requireDevice(req, reply);
      if (!device) return;
      let opts: ClipOptions;
      try {
        opts = this.clipOptions(req);
      } catch (err) {
        if (err instanceof ClipError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }

      if (req.isMultipart()) {
        const part = await req.file();
        if (!part) return reply.code(400).send({ error: 'no file' });
        const kindField = part.fields.kind as { value?: string } | undefined;
        const clip = await this.addBlobClip(device, part.file, part.mimetype, part.filename, kindField?.value === 'file', opts);
        return clip ?? reply.code(413).send({ error: 'file too large' });
      }

      // raw binary body, e.g. an image from an Apple Shortcut's "Get Clipboard"
      if (Buffer.isBuffer(req.body)) {
        const mime = (req.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!.trim();
        const name = req.headers['x-filename'] ? decodeURIComponent(String(req.headers['x-filename'])) : undefined;
        return this.addBlobClip(device, Readable.from([req.body]), mime, name, false, opts);
      }

      // JSON {text} or a raw text/plain body (handy for Apple Shortcuts)
      const text = typeof req.body === 'string' ? req.body : TextClipRequestSchema.safeParse(req.body).data?.text;
      if (!text) return reply.code(400).send({ error: 'expected {"text": "..."} or a file upload' });
      if (Buffer.byteLength(text) > MAX_TEXT_BYTES) return reply.code(413).send({ error: 'text too large' });
      return this.addTextClip(device, text, opts);
    });

    app.get('/api/clips/:id/blob', async (req, reply) => {
      const device = this.requireDevice(req, reply);
      if (!device) return;
      const clip = this.store.clip((req.params as { id: string }).id, device.id);
      if (!clip || clip.kind === 'text') return reply.code(404).send({ error: 'not found' });
      const disposition = clip.kind === 'image' ? 'inline' : 'attachment';
      const name = encodeURIComponent(clip.name ?? clip.id);
      return reply
        .header('Content-Type', clip.mime)
        .header('Content-Length', clip.size)
        .header('Content-Disposition', `${disposition}; filename*=UTF-8''${name}`)
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .send(fs.createReadStream(this.store.blobPath(clip.id)));
    });

    app.register(async (scope) => {
      scope.get('/ws', { websocket: true }, (socket, req) => {
        const device = this.authenticate(req);
        if (!device) {
          socket.close(4401, 'unauthorized');
          return;
        }
        let set = this.sockets.get(device.id);
        if (!set) this.sockets.set(device.id, (set = new Set()));
        set.add(socket);
        this.store.touchDevice(device.id);
        const remote = req.socket.remoteAddress?.replace(/^::ffff:/, '');
        if (isDesktopPlatform(device.platform) && remote && remote !== '127.0.0.1' && remote !== '::1') this.peerAddresses.set(device.id, [remote]);

        this.send(socket, {
          type: 'hello',
          deviceId: device.id,
          networkId: this.networkId,
          hubDeviceId: this.localDeviceId,
          history: this.store.clips(50, device.id),
          pinned: this.store.pinnedClips(device.id),
          devices: this.listDevices(),
        });
        if (isDesktopPlatform(device.platform) && device.id !== this.localDeviceId) {
          this.send(socket, { type: 'registry', registry: this.registry() });
        }
        this.broadcast({ type: 'devices', devices: this.listDevices() });

        socket.on('message', (raw) => {
          if (raw.toString().includes('"ping"')) this.send(socket, { type: 'pong' });
        });
        socket.on('close', () => {
          set!.delete(socket);
          if (set!.size === 0) {
            this.sockets.delete(device.id);
            this.peerAddresses.delete(device.id);
          }
          this.store.touchDevice(device.id);
          this.broadcast({ type: 'devices', devices: this.listDevices() });
          this.emit('devices', this.listDevices());
        });
      });
    });

    const webDir = this.opts.webDir;
    if (webDir && fs.existsSync(path.join(webDir, 'index.html'))) {
      app.register(fastifyStatic, {
        root: webDir,
        setHeaders: (reply, file) => {
          if (file.endsWith('sw.js') || file.endsWith('.html') || file.endsWith('.webmanifest')) reply.header('Cache-Control', 'no-cache');
        },
      });
      // SPA fallback (/setup etc.)
      app.setNotFoundHandler((req, reply) => {
        if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
        return reply.code(404).send({ error: 'not found' });
      });
    } else {
      app.get('/', async (_req, reply) => reply.type('text/html').send('<h1>OmniClip hub</h1><p>Web app not built. Run <code>npm run build:web</code>.</p>'));
    }

    return app;
  }
}

function target(opts: ClipOptions): Partial<Clip> {
  return opts.to ? { targetDeviceId: opts.to.id, targetName: opts.to.name } : {};
}
