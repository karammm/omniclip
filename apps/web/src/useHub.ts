import { useEffect, useRef, useState } from 'preact/hooks';
import { RelayConnection, e2eAvailable, parseServerMessage, type Clip, type Device, type Keyring, type RelayConfig, type ServerMessage } from '@omniclip/protocol';
import { hubBaseUrl, readable, readableAll, readableSnippets, setRelayConnection, wsUrl, type PlainSnippet } from './api';

export type Status = 'connecting' | 'online' | 'offline';

/** Keys, tunnel key or relay sent by the hub, to be saved in the session. `relay: null` removes it. */
export interface E2EUpdate {
  keys?: Keyring;
  tunnelKey?: string;
  relay?: RelayConfig | null;
}

/** What's needed to reach the hub through the internet relay when it isn't reachable directly. */
export interface RelayAccess {
  networkId: string;
  deviceId: string;
  tunnelKey?: string;
  relay?: RelayConfig;
  keys?: Keyring;
}

const RELAY_AFTER_MS = 8000;
const LAN_PROBE_MS = 30_000;

/** Keeps a WebSocket to the hub open (reconnecting with backoff) and mirrors history + devices. */
/** `hub` is only a dependency: when the native app moves to a new hub address, the socket reconnects there. */
export function useHub(token: string | null, onRevoked: () => void, hub?: string, onE2E?: (u: E2EUpdate) => void, access?: RelayAccess) {
  const [status, setStatus] = useState<Status>('connecting');
  const [via, setVia] = useState<'lan' | 'relay'>('lan');
  const accessRef = useRef(access);
  accessRef.current = access;
  const [clips, setClips] = useState<Clip[]>([]);
  const [pinned, setPinned] = useState<Clip[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [snippets, setSnippets] = useState<PlainSnippet[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const revokedRef = useRef(onRevoked);
  revokedRef.current = onRevoked;
  const e2eRef = useRef(onE2E);
  e2eRef.current = onE2E;

  useEffect(() => {
    if (!token) return;
    let stopped = false;
    let delay = 500;
    let timer: number | undefined;
    let ping: number | undefined;
    let probe: number | undefined;
    let wasOnline = false;
    let offlineSince = Date.now();
    let useRelay = false;
    let relayConn: RelayConnection | null = null;
    const canRelay = () => {
      const a = accessRef.current;
      return !!(a?.relay && a.tunnelKey && a.keys && e2eAvailable());
    };
    const wentOffline = () => {
      if (wasOnline) offlineSince = Date.now();
      wasOnline = false;
      setStatus('offline');
    };
    const retryLater = (max: number) => {
      if (stopped) return;
      timer = window.setTimeout(connect, delay);
      delay = Math.min(delay * 2, max);
    };

    // messages are decrypted one at a time so they're applied in the order they arrived
    let inbox = Promise.resolve();
    const handle = async (msg: ServerMessage) => {
      if (msg.type === 'hello') {
        const update: E2EUpdate = { ...(msg.keys ? { keys: msg.keys } : {}), ...(msg.tunnelKey ? { tunnelKey: msg.tunnelKey } : {}), ...(msg.relay ? { relay: msg.relay } : {}) };
        if (Object.keys(update).length) e2eRef.current?.(update);
        const [history, pins, snips] = await Promise.all([readableAll(msg.history), readableAll(msg.pinned ?? []), readableSnippets(msg.snippets ?? [])]);
        setClips(history);
        setPinned(pins);
        setSnippets(snips);
        setDevices(msg.devices);
      } else if (msg.type === 'clip:new') {
        const clip = await readable(msg.clip);
        if (clip) setClips((prev) => [clip, ...prev.filter((c) => c.id !== clip.id)].slice(0, 200));
      } else if (msg.type === 'clip:update') {
        const c = await readable(msg.clip);
        if (!c) return;
        setClips((prev) => prev.map((x) => (x.id === c.id ? c : x)));
        setPinned((prev) => (c.pinned ? [c, ...prev.filter((x) => x.id !== c.id)] : prev.filter((x) => x.id !== c.id)));
      } else if (msg.type === 'keys') {
        e2eRef.current?.({ keys: msg.keys });
      } else if (msg.type === 'relay') {
        e2eRef.current?.({ relay: msg.relay });
      } else if (msg.type === 'snippets') {
        setSnippets(await readableSnippets(msg.snippets));
      } else if (msg.type === 'clip:remove') {
        setClips((prev) => prev.filter((x) => x.id !== msg.id));
        setPinned((prev) => prev.filter((x) => x.id !== msg.id));
      } else if (msg.type === 'devices') {
        setDevices(msg.devices);
      } else if (msg.type === 'revoked') {
        stopped = true;
        revokedRef.current();
      }
    };

    /** Away from home: the same live socket, carried by the end-to-end encrypted relay tunnel. */
    const connectRelay = () => {
      const a = accessRef.current!;
      setStatus('connecting');
      const conn = new RelayConnection(a.relay!, a.networkId, a.deviceId, a.tunnelKey!);
      conn.open().then(
        () => {
          if (stopped) return conn.close();
          relayConn = conn;
          setRelayConnection(conn);
          delay = 500;
          wasOnline = true;
          setVia('relay');
          setStatus('online');
          conn.onSocketMessage = (raw) => {
            const msg = parseServerMessage(raw);
            if (msg) inbox = inbox.then(() => handle(msg)).catch(() => {});
          };
          conn.onClose = () => {
            clearInterval(ping);
            clearInterval(probe);
            if (relayConn === conn) {
              relayConn = null;
              setRelayConnection(null);
            }
            setVia('lan');
            useRelay = false;
            wentOffline();
            retryLater(15_000);
          };
          conn.openSocket(`?token=${encodeURIComponent(token)}&e2e=1`);
          ping = window.setInterval(() => conn.sendSocket('{"type":"ping"}'), 25_000);
          // back home: switch to the direct connection once the hub answers on the local network
          probe = window.setInterval(() => {
            const ctrl = new AbortController();
            const t = window.setTimeout(() => ctrl.abort(), 4000);
            fetch(`${hubBaseUrl()}/api/info`, { signal: ctrl.signal })
              .then((r) => r.ok && relayConn === conn && conn.close('back on the local network'))
              .catch(() => {})
              .finally(() => clearTimeout(t));
          }, LAN_PROBE_MS);
        },
        () => {
          useRelay = false;
          wentOffline();
          retryLater(15_000);
        },
      );
    };

    const connect = () => {
      if (stopped) return;
      if (useRelay) return connectRelay();
      setStatus('connecting');
      const ws = new WebSocket(wsUrl(token));
      wsRef.current = ws;
      ws.onopen = () => {
        delay = 500;
        wasOnline = true;
        setVia('lan');
        setStatus('online');
        ping = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), 25_000);
      };
      ws.onmessage = (ev) => {
        const msg = parseServerMessage(String(ev.data));
        if (msg) inbox = inbox.then(() => handle(msg)).catch(() => {});
      };
      ws.onclose = (ev) => {
        clearInterval(ping);
        if (wsRef.current === ws) wsRef.current = null;
        if (ev.code === 4401) {
          stopped = true;
          revokedRef.current();
          return;
        }
        wentOffline();
        // away from home: after a few seconds without the hub, go through the relay
        if (canRelay()) {
          const left = RELAY_AFTER_MS - (Date.now() - offlineSince);
          if (left <= 0) useRelay = true;
          // don't let the backoff push the relay attempt far past the moment it's due
          delay = left <= 0 ? 300 : Math.min(delay, left + 50);
        }
        retryLater(10_000);
      };
    };

    // iOS suspends sockets in the background; reconnect as soon as the app is visible again
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || stopped) return;
      const ws = wsRef.current;
      if (relayConn?.connected) return;
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
      clearInterval(probe);
      document.removeEventListener('visibilitychange', onVisible);
      wsRef.current?.close();
      if (relayConn) {
        relayConn.onClose = undefined;
        relayConn.close();
        setRelayConnection(null);
      }
    };
  }, [token, hub]);

  return { status, via, clips, pinned, devices, snippets };
}
