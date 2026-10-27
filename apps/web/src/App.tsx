import { useEffect, useRef, useState } from 'preact/hooks';
import type { Clip, Device } from '@omniclip/protocol';
import {
  ApiError,
  blobUrl,
  defaultDeviceName,
  detectPlatform,
  fetchCaPem,
  hostOf,
  hubUrls,
  loadSession,
  NATIVE,
  pair,
  parseHubInput,
  pinOf,
  probeHub,
  saveSession,
  searchClips,
  sendFile,
  sendText,
  setPinned,
  setHubBase,
  type Session,
} from './api';
import { canCopyImages, canReadClipboard, copyImage, copyText, readClipboard, secure } from './clipboard';
import { findHub } from './discovery';
import { Setup } from './Setup';
import { useHub, type Status } from './useHub';

// inline MODE check so the browser build drops the native chunk entirely
const native = () => (import.meta.env.MODE === 'native' ? import('./native') : Promise.reject(new Error('native only')));

function pairCodeFromHash(): string | null {
  const m = location.hash.match(/pair=(\d{4,16})/);
  return m ? m[1]! : null;
}

function useToast(): [string | null, (msg: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number>();
  return [
    msg,
    (m: string) => {
      setMsg(m);
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setMsg(null), 2200);
    },
  ];
}

/**
 * Native app start-up: pin the network's CA before any request to the hub. Sessions from v0.2
 * talked plain HTTP; they fetch the CA once (trust on first use) and move to HTTPS.
 */
async function prepareNativeSession(s: Session): Promise<Session> {
  let next = s;
  if (s.hub?.startsWith('http:') || !s.caPem) {
    const host = hostOf(s.hub!);
    next = { ...s, hub: hubUrls(host).hub, caPem: await fetchCaPem(hubUrls(host).http) };
    saveSession(next);
  }
  await (await native()).trustCa(next.caPem!);
  return next;
}

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const [ready, setReady] = useState(!NATIVE || !session);
  const [startError, setStartError] = useState('');
  const [toast, showToast] = useToast();
  const path = location.pathname;

  useEffect(() => {
    if (ready || !session) return;
    let cancelled = false;
    const attempt = () =>
      prepareNativeSession(session)
        .then((s) => {
          if (cancelled) return;
          setSession(s);
          setReady(true);
        })
        .catch((err) => {
          // the hub is unreachable (offline, or v0.2 session upgrading); keep trying
          setStartError(err instanceof Error ? err.message : String(err));
          if (!cancelled) window.setTimeout(attempt, 3000);
        });
    attempt();
    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = () => {
    saveSession(null);
    setSession(null);
  };

  const updateSession = (s: Session) => {
    saveSession(s);
    setSession(s);
  };

  let page;
  if (!NATIVE && path.startsWith('/setup')) page = <Setup session={session} />;
  else if (!session)
    page = NATIVE ? (
      <NativePairScreen
        onPaired={(s) => {
          setSession(s);
          setReady(true);
        }}
      />
    ) : (
      <PairScreen onPaired={setSession} />
    );
  else if (!ready)
    page = (
      <main class="center">
        <img src="/icons/icon-192.png" alt="" width={72} height={72} />
        <p class="muted">Connecting to your OmniClip hub…</p>
        {startError && <p class="muted small">Still trying: {startError}</p>}
        <button class="ghost" onClick={signOut}>
          Pair with a different hub
        </button>
      </main>
    );
  else page = <Main session={session} onRevoked={signOut} onSession={updateSession} toast={showToast} />;

  return (
    <>
      {page}
      {toast && <div class="toast">{toast}</div>}
    </>
  );
}

// ---------------------------------------------------------------- pairing

function PairScreen({ onPaired }: { onPaired: (s: Session) => void }) {
  const platform = detectPlatform();
  const [code, setCode] = useState(pairCodeFromHash() ?? '');
  const [name, setName] = useState(defaultDeviceName(platform));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await pair(code.trim(), name.trim() || defaultDeviceName(platform), platform);
      const s: Session = { token: res.token, deviceId: res.deviceId, networkId: res.networkId, name };
      saveSession(s);
      history.replaceState(null, '', '/');
      onPaired(s);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the hub. Are you on the same Wi-Fi?');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main class="center">
      <img src="/icons/icon-192.png" alt="" width={72} height={72} />
      <h1>Join OmniClip</h1>
      <p class="muted">Enter the 6-digit code shown in the OmniClip menu on your Mac or PC.</p>
      <form class="card stack" onSubmit={submit}>
        <label>
          Pairing code
          <input inputMode="numeric" autoComplete="one-time-code" maxLength={16} value={code} onInput={(e) => setCode(e.currentTarget.value)} required />
        </label>
        <label>
          This device's name
          <input value={name} maxLength={64} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        {error && <p class="error">{error}</p>}
        <button class="primary" disabled={busy || code.length < 4}>
          {busy ? 'Pairing…' : 'Pair this device'}
        </button>
      </form>
      <a href={`/setup${location.hash}`}>Setup help</a>
    </main>
  );
}

