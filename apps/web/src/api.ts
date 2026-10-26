import { HUB_PORT_HTTP, HUB_PORT_TLS, type Clip, type Device, type PairResponse, type Platform } from '@omniclip/protocol';

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
}

const KEY = 'omniclip.session';

// The PWA calls its own origin. The native app is served from the device, so it calls the hub by address.
let hubBase = '';

export function setHubBase(url?: string): void {
  hubBase = (url ?? '').replace(/\/+$/, '');
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    const s = raw ? (JSON.parse(raw) as Session) : null;
    setHubBase(s?.hub);
    return s;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null): void {
  setHubBase(s?.hub);
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
  const res = await fetch(hubBase + path, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText);
  return body as T;
}

export function pair(code: string, name: string, platform: Platform): Promise<PairResponse> {
  return call('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name, platform }) });
}

export function sendText(token: string, text: string): Promise<Clip> {
  return call('/api/clips', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }, token);
}

export function sendFile(token: string, file: Blob, name: string, kind?: 'file'): Promise<Clip> {
  const form = new FormData();
  if (kind) form.append('kind', kind); // fields must precede the file part
  form.append('file', file, name);
  return call('/api/clips', { method: 'POST', body: form }, token);
}

export function searchClips(token: string, query: string, limit = 100): Promise<Clip[]> {
  return call(`/api/clips?limit=${limit}&q=${encodeURIComponent(query)}`, {}, token);
}

export function setPinned(token: string, id: string, pinned: boolean): Promise<Clip> {
  return call(`/api/clips/${encodeURIComponent(id)}/pin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pinned }) }, token);
}

export function listDevices(token: string): Promise<Device[]> {
  return call('/api/devices', {}, token);
}

export function blobUrl(token: string, clip: Clip): string {
  return `${hubBase}/api/clips/${clip.id}/blob?token=${encodeURIComponent(token)}`;
}

export function wsUrl(token: string): string {
  const q = `/ws?token=${encodeURIComponent(token)}`;
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
