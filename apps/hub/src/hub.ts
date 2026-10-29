import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PassThrough, Readable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import {
  E2E_HEADER,
  EncryptedTextRequestSchema,
  EnvelopeSchema,
  HUB_PORT_HTTP,
  HUB_PORT_TLS,
  MAX_RICH_BYTES,
  MAX_TEXT_BYTES,
  MAX_UPLOAD_BYTES,
  PROTOCOL_VERSION,
  PairRequestSchema,
  SENSITIVE_TTL_MS,
  PinRequestSchema,
  RenameRequestSchema,
  SnippetPayloadSchema,
  TextClipRequestSchema,
  decryptBlob,
  decryptClip,
  detectSensitive,
  encryptBlob,
  isDesktopPlatform,
  isEncryptedBlob,
  rotateKeyring,
  sealJson,
  toBase64,
  type Clip,
  type ClipPayload,
  type Device,
  type DeviceRecord,
  type Envelope,
  type PairResponse,
  type Platform,
  type Registry,
  type RelayConfig,
  type ServerMessage,
  type Snippet,
  type SnippetPayload,
} from '@omniclip/protocol';
import { ensureCerts, pinFingerprint, type KeyPair } from './certs.js';
import { lanAddresses } from './net.js';
import { RelayLink, type RelayStatus, type VirtualSocket } from './relayLink.js';
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
  /** 32-byte key: clips and files are encrypted on disk with it. */
  historyKey?: Buffer;
  log?: (msg: string) => void;
}

export interface ClipOptions {
  /** Deliver to this device only. */
  to?: DeviceRecord;
  /** true: the sender says it's a secret (e.g. copied from a password manager); false: don't guess. */
  sensitive?: boolean;
}

/** Formatting that came with copied text. */
export interface RichText {
  html?: string;
  rtf?: string;
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

/**
 * How a socket wants its messages. End-to-end clients get clips as sent (encrypted); everything else
 * (v0.7 apps, the browser in basic mode) gets them decrypted by the hub, in order.
 */
interface SocketInfo {
  e2e: boolean;
  queue: Promise<void>;
}

/** Marks requests that arrived through the relay tunnel; the hub never decrypts for those. */
export const VIA_RELAY_HEADER = 'x-omniclip-via-relay';
/** The device whose tunnel a relayed request came through; its token must belong to that device. */
const TUNNEL_DEVICE_HEADER = 'x-omniclip-tunnel-device';

const PAIR_CODE_TTL = 10 * 60 * 1000;
const MAX_FAILED_PAIRS = 10;

export class Hub extends EventEmitter {
  readonly store: Store;
  private opts: Required<Pick<HubOptions, 'portTls' | 'portHttp'>> & HubOptions;
  private ca!: KeyPair;
  private servers: FastifyInstance[] = [];
  private sockets = new Map<string, Set<WebSocket>>();
  private socketInfo = new WeakMap<WebSocket, SocketInfo>();
  private pairing: PairingCode = { code: '', expiresAt: 0 };
  private failedPairs = 0;
  private rotateTimer?: NodeJS.Timeout;
  private ips: string[] = [];
  localDeviceId = '';
  /** Where each connected desktop reached us from; any of them may become the next hub. */
  private peerAddresses = new Map<string, string[]>();
  private expiry = new Map<string, NodeJS.Timeout>();
  private relayLink?: RelayLink;

