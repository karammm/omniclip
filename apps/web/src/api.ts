import {
  E2E_HEADER,
  HUB_PORT_HTTP,
  HUB_PORT_TLS,
  decryptBlob,
  decryptClip,
  detectSensitive,
  e2eAvailable,
  encryptBlob,
  isEncryptedBlob,
  sealJson,
  sha256Hex,
  type RelayConnection,
  type Clip,
  type Device,
  type Keyring,
  type PairResponse,
  type Platform,
  type RelayConfig,
  type Snippet,
  type SnippetPayload,
} from '@omniclip/protocol';

/** True in the Android/iOS app (a `vite build --mode native` bundle), false in the browser PWA. */
export const NATIVE = import.meta.env.MODE === 'native';

export interface Session {
  token: string;
  deviceId: string;
  name: string;
  networkId: string;
  /** Hub base URL (https://host:7878). Only set in the native app; the PWA is served by the hub itself. */
  hub?: string;
  /** The network's CA, pinned by the native app for TLS to the hub. */
  caPem?: string;
  /** Desktop addresses seen on this network: where to look for the hub after a failover. */
  candidates?: string[];
  /** End-to-end keyring, this device's relay tunnel key and the relay (hubs from v0.8 on). */
  keys?: Keyring;
  tunnelKey?: string;
  relay?: RelayConfig;
}

/** A snippet with its contents decrypted. */
export type PlainSnippet = Snippet & SnippetPayload;

const KEY = 'omniclip.session';

// The PWA calls its own origin. The native app is served from the device, so it calls the hub by address.
let hubBase = '';
/**
 * The keyring, when this device encrypts end to end. Browsers only have WebCrypto on HTTPS pages,
 * so in basic mode (plain HTTP) the hub encrypts and decrypts for us instead.
 */
let ring: Keyring | undefined;

/** Set while the hub is reached through the internet relay instead of directly. */
let relay: RelayConnection | null = null;

export function setRelayConnection(r: RelayConnection | null): void {
  relay = r;
}

/** fetch() to the hub, directly or through the relay tunnel. */
async function hubFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!relay) return fetch(hubBase + path, init);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => (headers[k] = v));
  let body: Uint8Array | undefined;
  if (init.body !== undefined && init.body !== null) {
    // FormData and strings are turned into bytes (with the multipart boundary) the way fetch would send them
    const req = new Request('http://relay.invalid/', { method: 'POST', headers, body: init.body as BodyInit });
    req.headers.forEach((v, k) => (headers[k] = v));
    body = new Uint8Array(await req.arrayBuffer());
  }
  const res = await relay.request(init.method ?? 'GET', path, headers, body);
  return new Response(res.status === 204 ? null : res.body, { status: res.status, headers: res.headers });
}

export function setHubBase(url?: string): void {
  hubBase = (url ?? '').replace(/\/+$/, '');
}

function useSession(s: Session | null): void {
  setHubBase(s?.hub);
  ring = s?.keys && e2eAvailable() ? s.keys : undefined;
}

/** Whether this device encrypts and decrypts clips itself. */
export function encrypting(): boolean {
  return !!ring;
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    const s = raw ? (JSON.parse(raw) as Session) : null;
    useSession(s);
    return s;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null): void {
  useSession(s);
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    // private mode: session lasts until reload
  }
}

export function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ipados';
  if (/iPhone|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'web';
}

export function defaultDeviceName(p: Platform): string {
  return { ios: 'iPhone', ipados: 'iPad', android: 'Android phone' }[p as string] ?? 'Browser';
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (ring) headers.set(E2E_HEADER, '1');
  const res = await hubFetch(path, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText);
  return body as T;
}