/** The Android/iOS app: scan the QR code from the desktop's pairing window, or type the hub address and code. */
function NativePairScreen({ onPaired }: { onPaired: (s: Session) => void }) {
  const platform = detectPlatform();
  const [hub, setHub] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState(defaultDeviceName(platform));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const connect = async (hubInput: string, pairCode: string) => {
    setBusy(true);
    setError('');
    try {
      const target = parseHubInput(hubInput);
      if (!target) throw new Error('Enter the hub address shown in the OmniClip window, for example 192.168.1.5');
      if (!(await probeHub(target.http))) throw new Error(`No OmniClip hub at ${target.host}. Is this phone on the same Wi-Fi?`);
      // Pin the network's CA. With a QR code it must match the pin in the code; typed addresses trust it on first use.
      const caPem = await fetchCaPem(target.http);
      if (target.ca && (await pinOf(caPem)) !== target.ca) {
        throw new Error("Security check failed: this hub's certificate doesn't match the QR code. Make sure you're on your own Wi-Fi.");
      }
      await (await native()).trustCa(caPem);
      setHubBase(target.hub);
      const deviceName = name.trim() || defaultDeviceName(platform);
      const res = await pair((target.code ?? pairCode).trim(), deviceName, platform);
      const s: Session = { token: res.token, deviceId: res.deviceId, networkId: res.networkId, name: deviceName, hub: target.hub, caPem };
      saveSession(s);
      onPaired(s);
    } catch (err) {
      loadSession(); // restores the hub address of any existing session
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let off = () => {};
    let cancelled = false;
    void native()
      .then((n) =>
        n.pairLinks((url) => {
          const target = parseHubInput(url);
          if (!target?.code) return;
          setHub(target.host);
          setCode(target.code);
          void connect(url, target.code);
        }),
      )
      .then((dispose) => (cancelled ? dispose() : (off = dispose)));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const scan = async () => {
    setError('');
    try {
      const text = await (await native()).scanQr();
      if (!text) return;
      const target = parseHubInput(text);
      if (!target) return setError('That QR code is not from OmniClip.');
      setHub(target.host);
      if (target.code) {
        setCode(target.code);
        await connect(text, target.code);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the camera');
    }
  };

  return (
    <main class="center">
      <img src="/icons/icon-192.png" alt="" width={72} height={72} />
      <h1>Join OmniClip</h1>
      <p class="muted">
        On your Mac or PC, open the OmniClip window (or choose <b>Pair a phone or tablet…</b> in its menu), then scan the QR code.
      </p>
      <button class="primary big" onClick={scan} disabled={busy}>
        {busy ? 'Pairing…' : '📷 Scan QR code'}
      </button>
      <details class="card manual">
        <summary>Enter the code instead</summary>
        <form
          class="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void connect(hub, code);
          }}
        >
          <label>
            Hub address
            <input inputMode="url" autoCapitalize="off" autoCorrect="off" placeholder="192.168.1.5" value={hub} onInput={(e) => setHub(e.currentTarget.value)} required />
          </label>
          <label>
            Pairing code
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={16} value={code} onInput={(e) => setCode(e.currentTarget.value)} required />
          </label>
          <label>
            This device's name
            <input value={name} maxLength={64} onInput={(e) => setName(e.currentTarget.value)} />
          </label>
          <button class="primary" disabled={busy || code.length < 4 || !hub.trim()}>
            Pair this device
          </button>
        </form>
      </details>
      {error && <p class="error">{error}</p>}
    </main>
  );
}

// ---------------------------------------------------------------- main

const AUTO_SEND_KEY = 'omniclip.autoSend';
const LAST_SENT_KEY = 'omniclip.lastAutoSent';

function autoSendEnabled(): boolean {
  try {
    const v = localStorage.getItem(AUTO_SEND_KEY);
    // iOS asks for permission on every read unless the user allows pasting in Settings, so it starts off there
    return v === null ? detectPlatform() === 'android' : v === '1';
  } catch {
    return false;
  }
}

function fingerprint(c: NonNullable<Awaited<ReturnType<typeof readClipboard>>>): string {
  return c.kind === 'text' ? `t:${c.text.length}:${c.text.slice(0, 256)}` : `i:${c.blob.size}:${c.blob.type}`;
}

function Main({
  session,
  onRevoked,
  onSession,
  toast,
}: {
  session: Session;
  onRevoked: () => void;
  onSession: (s: Session) => void;
  toast: (m: string) => void;
}) {
  const { status, clips, pinned, devices } = useHub(session.token, onRevoked, session.hub);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Clip[] | null>(null);

  // search runs on the hub so it covers the whole history, not just what this device has loaded
  useEffect(() => {
    const q = query.trim();
    if (!q) return setResults(null);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchClips(session.token, q)
        .then((r) => !cancelled && setResults(r))
        .catch(() => !cancelled && setResults([]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, session.token]);

  const togglePin = (clip: Clip) =>
    setPinned(session.token, clip.id, !clip.pinned)
      .then((c) => {
        setResults((r) => r && r.map((x) => (x.id === c.id ? c : x)));
        toast(c.pinned ? 'Pinned' : 'Unpinned');
      })
      .catch((err) => toast(err instanceof Error ? err.message : 'Could not pin'));
  const [searching, setSearching] = useState(false);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // Native app: remember where the desktops are, so the hub can be found again after a failover
  useEffect(() => {
    if (!NATIVE) return;
    const seen = devices.flatMap((d) => (d.online ? (d.addresses ?? []) : []));
    if (!seen.length) return;
    const s = sessionRef.current;
    const merged = [...new Set([...seen, ...(s.candidates ?? [])])].slice(0, 12);
    if (merged.join() !== (s.candidates ?? []).join()) onSession({ ...s, candidates: merged });
  }, [devices]);

  // Native app: if the hub stays unreachable, look for it at the other desktops and on the subnet
  useEffect(() => {
    if (!NATIVE || status === 'online' || !session.hub) return;
    let cancelled = false;
    let timer: number;
    const search = async () => {
      setSearching(true);
      const s = sessionRef.current;
      const current = hostOf(s.hub!);
      const host = await findHub(s.networkId, current, s.candidates ?? [], () => cancelled);
      if (cancelled) return;
      setSearching(false);
      if (host && host !== current) {
        onSession({ ...s, hub: hubUrls(host).hub });
        toast('Reconnected to the new OmniClip hub');
      } else timer = window.setTimeout(search, 15_000);
    };
    timer = window.setTimeout(search, 8_000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setSearching(false);
    };
  }, [status, session.hub]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  // '' sends to every device; otherwise a device id
  const [target, setTarget] = useState('');
  const others = devices.filter((d) => d.id !== session.deviceId);
  const targetDevice = others.find((d) => d.id === target);
  const to = targetDevice?.id;
  const sentTo = targetDevice ? `Sent to ${targetDevice.name}` : 'Sent to all devices';
  useEffect(() => {
    if (target && devices.length && !targetDevice) setTarget('');
  }, [devices]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const clipsRef = useRef(clips);
  clipsRef.current = clips;

  // Native app: send whatever is on the clipboard when the app is opened (Android allows this while in front)
  useEffect(() => {
    if (!NATIVE) return;
    let cancelled = false;
    const check = async () => {
      if (!autoSendEnabled()) return;
      try {
        const content = await readClipboard();
        if (!content || cancelled) return;
        const fp = fingerprint(content);
        if (localStorage.getItem(LAST_SENT_KEY) === fp) return;
        // skip things that arrived through OmniClip and were copied from the feed
        if (content.kind === 'text' && clipsRef.current.some((c) => c.text === content.text)) {
          localStorage.setItem(LAST_SENT_KEY, fp);
          return;
        }
        localStorage.setItem(LAST_SENT_KEY, fp);
        if (content.kind === 'text') await sendText(session.token, content.text);
        else await sendFile(session.token, content.blob, `image.${content.blob.type.split('/')[1] ?? 'png'}`);
        toast('Sent your clipboard to all devices');
      } catch {
        // clipboard empty or not readable yet
      }
    };
    const timer = window.setTimeout(check, 800);
    let off = () => {};
    void native().then((n) => {
      if (!cancelled) off = n.onResume(() => window.setTimeout(check, 500));
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      off();
    };
  }, [session.token]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const pasteAndSend = () =>
    run(async () => {
      const content = await readClipboard();
      if (!content) throw new Error('Clipboard is empty');
      if (content.kind === 'text') await sendText(session.token, content.text, to);
      else await sendFile(session.token, content.blob, `image.${content.blob.type.split('/')[1] ?? 'png'}`, undefined, to);
    }, sentTo);

  const sendDraft = (e: Event) => {
    e.preventDefault();
    if (!draft.trim()) return;
    void run(async () => {
      await sendText(session.token, draft, to);
      setDraft('');
    }, sentTo);
  };

  const onFiles = (files: FileList | null) => {
    if (!files?.length) return;
    void run(async () => {
      for (const f of Array.from(files)) await sendFile(session.token, f, f.name, f.type.startsWith('image/') ? undefined : 'file', to);
    }, files.length > 1 ? sentTo.replace('Sent', `Sent ${files.length} files`) : sentTo);
    if (fileInput.current) fileInput.current.value = '';
  };

  // Android app: items shared to OmniClip from other apps
  useEffect(() => {
    if (!NATIVE) return;
    let cancelled = false;
    const drain = () =>
      void native().then(async (n) => {
        const items = await n.takeShared();
        if (!items.length || cancelled) return;
        await run(async () => {
          for (const item of items) {
            if (item.kind === 'text') await sendText(session.token, item.text);
            else {
              const blob = await (await fetch(`data:${item.mime};base64,${item.data}`)).blob();
              await sendFile(session.token, blob, item.name, item.mime.startsWith('image/') ? undefined : 'file');
            }
          }
        }, 'Shared to all devices');
      });
    drain();
    let offShared = () => {};
    let offResume = () => {};
    void native().then((n) => {
      if (cancelled) return;
      offShared = n.onShared(drain);
      offResume = n.onResume(drain);
    });
    return () => {
      cancelled = true;
      offShared();
      offResume();
    };
  }, [session.token]);

  // Android share target: the service worker parked shared items in a cache
  useEffect(() => {
    if (!new URLSearchParams(location.search).has('share') || !('caches' in window)) return;
    history.replaceState(null, '', '/');
    void run(async () => {
      const inbox = await caches.open('omniclip-share-inbox');
      for (const req of await inbox.keys()) {
        const res = (await inbox.match(req))!;
        if (res.headers.get('x-kind') === 'text') await sendText(session.token, await res.text());
        else {
          const blob = await res.blob();
          const name = decodeURIComponent(res.headers.get('x-name') ?? 'shared');
          await sendFile(session.token, blob, name, blob.type.startsWith('image/') ? undefined : 'file');
        }
        await inbox.delete(req);
      }
    }, 'Shared to all devices');
  }, []);

  return (
    <main class="app">
      <header class="bar">
        <img src="/icons/icon-192.png" alt="" width={28} height={28} />
        <strong>OmniClip</strong>
        <StatusPill status={status} searching={searching} />
        {NATIVE ? (
          <button class="ghost" aria-label="Settings" onClick={() => setSettingsOpen(!settingsOpen)}>
            ⚙︎
          </button>
        ) : (
          <a class="ghost" href="/setup" aria-label="Setup">
            ⚙︎
          </a>
        )}
      </header>

      {NATIVE && settingsOpen && <NativeSettings session={session} onUnpair={onRevoked} />}

      {!secure && (
        <p class="banner">
          Basic mode. Copy works, but to send you have to paste into the box below. <a href="/setup">Turn on secure mode</a>
        </p>
      )}

      {others.length > 0 && (
        <label class="target">
          <span>Send to</span>
          <select value={target} onChange={(e) => setTarget(e.currentTarget.value)}>
            <option value="">All devices</option>
            {others.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.online ? '' : ' (offline)'}
              </option>
            ))}
          </select>
        </label>
      )}

      <section class="actions">
        {canReadClipboard && (
          <button class="primary big" onClick={pasteAndSend} disabled={busy}>
            📋 Paste &amp; Send
          </button>
        )}
        <button class="big" onClick={() => fileInput.current?.click()} disabled={busy}>
          📎 Send photo or file
        </button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => onFiles(e.currentTarget.files)} />
      </section>

      <form class="composer" onSubmit={sendDraft}>
        <textarea
          placeholder="Type or paste here…"
          value={draft}
          rows={2}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && sendDraft(e)}
        />
        <button class="primary" disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>

      <input class="search" type="search" placeholder="Search history…" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />

      {results ? (
        <section>
          <h2>Results</h2>
          {results.length === 0 && <p class="muted">Nothing matches "{query.trim()}".</p>}
          <ul class="feed">
            {results.map((c) => (
              <ClipRow key={c.id} clip={c} session={session} toast={toast} onPin={togglePin} />
            ))}
          </ul>
        </section>
      ) : (
        <>
          {pinned.length > 0 && (
            <section>
              <h2>📌 Pinned</h2>
              <ul class="feed">
                {pinned.map((c) => (
                  <ClipRow key={c.id} clip={c} session={session} toast={toast} onPin={togglePin} />
                ))}
              </ul>
            </section>
          )}
          <section>
            <h2>Recent</h2>
            {clips.length === 0 && <p class="muted">Nothing yet. Copy something on any device.</p>}
            <ul class="feed">
              {clips
                .filter((c) => !c.pinned)
                .map((c) => (
                  <ClipRow key={c.id} clip={c} session={session} toast={toast} onPin={togglePin} />
                ))}
            </ul>
          </section>
        </>
      )}

      <DeviceList devices={devices} me={session.deviceId} />
    </main>
  );
}

function StatusPill({ status, searching }: { status: Status; searching?: boolean }) {
  const label = searching && status !== 'online' ? 'Looking for hub…' : { online: 'Connected', connecting: 'Connecting…', offline: 'Offline' }[status];
  return <span class={`pill ${status}`}>{label}</span>;
}

function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

function ClipRow({ clip, session, toast, onPin }: { clip: Clip; session: Session; toast: (m: string) => void; onPin: (c: Clip) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const url = clip.kind === 'text' ? '' : blobUrl(session.token, clip);
  const mine = clip.sourceDeviceId === session.deviceId;
  const to = clip.targetName ? ` → ${clip.targetDeviceId === session.deviceId ? 'you' : clip.targetName}` : '';

  const copy = async () => {
    const ok = clip.kind === 'text' ? await copyText(clip.text ?? '') : await copyImage(url);
    toast(ok ? 'Copied' : 'Copy failed');
  };

  const share = async () => {
    if (NATIVE) {
      await (await native()).shareFile(url, clip.name ?? 'file').catch(() => {});
      return;
    }
    try {
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], clip.name ?? 'file', { type: clip.mime });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] });
      else window.open(url, '_blank');
    } catch {
      // user cancelled the share sheet
    }
  };

  const isLink = clip.kind === 'text' && /^https?:\/\/\S+$/.test(clip.text?.trim() ?? '');

  return (
    <li class="clip card">
      <div class="meta">
        <span>
          {mine ? 'This device' : clip.sourceName}
          {to}
        </span>
        <span>{timeAgo(clip.createdAt)}</span>
      </div>
      {clip.kind === 'text' && clip.sensitive && !revealed && (
        <pre class="text secret" onClick={() => setRevealed(true)}>
          🔒 •••••••• <span class="muted">Password or code · tap to show · deleted after a minute</span>
        </pre>
      )}
      {clip.kind === 'text' && (!clip.sensitive || revealed) && (
        <pre class={expanded ? 'text expanded' : 'text'} onClick={() => setExpanded(!expanded)}>
          {clip.text}
        </pre>
      )}
      {clip.kind === 'image' && <img class="thumb" src={url} alt={clip.name ?? 'image'} loading="lazy" />}
      {clip.kind === 'file' && (
        <div class="file">
          📄 <span>{clip.name}</span> <span class="muted">{formatSize(clip.size)}</span>
        </div>
      )}
      <div class="row">
        {(clip.kind === 'text' || (clip.kind === 'image' && canCopyImages)) && <button onClick={copy}>Copy</button>}
        {isLink &&
          (NATIVE ? (
            <button onClick={() => void native().then((n) => n.openUrl(clip.text!.trim()))}>Open</button>
          ) : (
            <a class="button" href={clip.text!.trim()} target="_blank" rel="noreferrer">
              Open
            </a>
          ))}
        {clip.kind !== 'text' && !NATIVE && (
          <a class="button" href={url} download={clip.name}>
            Download
          </a>
        )}
        {clip.kind !== 'text' && (NATIVE || 'share' in navigator) && <button onClick={share}>{NATIVE ? 'Save / Share' : 'Share'}</button>}
        {!clip.sensitive && (
          <button class={clip.pinned ? 'pin on' : 'pin'} onClick={() => onPin(clip)} aria-label={clip.pinned ? 'Unpin' : 'Pin'} title={clip.pinned ? 'Unpin' : 'Pin'}>
            {clip.pinned ? '📌 Unpin' : '📌 Pin'}
          </button>
        )}
      </div>
    </li>
  );
}