  constructor(opts: HubOptions) {
    super();
    this.opts = { portTls: HUB_PORT_TLS, portHttp: HUB_PORT_HTTP, ...opts };
    fs.mkdirSync(opts.dataDir, { recursive: true });
    const seed = opts.seedRegistry;
    this.store = new Store(
      opts.dataDir,
      seed ? { networkId: seed.networkId, devices: seed.devices, keys: seed.keys, relay: seed.relay } : undefined,
      undefined,
      opts.historyKey,
    );
    if (this.store.historyLost) this.log('saved history could not be decrypted (the key changed); starting a new history');
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

  /** The TLS server, which the relay tunnel replays requests into. */
  get server(): FastifyInstance | undefined {
    return this.servers[0];
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
    this.store
      .encryptExistingBlobs()
      .then((n) => n && this.log(`encrypted ${n} saved file(s)`))
      .catch((err) => this.log(`could not encrypt saved files: ${String(err)}`));
    this.log(`hub ${this.networkId} listening on ${this.urls().tls.join(', ') || `:${this.opts.portTls}`}`);
    this.restartRelayLink();
  }

  async stop(): Promise<void> {
    this.relayLink?.stop();
    this.relayLink = undefined;
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
    const record: DeviceRecord = {
      id: crypto.randomUUID(),
      name,
      platform,
      createdAt: now,
      lastSeen: now,
      tokenHash: hashToken(token),
      tunnelKey: newTunnelKey(),
    };
    this.store.addDevice(record);
    this.devicesChanged();
    return this.pairResponse(token, record);
  }

  private pairResponse(token: string, record: DeviceRecord): PairResponse {
    const relay = this.store.relay;
    return {
      token,
      deviceId: record.id,
      networkId: this.networkId,
      caPem: this.ca.certPem,
      keys: this.store.keys,
      tunnelKey: this.tunnelKeyFor(record),
      ...(relay ? { relay } : {}),
    };
  }

  /** Devices paired before v0.8 get their tunnel key the next time they connect on the local network. */
  private tunnelKeyFor(record: DeviceRecord): string {
    if (!record.tunnelKey) this.store.setTunnelKey(record.id, (record.tunnelKey = newTunnelKey()));
    return record.tunnelKey;
  }

  /** Registers the desktop running this hub as a device without needing a pairing code. */
  createLocalDevice(name: string, platform: Platform, existingToken?: string): PairResponse {
    const existing = existingToken ? this.store.deviceByToken(existingToken) : undefined;
    const res = existing ? this.pairResponse(existingToken!, existing) : this.issueDevice(name, platform);
    this.localDeviceId = res.deviceId;
    return res;
  }

  listDevices(): Device[] {
    return this.store.devices().map(({ tokenHash: _t, tunnelKey: _k, ...d }) => {
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
      this.afterQueued(ws, () => ws.close());
    }
    this.sockets.delete(id);
    if (removed) {
      // the removed device knows the current key, so new clips use a fresh one it never sees
      const keys = rotateKeyring(this.store.keys);
      this.store.setKeys(keys);
      this.broadcast({ type: 'keys', keys });
      this.devicesChanged();
    }
    return removed;
  }

  registry(): Registry {
    const relay = this.store.relay;
    return { networkId: this.networkId, devices: this.store.devices(), ca: this.ca, keys: this.store.keys, ...(relay ? { relay } : {}) };
  }

  get relay(): RelayConfig | undefined {
    return this.store.relay;
  }

  /** Sets (or with `undefined`, removes) the internet relay and tells every device. */
  setRelay(relay: RelayConfig | undefined): void {
    this.store.setRelay(relay);
    this.broadcast({ type: 'relay', relay: relay ?? null });
    this.devicesChanged();
    if (this.servers.length) this.restartRelayLink();
  }

  /** Sets the relay address, keeping the network's relay token (or making one the first time). */
  useRelayUrl(url: string | undefined): void {
    const clean = url?.trim();
    this.setRelay(clean ? { url: clean, token: this.store.relay?.token ?? crypto.randomBytes(24).toString('base64url') } : undefined);
  }

  get relayStatus(): { status: RelayStatus; detail: string } {
    return { status: this.relayLink?.status ?? 'off', detail: this.relayLink?.detail ?? '' };
  }

  private restartRelayLink(): void {
    this.relayLink?.stop();
    this.relayLink = undefined;
    const relay = this.store.relay;
    if (relay) {
      const link = new RelayLink(
        {
          networkId: this.networkId,
          tunnelKeyFor: (id) => this.store.devices().find((d) => d.id === id)?.tunnelKey,
          inject: async (deviceId, req) => {
            const res = await this.server!.inject({
              method: req.method as 'GET',
              url: req.path,
              headers: { ...req.headers, [VIA_RELAY_HEADER]: '1', [TUNNEL_DEVICE_HEADER]: deviceId },
              ...(req.body ? { payload: req.body } : {}),
            });
            return { status: res.statusCode, headers: res.headers as Record<string, string>, body: res.rawPayload };
          },
          attachTunnelSocket: (deviceId, token, socket) => {
            const device = this.store.deviceByToken(token);
            if (!device || device.id !== deviceId) return false;
            this.attachSocket(device, socket as unknown as WebSocket, { e2e: true, viaRelay: true });
            return true;
          },
        },
        relay,
        (m) => this.log(m),
      );
      link.on('status', (status, detail) => this.emit('relayStatus', { status, detail }));
      this.relayLink = link;
      link.start();
    }
    this.emit('relayStatus', this.relayStatus);
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

  /** Plain text from a client that doesn't encrypt (Apple Shortcut, basic mode, v0.7 apps): the hub encrypts it. */
  async addTextClip(device: DeviceRecord, text: string, opts: ClipOptions = {}, rich: RichText = {}): Promise<Clip> {
    const sensitive = opts.sensitive ?? detectSensitive(text) !== null;
    // secrets are kept as bare text; formatting that's too big is dropped
    const keep = (v?: string) => (!sensitive && v && Buffer.byteLength(v) <= MAX_RICH_BYTES ? v : undefined);
    const payload: ClipPayload = { text, html: keep(rich.html), rtf: keep(rich.rtf), hash: sha256(text) };
    return this.addEncryptedText(device, await sealJson(this.store.keys, payload), Buffer.byteLength(text), { ...opts, sensitive });
  }

  /** Text the sending device already encrypted. The hub can't see it, so the sender flags passwords. */
  addEncryptedText(device: DeviceRecord, enc: Envelope, size: number, opts: ClipOptions = {}): Clip {
    const sensitive = opts.sensitive === true;
    const clip: Clip = {
      id: crypto.randomUUID(),
      kind: 'text',
      mime: 'text/plain',
      size,
      hash: '',
      enc,
      sourceDeviceId: device.id,
      sourceName: device.name,
      createdAt: Date.now(),
      ...target(opts),
      ...(sensitive ? { sensitive: true, expiresAt: Date.now() + (this.opts.sensitiveTtlMs ?? SENSITIVE_TTL_MS) } : {}),
    };
    this.publishClip(clip);
    return clip;
  }

  /**
   * Streams a file the sender already encrypted into the blob store. `size` is the plain size the
   * sender reports. Returns null if the upload hit the size limit.
   */
  private async addEncryptedBlob(
    device: DeviceRecord,
    source: Readable & { truncated?: boolean },
    kind: 'image' | 'file',
    enc: Envelope,
    size: number,
    folder: boolean,
    opts: ClipOptions,
  ): Promise<Clip | null> {
    const id = crypto.randomUUID();
    if (!(await this.writeBlob(id, source))) return null;
    const clip: Clip = {
      id,
      kind,
      mime: 'application/octet-stream',
      size,
      ...(folder ? { folder: true } : {}),
      hash: '',
      enc,
      sourceDeviceId: device.id,
      sourceName: device.name,
      createdAt: Date.now(),
      ...target(opts),
    };
    this.publishClip(clip);
    return clip;
  }

  /** A file from a client that doesn't encrypt: the hub encrypts it before storing. */
  private async addPlainBlob(
    device: DeviceRecord,
    data: Buffer,
    mimeType: string,
    filename: string | undefined,
    forceFile: boolean,
    opts: ClipOptions,
    folder = false,
  ): Promise<Clip> {
    const mime = mimeType || 'application/octet-stream';
    const isFolder = folder && mime === 'application/zip';
    const kind = forceFile || isFolder || !mime.startsWith('image/') ? 'file' : 'image';
    const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
    const name = filename || (kind === 'image' ? `image.${ext}` : `file.${ext}`);
    const keys = this.store.keys;
    const enc = await sealJson(keys, { name, mime, hash: sha256(data) } satisfies ClipPayload);
    const sealed = await encryptBlob(keys, data);
    return (await this.addEncryptedBlob(device, Readable.from([Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength)]), kind, enc, data.length, isFolder, opts))!;
  }

  /** Writes a blob; false if the upload was cut off at the size limit. */
  private async writeBlob(id: string, source: Readable & { truncated?: boolean }): Promise<boolean> {
    const dest = this.store.blobPath(id);
    try {
      await pipeline(source, new PassThrough(), ...this.store.blobSink(id));
    } catch (err) {
      fs.rmSync(dest, { force: true });
      throw err;
    }
    if (source.truncated) {
      fs.rmSync(dest, { force: true });
      return false;
    }
    return true;
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
    for (const [id, set] of this.sockets) {
      if (!visibleTo(clip, id)) continue;
      for (const ws of set) this.send(ws, msg);
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

  // ---- decrypting for clients that don't encrypt ----

  /** The clip with its contents decrypted, or null if it can't be (an unknown key). */
  private async plainClip(clip: Clip): Promise<Clip | null> {
    try {
      return await decryptClip(clip, this.store.keys);
    } catch {
      return null;
    }
  }

  private async plainClips(clips: Clip[]): Promise<Clip[]> {
    return (await Promise.all(clips.map((c) => this.plainClip(c)))).filter((c): c is Clip => !!c);
  }

  private async plainSnippets(snippets: Snippet[]): Promise<Snippet[]> {
    const out = await Promise.all(snippets.map((s) => decryptClip({ ...s, hash: '' }, this.store.keys).then(({ hash: _h, ...rest }) => rest as Snippet, () => null)));
    return out.filter((s): s is Snippet => !!s);
  }

  /** What a socket without end-to-end support receives instead of `msg` (null: nothing). */
  private async plainMessage(msg: ServerMessage): Promise<ServerMessage | null> {
    switch (msg.type) {
      case 'hello': {
        const { keys: _k, tunnelKey: _t, relay: _r, ...rest } = msg;
        return {
          ...rest,
          history: await this.plainClips(msg.history),
          pinned: await this.plainClips(msg.pinned ?? []),
          snippets: await this.plainSnippets(msg.snippets ?? []),
        };
      }
      case 'clip:new':
      case 'clip:update': {
        const clip = await this.plainClip(msg.clip);
        return clip ? { ...msg, clip } : null;
      }
      case 'snippets':
        return { type: 'snippets', snippets: await this.plainSnippets(msg.snippets) };
      case 'keys':
      case 'relay':
        return null;
      default:
        return msg;
    }
  }

  // ---- snippets ----

  private snippetsChanged(): void {
    this.broadcast({ type: 'snippets', snippets: this.store.snippets() });
  }

  async putSnippet(id: string, body: { enc: Envelope } | SnippetPayload): Promise<Snippet> {
    const enc = 'enc' in body ? body.enc : await sealJson(this.store.keys, body);
    const snippet: Snippet = { id, enc, updatedAt: Date.now() };
    this.store.putSnippet(snippet);
    this.snippetsChanged();
    return snippet;
  }

  removeSnippet(id: string): boolean {
    const removed = this.store.removeSnippet(id);
    if (removed) this.snippetsChanged();
    return removed;
  }

  // ---- transport ----

  private send(ws: WebSocket, msg: ServerMessage): void {
    const info = this.socketInfo.get(ws);
    if (!info || info.e2e) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      return;
    }
    info.queue = info.queue
      .then(async () => {
        const plain = await this.plainMessage(msg);
        if (plain && ws.readyState === ws.OPEN) ws.send(JSON.stringify(plain));
      })
      .catch((err) => this.log(`send failed: ${String(err)}`));
  }

  /** Runs `fn` once everything already sent to this socket has gone out. */
  private afterQueued(ws: WebSocket, fn: () => void): void {
    const info = this.socketInfo.get(ws);
    if (!info || info.e2e) return fn();
    info.queue = info.queue.then(fn);
  }

  private broadcast(msg: ServerMessage): void {
    for (const set of this.sockets.values()) for (const ws of set) this.send(ws, msg);
  }

  private authenticate(req: FastifyRequest): DeviceRecord | undefined {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.query as Record<string, string | undefined>).token;
    const device = token ? this.store.deviceByToken(token) : undefined;
    // through the relay, a device can only act as itself (the device whose tunnel key opened the tunnel)
    const tunnel = req.headers[TUNNEL_DEVICE_HEADER];
    if (device && tunnel && device.id !== tunnel) return undefined;
    return device;
  }

  private requireDevice(req: FastifyRequest, reply: FastifyReply): DeviceRecord | undefined {
    const device = this.authenticate(req);
    if (!device) void reply.code(401).send({ error: 'unauthorized' });
    return device;
  }

  /**
   * Hands a connected device's socket to the hub: greets it and keeps it updated. Used for real
   * WebSockets and for sockets tunnelled through the relay. `e2e`: the device decrypts by itself.
   */
  attachSocket(device: DeviceRecord, socket: WebSocket, opts: { e2e: boolean; remote?: string; viaRelay?: boolean }): void {
    let set = this.sockets.get(device.id);
    if (!set) this.sockets.set(device.id, (set = new Set()));
    set.add(socket);
    this.socketInfo.set(socket, { e2e: opts.e2e, queue: Promise.resolve() });
    this.store.touchDevice(device.id);
    const remote = opts.remote?.replace(/^::ffff:/, '');
    if (isDesktopPlatform(device.platform) && remote && remote !== '127.0.0.1' && remote !== '::1') this.peerAddresses.set(device.id, [remote]);

    const relay = this.store.relay;
    this.send(socket, {
      type: 'hello',
      deviceId: device.id,
      networkId: this.networkId,
      hubDeviceId: this.localDeviceId,
      history: this.store.clips(50, device.id),
      pinned: this.store.pinnedClips(device.id),
      devices: this.listDevices(),
      keys: this.store.keys,
      // a tunnel key is only ever handed out on the local network
      ...(opts.viaRelay ? {} : { tunnelKey: this.tunnelKeyFor(device) }),
      ...(relay ? { relay } : {}),
      snippets: this.store.snippets(),
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
  }

  private buildServer(https?: { key: string; cert: string }): FastifyInstance {
    const app = Fastify({ logger: false, bodyLimit: (MAX_TEXT_BYTES + 2 * MAX_RICH_BYTES) * 2, ...(https ? { https } : {}) }) as unknown as FastifyInstance;

    app.register(fastifyMultipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
    app.register(fastifyWebsocket);
    app.addContentTypeParser(/^(image|video|audio|application\/(octet-stream|pdf|zip))/, { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) =>
      done(null, body),
    );

    app.addHook('onSend', async (req, reply) => {
      // allow the Apple Shortcut / other origins to call the API with a bearer token
      if (req.url.startsWith('/api/') || req.url === '/ca.crt') {
        reply.header('Access-Control-Allow-Origin', '*');
        reply.header('Access-Control-Allow-Headers', `Authorization, Content-Type, X-Filename, ${E2E_HEADER}`);
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      }
    });
    app.options('/api/*', async (_req, reply) => reply.code(204).send());

    // Through the relay only end-to-end clients are served, and pairing is local-only.
    app.addHook('onRequest', async (req, reply) => {
      if (!req.headers[VIA_RELAY_HEADER]) return;
      if (req.url.startsWith('/api/pair')) return reply.code(403).send({ error: 'pairing only works on the local network' });
      if (req.headers[E2E_HEADER] !== '1') return reply.code(403).send({ error: 'only end-to-end encrypted clients can connect through the relay' });
    });

    const e2e = (req: FastifyRequest) => req.headers[E2E_HEADER] === '1';
    const forClient = async (req: FastifyRequest, clip: Clip) => (e2e(req) ? clip : ((await this.plainClip(clip)) ?? clip));

    app.get('/api/info', async () => ({ app: 'omniclip', networkId: this.networkId, version: PROTOCOL_VERSION, secure: !!https, e2e: true }));

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
      if (query.pinned === '1') {
        const pinned = this.store.pinnedClips(device.id);
        return e2e(req) ? pinned : this.plainClips(pinned);
      }
      // end-to-end clients search their own decrypted history; here only older plain clips can match
      if (e2e(req)) return query.q ? this.store.search(query.q, limit, device.id) : this.store.clips(limit, device.id);
      const all = await this.plainClips(this.store.clips(undefined, device.id));
      const q = query.q?.trim().toLowerCase();
      const found = q ? all.filter((c) => !c.sensitive && ((c.text ?? '').toLowerCase().includes(q) || (c.name ?? '').toLowerCase().includes(q))) : all;
      return found.slice(0, limit ?? found.length);
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
      return forClient(req, clip);
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
        const field = (name: string) => (part.fields[name] as { value?: string } | undefined)?.value;
        const folder = field('folder') === '1';
        // end-to-end: the file is already encrypted and its name, type and hash are in `enc`
        const encField = field('enc');
        if (encField) {
          const enc = EnvelopeSchema.safeParse(JSON.parse(encField));
          if (!enc.success) return reply.code(400).send({ error: 'bad enc field' });
          const kind = field('kind') === 'image' ? 'image' : 'file';
          const clip = await this.addEncryptedBlob(device, part.file, kind, enc.data, Number(field('size')) || 0, folder, opts);
          return clip ?? reply.code(413).send({ error: 'file too large' });
        }
        const data = await part.toBuffer(); // throws 413 past the size limit
        const clip = await this.addPlainBlob(device, data, part.mimetype, part.filename, field('kind') === 'file', opts, folder);
        return forClient(req, clip);
      }

      // raw binary body, e.g. an image from an Apple Shortcut's "Get Clipboard"
      if (Buffer.isBuffer(req.body)) {
        const mime = (req.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!.trim();
        const name = req.headers['x-filename'] ? decodeURIComponent(String(req.headers['x-filename'])) : undefined;
        return forClient(req, await this.addPlainBlob(device, req.body, mime, name, false, opts));
      }

      const encrypted = EncryptedTextRequestSchema.safeParse(req.body);
      if (encrypted.success) return this.addEncryptedText(device, encrypted.data.enc, encrypted.data.size, opts);

      // JSON {text, html?, rtf?} or a raw text/plain body (handy for Apple Shortcuts)
      const body = typeof req.body === 'string' ? { text: req.body } : TextClipRequestSchema.safeParse(req.body).data;
      if (!body?.text) return reply.code(400).send({ error: 'expected {"text": "..."} or a file upload' });
      if (Buffer.byteLength(body.text) > MAX_TEXT_BYTES) return reply.code(413).send({ error: 'text too large' });
      return forClient(req, await this.addTextClip(device, body.text, opts, { html: body.html, rtf: body.rtf }));
    });

    app.get('/api/clips/:id/blob', async (req, reply) => {
      const device = this.requireDevice(req, reply);
      if (!device) return;
      const clip = this.store.clip((req.params as { id: string }).id, device.id);
      if (!clip || clip.kind === 'text') return reply.code(404).send({ error: 'not found' });
      reply.header('Cache-Control', 'private, max-age=31536000, immutable');
      // end-to-end clients get the file exactly as it was uploaded
      if (e2e(req)) return reply.header('Content-Type', 'application/octet-stream').send(this.store.openBlob(clip.id));
      const plain = await this.plainClip(clip);
      if (!plain) return reply.code(404).send({ error: 'not found' });
      let data: Buffer = await streamToBuffer(this.store.openBlob(clip.id));
      if (clip.enc && isEncryptedBlob(data)) {
        const out = await decryptBlob(this.store.keys, data);
        data = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
      }
      const disposition = plain.kind === 'image' ? 'inline' : 'attachment';
      return reply
        .header('Content-Type', plain.mime === 'application/octet-stream' && clip.enc ? 'application/octet-stream' : plain.mime)
        .header('Content-Length', data.length)
        .header('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(plain.name ?? clip.id)}`)
        .send(data);
    });

    // the relay address is set from a computer's Settings; never through the relay itself
    app.get('/api/relay', async (req, reply) => {
      if (!this.requireDevice(req, reply)) return;
      return { url: this.store.relay?.url ?? '', ...this.relayStatus };
    });

    app.put('/api/relay', async (req, reply) => {
      const device = this.requireDevice(req, reply);
      if (!device) return;
      if (!isDesktopPlatform(device.platform) || req.headers[VIA_RELAY_HEADER]) return reply.code(403).send({ error: 'only computers on the local network can change the relay' });
      const url = (req.body as { url?: unknown } | undefined)?.url;
      if (typeof url !== 'string') return reply.code(400).send({ error: 'expected {"url": "..."}' });
      if (url.trim() && !/^(https?|wss?):\/\/[^\s/]+|^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(url.trim())) return reply.code(400).send({ error: 'That relay address is not valid.' });
      this.useRelayUrl(url);
      return { url: this.store.relay?.url ?? '', ...this.relayStatus };
    });

    app.get('/api/snippets', async (req, reply) => {
      if (!this.requireDevice(req, reply)) return;
      return e2e(req) ? this.store.snippets() : this.plainSnippets(this.store.snippets());
    });

    app.put('/api/snippets/:id', async (req, reply) => {
      if (!this.requireDevice(req, reply)) return;
      const id = (req.params as { id: string }).id;
      if (!/^[\w-]{1,64}$/.test(id)) return reply.code(400).send({ error: 'bad snippet id' });
      const enc = EnvelopeSchema.safeParse((req.body as { enc?: unknown } | undefined)?.enc);
      if (enc.success) return this.putSnippet(id, { enc: enc.data });
      const plain = SnippetPayloadSchema.safeParse(req.body);
      if (!plain.success) return reply.code(400).send({ error: 'expected {"name", "text", "keyword"?}' });
      const saved = await this.putSnippet(id, plain.data);
      return e2e(req) ? saved : (await this.plainSnippets([saved]))[0];
    });

    app.delete('/api/snippets/:id', async (req, reply) => {
      if (!this.requireDevice(req, reply)) return;
      if (!this.removeSnippet((req.params as { id: string }).id)) return reply.code(404).send({ error: 'not found' });
      return { ok: true };
    });

    app.register(async (scope) => {
      scope.get('/ws', { websocket: true }, (socket, req) => {
        const device = this.authenticate(req);
        if (!device) {
          socket.close(4401, 'unauthorized');
          return;
        }
        this.attachSocket(device, socket, { e2e: (req.query as Record<string, string | undefined>).e2e === '1', remote: req.socket.remoteAddress });
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

function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function newTunnelKey(): string {
  return toBase64(crypto.randomBytes(32));
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