export function pair(code: string, name: string, platform: Platform): Promise<PairResponse> {
  return call('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name, platform }) });
}

/** `to`: a device id to send to just that device; everyone when omitted. */
function clipsPath(to?: string, sensitive?: boolean): string {
  const q = new URLSearchParams();
  if (to) q.set('to', to);
  if (sensitive !== undefined) q.set('sensitive', sensitive ? '1' : '0');
  const qs = q.toString();
  return qs ? `/api/clips?${qs}` : '/api/clips';
}

/** A clip as this device sees it: decrypted, or null if it can't be (a key this device doesn't have). */
export async function readable(clip: Clip): Promise<Clip | null> {
  try {
    return await decryptClip(clip, ring);
  } catch {
    return null;
  }
}

export async function readableAll(clips: Clip[]): Promise<Clip[]> {
  return (await Promise.all(clips.map(readable))).filter((c): c is Clip => !!c);
}

async function json(path: string, token: string, method: string, body: unknown): Promise<unknown> {
  return call(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, token);
}

/** `html`: the text's formatting, so it pastes with fonts and links on computers. */
export async function sendText(token: string, text: string, to?: string, html?: string): Promise<Clip> {
  if (!ring) return (await json(clipsPath(to), token, 'POST', html ? { text, html } : { text })) as Clip;
  // the hub can't read encrypted text, so this device decides whether it's a password
  const sensitive = detectSensitive(text) !== null;
  const enc = await sealJson(ring, { text, ...(html && !sensitive ? { html } : {}), hash: await sha256Hex(text) });
  const clip = (await json(clipsPath(to, sensitive), token, 'POST', { enc, size: new TextEncoder().encode(text).length })) as Clip;
  return (await readable(clip)) ?? clip;
}

export async function sendFile(token: string, file: Blob, name: string, kind?: 'file', to?: string): Promise<Clip> {
  const form = new FormData();
  if (ring) {
    // name, type and contents are encrypted; the hub only learns whether it's an image or a file
    const data = new Uint8Array(await file.arrayBuffer());
    const mime = file.type || 'application/octet-stream';
    form.append('kind', kind === 'file' || !mime.startsWith('image/') ? 'file' : 'image');
    form.append('size', String(data.length));
    form.append('enc', JSON.stringify(await sealJson(ring, { name, mime, hash: await sha256Hex(data) })));
    form.append('file', new Blob([await encryptBlob(ring, data)], { type: 'application/octet-stream' }), 'blob');
  } else {
    if (kind) form.append('kind', kind); // fields must precede the file part
    form.append('file', file, name);
  }
  const clip = await call<Clip>(clipsPath(to), { method: 'POST', body: form }, token);
  return (await readable(clip)) ?? clip;
}

/** Searches all history. Encrypted history is fetched and searched on this device. */
export async function searchClips(token: string, query: string, limit = 100): Promise<Clip[]> {
  if (!ring) return call(`/api/clips?limit=${limit}&q=${encodeURIComponent(query)}`, {}, token);
  const all = await readableAll(await call<Clip[]>('/api/clips', {}, token));
  const q = query.trim().toLowerCase();
  return all.filter((c) => !c.sensitive && ((c.text ?? '').toLowerCase().includes(q) || (c.name ?? '').toLowerCase().includes(q))).slice(0, limit);
}

export async function setPinned(token: string, id: string, pinned: boolean): Promise<Clip> {
  const clip = (await json(`/api/clips/${encodeURIComponent(id)}/pin`, token, 'POST', { pinned })) as Clip;
  return (await readable(clip)) ?? clip;
}

export async function readableSnippets(snippets: Snippet[]): Promise<PlainSnippet[]> {
  const out = await Promise.all(
    snippets.map((s) =>
      decryptClip({ ...s, hash: '' }, ring).then(
        ({ hash: _h, ...rest }) => rest as PlainSnippet,
        () => null,
      ),
    ),
  );
  return out.filter((s): s is PlainSnippet => !!s && !!s.text);
}

export async function saveSnippet(token: string, id: string, snippet: SnippetPayload): Promise<void> {
  await json(`/api/snippets/${encodeURIComponent(id)}`, token, 'PUT', ring ? { enc: await sealJson(ring, snippet) } : snippet);
}

export async function deleteSnippet(token: string, id: string): Promise<void> {
  await call(`/api/snippets/${encodeURIComponent(id)}`, { method: 'DELETE' }, token);
}

/** Downloads an image or file and decrypts it. */
export async function loadBlob(token: string, clip: Clip): Promise<Blob> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (ring) headers[E2E_HEADER] = '1';
  const res = await hubFetch(`/api/clips/${clip.id}/blob`, { headers });
  if (!res.ok) throw new ApiError(res.status, 'Could not download the file');
  const data = new Uint8Array(await res.arrayBuffer());
  const type = clip.mime || 'application/octet-stream';
  if (ring && isEncryptedBlob(data)) return new Blob([await decryptBlob(ring, data)], { type });
  return new Blob([data], { type });
}

