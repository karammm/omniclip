import { useEffect, useRef, useState } from 'preact/hooks';
import { parseServerMessage, type Clip, type Device } from '@omniclip/protocol';
import { wsUrl } from './api';

export type Status = 'connecting' | 'online' | 'offline';

/** Keeps a WebSocket to the hub open (reconnecting with backoff) and mirrors history + devices. */
/** `hub` is only a dependency: when the native app moves to a new hub address, the socket reconnects there. */
export function useHub(token: string | null, onRevoked: () => void, hub?: string) {
  const [status, setStatus] = useState<Status>('connecting');
  const [clips, setClips] = useState<Clip[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const revokedRef = useRef(onRevoked);
  revokedRef.current = onRevoked;

  useEffect(() => {
    if (!token) return;
    let stopped = false;
    let delay = 500;
    let timer: number | undefined;
    let ping: number | undefined;

    const connect = () => {
      if (stopped) return;
      setStatus('connecting');
      const ws = new WebSocket(wsUrl(token));
      wsRef.current = ws;
      ws.onopen = () => {
        delay = 500;
        setStatus('online');
        ping = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), 25_000);
      };
      ws.onmessage = (ev) => {
        const msg = parseServerMessage(String(ev.data));
        if (!msg) return;
        if (msg.type === 'hello') {
          setClips(msg.history);
          setDevices(msg.devices);
        } else if (msg.type === 'clip:new') {
          setClips((prev) => [msg.clip, ...prev.filter((c) => c.id !== msg.clip.id)].slice(0, 200));
        } else if (msg.type === 'devices') {
          setDevices(msg.devices);
        } else if (msg.type === 'revoked') {
          stopped = true;
          revokedRef.current();
        }
      };
      ws.onclose = (ev) => {
        clearInterval(ping);
        if (wsRef.current === ws) wsRef.current = null;
        if (ev.code === 4401) {
          stopped = true;
          revokedRef.current();
          return;
        }
        setStatus('offline');
        if (!stopped) {
          timer = window.setTimeout(connect, delay);
          delay = Math.min(delay * 2, 10_000);
        }
      };
    };

    // iOS suspends sockets in the background; reconnect as soon as the app is visible again
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || stopped) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState > WebSocket.OPEN) {
        clearTimeout(timer);
        delay = 500;
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    connect();

    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(ping);
      document.removeEventListener('visibilitychange', onVisible);
      wsRef.current?.close();
    };
  }, [token, hub]);

  return { status, clips, devices };
}
