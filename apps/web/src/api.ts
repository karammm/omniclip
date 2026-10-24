import { HUB_PORT_HTTP, type Clip, type Device, type PairResponse, type Platform } from '@omniclip/protocol';

/** True in the Android/iOS app (a `vite build --mode native` bundle), false in the browser PWA. */
export const NATIVE = import.meta.env.MODE === 'native';

export interface Session {
  token: string;
  deviceId: string;
  name: string;
  networkId: string;
  /** Hub base URL. Only set in the native app; the PWA is served by the hub itself. */
  hub?: string;
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

/**
 * Turns what the user scanned or typed into a hub URL and (optional) pairing code.
 * Accepts the desktop's QR link (`http://192.168.1.5:7879/setup#pair=123456`), a URL, or a bare IP/hostname.
 */
export function parseHubInput(input: string): { hub: string; code?: string } | null {
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
    return hub ? parseHubInput(`${hub}${url.searchParams.get('code') ? `#pair=${url.searchParams.get('code')}` : ''}`) : null;
  }
  if (!url.hostname) return null;
  const code = /pair=(\d{4,16})/.exec(url.hash + url.search)?.[1];
  // the app always uses the hub's plain-HTTP port; the HTTPS port only exists for browsers
  return { hub: `http://${url.hostname}:${HUB_PORT_HTTP}`, code };
}

export async function checkHub(hub: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${hub}/api/info`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok && ((await res.json()) as { app?: string }).app === 'omniclip';
  } catch {
    return false;
  }
}