export function listDevices(token: string): Promise<Device[]> {
  return call('/api/devices', {}, token);
}

/** The hub's address on the local network ('' for the web app the hub serves itself). */
export function hubBaseUrl(): string {
  return hubBase;
}

export function wsUrl(token: string): string {
  // ask for end-to-end mode whenever this device can encrypt; a device paired earlier gets the keyring in `hello`
  const q = `/ws?token=${encodeURIComponent(token)}${e2eAvailable() ? '&e2e=1' : ''}`;
  if (hubBase) return hubBase.replace(/^http/, 'ws') + q;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${q}`;
}

export interface HubTarget {
  host: string;
  /** https://host:7878, used for everything once the CA is pinned */
  hub: string;
  /** http://host:7879, only for discovery and fetching the CA certificate */
  http: string;
  code?: string;
  /** CA pin from the QR code (base64url SHA-256 of the certificate) */
  ca?: string;
}

export function hubUrls(host: string): { hub: string; http: string } {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return { hub: `https://${h}:${HUB_PORT_TLS}`, http: `http://${h}:${HUB_PORT_HTTP}` };
}

export function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^\[|\]$/g, '');
}

/**
 * Turns what the user scanned or typed into a hub target.
 * Accepts the desktop's QR link (`http://192.168.1.5:7879/setup#pair=123456&ca=…`), an omniclip:// link,
 * any URL, or a bare IP/hostname.
 */
export function parseHubInput(input: string): HubTarget | null {
  const text = input.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return null;
  }
  if (url.protocol === 'omniclip:') {
    const hub = url.searchParams.get('hub');
    if (!hub) return null;
    const target = parseHubInput(hub);
    if (!target) return null;
    return { ...target, code: url.searchParams.get('code') ?? undefined, ca: url.searchParams.get('ca') ?? undefined };
  }
  if (!url.hostname) return null;
  const params = new URLSearchParams(url.hash.slice(1) || url.search.slice(1));
  const code = /^\d{4,16}$/.test(params.get('pair') ?? '') ? params.get('pair')! : undefined;
  const host = hostOf(url.href);
  return { host, ...hubUrls(host), code, ca: params.get('ca') ?? undefined };
}

/** Returns the network ID of the hub answering at this plain-HTTP base, or null. */
export async function probeHub(http: string, timeoutMs = 4000): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${http}/api/info`, { signal: ctrl.signal });
    clearTimeout(timer);
    const info = (await res.json()) as { app?: string; networkId?: string };
    return res.ok && info.app === 'omniclip' ? (info.networkId ?? null) : null;
  } catch {
    return null;
  }
}

export async function fetchCaPem(http: string): Promise<string> {
  const res = await fetch(`${http}/ca.crt`);
  if (!res.ok) throw new Error(`could not fetch the hub certificate (${res.status})`);
  return res.text();
}

/** base64url SHA-256 of the certificate's DER bytes; matches the hub's `caPin`. */
export async function pinOf(pem: string): Promise<string> {
  const b64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', der));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
