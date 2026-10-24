import type { Clip, Device, PairResponse, Platform } from '@omniclip/protocol';

export interface Session {
  token: string;
  deviceId: string;
  name: string;
  networkId: string;
}

const KEY = 'omniclip.session';

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null): void {
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
  const res = await fetch(path, { ...init, headers });
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
  return `/api/clips/${clip.id}/blob?token=${encodeURIComponent(token)}`;
}

export function wsUrl(token: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`;
}