function DeviceList({ devices, me }: { devices: Device[]; me: string }) {
  const icon: Record<string, string> = { mac: '💻', windows: '🖥️', linux: '🐧', ios: '📱', ipados: '📲', android: '🤖', web: '🌐', shortcut: '⚡' };
  return (
    <details class="devices">
      <summary>
        Devices · {devices.filter((d) => d.online).length} online of {devices.length}
      </summary>
      <ul>
        {devices.map((d) => (
          <li key={d.id}>
            <span>
              {icon[d.platform] ?? '•'} {d.name}
              {d.id === me && ' (this device)'}
            </span>
            <span class={d.online ? 'dot on' : 'dot'} />
          </li>
        ))}
      </ul>
      <p class="muted small">You can remove a device from the OmniClip menu on the hub computer.</p>
    </details>
  );
}

function NativeSettings({ session, onUnpair }: { session: Session; onUnpair: () => void }) {
  const [auto, setAuto] = useState(autoSendEnabled);
  const ios = detectPlatform() !== 'android';
  const toggle = (on: boolean) => {
    setAuto(on);
    try {
      localStorage.setItem(AUTO_SEND_KEY, on ? '1' : '0');
    } catch {
      // ignore
    }
  };
  return (
    <section class="card stack settings">
      <label class="switch">
        <input type="checkbox" checked={auto} onChange={(e) => toggle(e.currentTarget.checked)} />
        <span>Send my clipboard when I open OmniClip</span>
      </label>
      {ios && (
        <p class="muted small">
          To stop iOS asking every time, go to <b>Settings → Apps → OmniClip → Paste from Other Apps</b> and choose <b>Allow</b>.
        </p>
      )}
      <p class="muted small">
        Connected to {session.hub ? new URL(session.hub).hostname : 'hub'} as <b>{session.name}</b>.
      </p>
      <button
        onClick={() => {
          saveSession(null);
          onUnpair();
        }}
      >
        Unpair this device
      </button>
    </section>
  );
}
