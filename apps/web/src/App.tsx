import { useEffect, useRef, useState } from 'preact/hooks';
import type { Clip, Device, PairResponse } from '@omniclip/protocol';
import {
  ApiError,
  defaultDeviceName,
  detectPlatform,
  fetchCaPem,
  hostOf,
  hubUrls,
  deleteSnippet,
  loadBlob,
  loadSession,
  NATIVE,
  pair,
  parseHubInput,
  pinOf,
  probeHub,
  saveSession,
  saveSnippet,
  searchClips,
  sendFile,
  sendText,
  setPinned,
  setHubBase,
  type PlainSnippet,
  type Session,
} from './api';
import { canCopyImages, canReadClipboard, copyImage, copyText, readClipboard, secure } from './clipboard';
import { findHub } from './discovery';
import { Icon } from './Icon';
import { platformIcon, type IconName } from '@omniclip/ui';
import { expandSnippet, matchSnippets, normalizeKeyword } from '@omniclip/protocol';
import { Setup } from './Setup';
import { useHub, type Status } from './useHub';
import type { SharedItem } from './native';

// inline MODE check so the browser build drops the native chunk entirely
const native = () => (import.meta.env.MODE === 'native' ? import('./native') : Promise.reject(new Error('native only')));

/** The end-to-end keyring, tunnel key and relay a v0.8 hub hands out when pairing. */
function e2eFrom(res: PairResponse): Pick<Session, 'keys' | 'tunnelKey' | 'relay'> {
  return { ...(res.keys ? { keys: res.keys } : {}), ...(res.tunnelKey ? { tunnelKey: res.tunnelKey } : {}), ...(res.relay ? { relay: res.relay } : {}) };
}

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
    if (NATIVE) void native().then((n) => n.saveExtensionSession(null)).catch(() => {});
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
        <HeroLogo pulse />
        <h1>Connecting…</h1>
        <p class="lead">Looking for your OmniClip hub on this Wi-Fi.</p>
        {startError && <p class="muted small">Still trying: {startError}</p>}
        <button class="linkish" onClick={signOut}>
          Pair with a different hub
        </button>
      </main>
    );
  else page = <Main session={session} onRevoked={signOut} onSession={updateSession} toast={showToast} />;

  return (
    <>
      {page}
      {toast && (
        <div class="toast" role="status">
          <Icon name="check" />
          {toast}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- pairing

function HeroLogo({ pulse }: { pulse?: boolean }) {
  return (
    <div class={pulse ? 'hero-logo pulse' : 'hero-logo'}>
      <img src="/icons/icon-192.png" alt="" width={84} height={84} />
    </div>
  );
}

function ErrorNote({ text }: { text: string }) {
  return (
    <p class="error" role="alert">
      <Icon name="x" size="sm" />
      <span>{text}</span>
    </p>
  );
}

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
      const s: Session = { token: res.token, deviceId: res.deviceId, networkId: res.networkId, name, ...e2eFrom(res) };
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
      <HeroLogo />
      <h1>Join OmniClip</h1>
      <p class="lead">Enter the 6-digit code shown in the OmniClip window on your Mac or PC.</p>
      <form class="card form-card" onSubmit={submit}>
        <label>
          Pairing code
          <input
            class="field code-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            maxLength={16}
            value={code}
            onInput={(e) => setCode(e.currentTarget.value)}
            required
          />
        </label>
        <label>
          This device's name
          <input class="field" value={name} maxLength={64} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        {error && <ErrorNote text={error} />}
        <button class="btn primary lg" disabled={busy || code.length < 4}>
          {busy ? 'Pairing…' : 'Pair this device'}
        </button>
      </form>
      <a class="linkish" href={`/setup${location.hash}`}>
        Need help setting up?
      </a>
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
      const s: Session = { token: res.token, deviceId: res.deviceId, networkId: res.networkId, name: deviceName, hub: target.hub, caPem, ...e2eFrom(res) };
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
      <HeroLogo />
      <h1>Join OmniClip</h1>
      <p class="lead">One clipboard for your phone, tablet and computers on this Wi-Fi.</p>
      <button class="btn primary cta" onClick={scan} disabled={busy}>
        {busy ? <span class="spinner" /> : <Icon name="qr" />}
        {busy ? 'Pairing…' : 'Scan QR code'}
      </button>
      {error && <ErrorNote text={error} />}
      <ol class="steps">
        <li>Open OmniClip on your Mac or PC (or choose Pair a phone or tablet… in its menu).</li>
        <li>Tap Scan QR code and point the camera at the code in that window.</li>
      </ol>
      <details class="manual">
        <summary>
          Enter the code instead <Icon name="chevron" size="sm" />
        </summary>
        <form
          class="card form-card"
          onSubmit={(e) => {
            e.preventDefault();
            void connect(hub, code);
          }}
        >
          <label>
            Hub address
            <input
              class="field"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="192.168.1.5"
              value={hub}
              onInput={(e) => setHub(e.currentTarget.value)}
              required
            />
          </label>
          <label>
            Pairing code
            <input
              class="field code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              maxLength={16}
              value={code}
              onInput={(e) => setCode(e.currentTarget.value)}
              required
            />
          </label>
          <label>
            This device's name
            <input class="field" value={name} maxLength={64} onInput={(e) => setName(e.currentTarget.value)} />
          </label>
          <button class="btn primary lg" disabled={busy || code.length < 4 || !hub.trim()}>
            Pair this device
          </button>
        </form>
      </details>
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
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const { status, via, clips, pinned, devices, snippets } = useHub(session.token, onRevoked, session.hub, (u) => {
    const s = sessionRef.current;
    const next: Session = { ...s, ...(u.keys ? { keys: u.keys } : {}), ...(u.tunnelKey ? { tunnelKey: u.tunnelKey } : {}) };
    if (u.relay === null) delete next.relay;
    else if (u.relay) next.relay = u.relay;
    if (JSON.stringify(next) !== JSON.stringify(s)) onSession(next);
  }, { networkId: session.networkId, deviceId: session.deviceId, tunnelKey: session.tunnelKey, relay: session.relay, keys: session.keys });
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'clips' | 'snippets'>('clips');
  const [results, setResults] = useState<Clip[] | null>(null);

  // search runs on the hub so it covers the whole history, not just what this device has loaded
  useEffect(() => {
    const q = query.trim();
    if (!q || view !== 'clips') return setResults(null);
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
  }, [query, session.token, view]);

  const togglePin = (clip: Clip) =>
    setPinned(session.token, clip.id, !clip.pinned)
      .then((c) => {
        setResults((r) => r && r.map((x) => (x.id === c.id ? c : x)));
        toast(c.pinned ? 'Pinned' : 'Unpinned');
      })
      .catch((err) => toast(err instanceof Error ? err.message : 'Could not pin'));
  const [searching, setSearching] = useState(false);
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
  const composer = useRef<HTMLTextAreaElement>(null);
  /** The snippet being edited in the sheet ('new' for a new one). */
  const [editing, setEditing] = useState<PlainSnippet | 'new' | null>(null);
  const setDraftText = (text: string) => {
    setDraft(text);
    const t = composer.current;
    if (!t) return;
    requestAnimationFrame(() => {
      t.style.height = 'auto';
      t.style.height = `${Math.min(t.scrollHeight + 2, 180)}px`;
      t.focus();
    });
  };
  /** "Edit" on a clip: put it in the note box to change before sending. */
  const editClip = (text: string) => {
    setDraftText(text);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const pasteIntoDraft = async () => {
    const content = await readClipboard().catch(() => null);
    if (content?.kind === 'text') setDraftText(content.text);
    else toast(content ? 'That is an image; use Paste & Send' : 'Your clipboard is empty');
  };
  const copySnippet = async (sn: PlainSnippet) => {
    const clip = sn.text.includes('{clipboard}') ? await readClipboard().catch(() => null) : null;
    const ok = await copyText(expandSnippet(sn.text, clip?.kind === 'text' ? clip.text : ''));
    toast(ok ? `Copied ${sn.name || 'snippet'}` : 'Copy failed');
  };
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
  /** Android: items shared to OmniClip, waiting for the user to pick where they go. */
  const [incoming, setIncoming] = useState<SharedItem[]>([]);
  /** The Quick Settings tile or widget is sending the clipboard; the open-app auto-send stays out of the way. */
  const tileBusy = useRef(false);

  // Native app: send whatever is on the clipboard when the app is opened (Android allows this while in front)
  useEffect(() => {
    if (!NATIVE) return;
    let cancelled = false;
    const check = async () => {
      if (!autoSendEnabled() || tileBusy.current) return;
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
        if (content.kind === 'text') await sendText(session.token, content.text, undefined, content.html);
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
      if (content.kind === 'text') await sendText(session.token, content.text, to, content.html);
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

  const sendShared = (items: SharedItem[], device?: Device) => {
    setIncoming([]);
    void run(async () => {
      for (const item of items) {
        if (item.kind === 'text') await sendText(session.token, item.text, device?.id);
        else {
          const blob = await (await fetch(`data:${item.mime};base64,${item.data}`)).blob();
          await sendFile(session.token, blob, item.name, item.mime.startsWith('image/') ? undefined : 'file', device?.id);
        }
      }
    }, device ? `Shared to ${device.name}` : 'Shared to all devices');
  };

  // Android Quick Settings tile / home-screen widget: send the clipboard, then go back to the previous app
  const sendClipboardFromTile = async (n: Awaited<ReturnType<typeof native>>) => {
    tileBusy.current = true;
    try {
      // Android only lets the app read the clipboard once its window has focus
      let content: Awaited<ReturnType<typeof readClipboard>> = null;
      for (let i = 0; i < 6 && !content; i++) {
        await new Promise((r) => setTimeout(r, i ? 300 : 400));
        content = await readClipboard().catch(() => null);
      }
      if (!content) return toast('Your clipboard is empty');
      try {
        localStorage.setItem(LAST_SENT_KEY, fingerprint(content));
      } catch {
        // ignore
      }
      if (content.kind === 'text') await sendText(session.token, content.text, undefined, content.html);
      else await sendFile(session.token, content.blob, `image.${content.blob.type.split('/')[1] ?? 'png'}`);
      toast('Sent your clipboard to all devices');
      window.setTimeout(() => void n.moveToBack().catch(() => {}), 1200);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not send your clipboard');
    } finally {
      tileBusy.current = false;
    }
  };

  // iPhone app: keep the share extension able to send by itself (hub, token, CA, keys, devices)
  useEffect(() => {
    if (!NATIVE || !session.hub || !session.caPem) return;
    void native().then((n) =>
      n.saveExtensionSession({
        hub: session.hub!,
        token: session.token,
        caPem: session.caPem!,
        deviceId: session.deviceId,
        keys: session.keys,
        devices: devices.map((d) => ({ id: d.id, name: d.name, platform: d.platform, online: d.online })),
      }),
    ).catch(() => {});
  }, [session.hub, session.token, session.caPem, session.keys, devices]);

  // iPhone widget and Control Center button: omniclip://send-clipboard
  useEffect(() => {
    if (!NATIVE) return;
    let off = () => {};
    let cancelled = false;
    void native().then(async (n) => {
      const dispose = await n.onSendClipboardLink(() => void sendClipboardFromTile(n));
      if (cancelled) dispose();
      else off = dispose;
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [session.token]);

  // Android app: items shared to OmniClip from other apps, and tile / widget taps
  useEffect(() => {
    if (!NATIVE) return;
    let cancelled = false;
    const drain = () =>
      void native().then(async (n) => {
        const { items, sendClipboard } = await n.takeShared();
        if (cancelled) return;
        if (items.length) setIncoming((prev) => [...prev, ...items]);
        if (sendClipboard) await sendClipboardFromTile(n);
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

  const platformOf = (id: string) => devices.find((d) => d.id === id)?.platform;
  const row = (c: Clip) => (
    <ClipRow key={c.id} clip={c} session={session} platform={platformOf(c.sourceDeviceId)} toast={toast} onPin={togglePin} onEdit={editClip} />
  );
  const recent = clips.filter((c) => !c.pinned);
  const byName = [...snippets].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  const shownSnippets = query.trim() ? matchSnippets(byName, query) : byName;

  return (
    <main class="app">
      {editing && (
        <SnippetSheet
          snippet={editing === 'new' ? null : editing}
          taken={snippets}
          onClose={() => setEditing(null)}
          onSave={async (payload) => {
            await saveSnippet(session.token, editing === 'new' ? crypto.randomUUID() : editing.id, payload);
            setEditing(null);
            toast(editing === 'new' ? 'Snippet added' : 'Snippet saved');
          }}
          onDelete={async () => {
            if (editing === 'new') return;
            await deleteSnippet(session.token, editing.id);
            setEditing(null);
            toast('Snippet deleted');
          }}
        />
      )}
      {incoming.length > 0 && <ShareSheet items={incoming} devices={others} onSend={(d) => sendShared(incoming, d)} onCancel={() => setIncoming([])} />}
      <header class="topbar">
        <div class="brand">
          <img class="logo" src="/icons/icon-192.png" alt="" width={30} height={30} />
          OmniClip
        </div>
        <StatusPill status={status} searching={searching} via={via} />
        <span class="spacer" />
        {NATIVE ? (
          <button class={settingsOpen ? 'btn ghost icon on' : 'btn ghost icon'} aria-label="Settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}>
            <Icon name={settingsOpen ? 'x' : 'sliders'} />
          </button>
        ) : (
          <a class="btn ghost icon" href="/setup" aria-label="Setup">
            <Icon name="sliders" />
          </a>
        )}
      </header>

      {NATIVE && settingsOpen && <NativeSettings session={session} onUnpair={onRevoked} />}

      {!secure && (
        <p class="banner">
          <Icon name="lock" />
          <span>
            Basic mode: copying works, but to send you paste into the box below. <a href="/setup">Turn on secure mode</a>
          </span>
        </p>
      )}

      <section class="card panel">
        {others.length > 0 && (
          <div class="targets" role="radiogroup" aria-label="Send to">
            <button class={target ? 'chip' : 'chip active'} role="radio" aria-checked={!target} onClick={() => setTarget('')}>
              <Icon name="devices" size="sm" />
              All devices
            </button>
            {others.map((d) => (
              <button key={d.id} class={target === d.id ? 'chip active' : 'chip'} role="radio" aria-checked={target === d.id} onClick={() => setTarget(d.id)}>
                <Icon name={platformIcon(d.platform)} size="sm" />
                {d.name}
                <span class={d.online ? 'dot on' : 'dot'} title={d.online ? 'Online' : 'Offline'} />
              </button>
            ))}
          </div>
        )}

        <div class="send-row">
          {canReadClipboard && (
            <button class="btn primary send-main" onClick={pasteAndSend} disabled={busy}>
              <span class="ico">{busy ? <span class="spinner" /> : <Icon name="clipboard" size="lg" />}</span>
              <span class="t">
                <b>Paste &amp; Send</b>
                <small>{targetDevice ? `to ${targetDevice.name}` : 'to all your devices'}</small>
              </span>
            </button>
          )}
          <button class={canReadClipboard ? 'btn send-file' : 'btn send-file wide'} onClick={() => fileInput.current?.click()} disabled={busy}>
            <Icon name="paperclip" size="lg" />
            {canReadClipboard ? 'File' : 'Send a photo or file'}
          </button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => onFiles(e.currentTarget.files)} />
        </div>

        <form class="compose" onSubmit={sendDraft}>
          <textarea
            ref={composer}
            class="field"
            placeholder="Type or paste a note…"
            value={draft}
            rows={1}
            onInput={(e) => {
              const t = e.currentTarget;
              setDraft(t.value);
              t.style.height = 'auto';
              t.style.height = `${Math.min(t.scrollHeight + 2, 180)}px`;
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && sendDraft(e)}
          />
          {!draft && canReadClipboard ? (
            <button type="button" class="btn tint icon send" aria-label="Paste here to edit" title="Paste here to edit" onClick={pasteIntoDraft}>
              <Icon name="clipboard" size="sm" />
            </button>
          ) : (
            <button class="btn primary icon send" aria-label="Send" disabled={busy || !draft.trim()}>
              <Icon name="send" size="sm" />
            </button>
          )}
        </form>
      </section>

      <div class="segmented" role="tablist">
        <button role="tab" aria-selected={view === 'clips'} class={view === 'clips' ? 'active' : ''} onClick={() => setView('clips')}>
          <Icon name="clock" size="sm" />
          Clips
        </button>
        <button role="tab" aria-selected={view === 'snippets'} class={view === 'snippets' ? 'active' : ''} onClick={() => setView('snippets')}>
          <Icon name="zap" size="sm" />
          Snippets
          {snippets.length > 0 && <span class="count">{snippets.length}</span>}
        </button>
      </div>

      <div class="search-field">
        <Icon name="search" />
        <input
          class="field"
          type="search"
          placeholder={view === 'clips' ? "Search everything you've copied" : 'Search snippets, or ;keyword'}
          value={query}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </div>

      {view === 'snippets' ? (
        <section>
          <div class="feed-head">
            <h2>{query.trim() ? 'Matches' : 'Snippets'}</h2>
            <span class="count">{shownSnippets.length || ''}</span>
            <span class="spacer" />
            <button class="btn tint sm" onClick={() => setEditing('new')}>
              <Icon name="plus" size="sm" />
              New snippet
            </button>
          </div>
          {shownSnippets.length === 0 &&
            (query.trim() ? (
              <Empty icon="search" title="No matches" text={`No snippet matches "${query.trim()}".`} />
            ) : (
              <Empty icon="zap" title="No snippets yet" text="Save addresses, replies and links you paste again and again. They show up on all your devices." />
            ))}
          <ul class="feed">
            {shownSnippets.map((sn) => (
              <li key={sn.id} class="clip card snippet rise">
                <div class="clip-head">
                  <span class="avatar sm">
                    <Icon name="zap" />
                  </span>
                  <span class="from ellipsis">
                    <b>{sn.name || 'Snippet'}</b>
                  </span>
                  {sn.keyword && <span class="badge accent kw">;{normalizeKeyword(sn.keyword)}</span>}
                </div>
                <pre class="text snippet-text">{sn.text}</pre>
                <div class="clip-actions">
                  <button class="btn tint sm" onClick={() => void copySnippet(sn)}>
                    <Icon name="copy" size="sm" />
                    Copy
                  </button>
                  <button class="btn sm" onClick={() => editClip(expandSnippet(sn.text, ''))}>
                    <Icon name="send" size="sm" />
                    Send
                  </button>
                  <button class="btn ghost icon sm pin" aria-label={`Edit ${sn.name || 'snippet'}`} onClick={() => setEditing(sn)}>
                    <Icon name="pencil" size="sm" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : results ? (
        <section>
          <FeedHead title="Results" count={results.length} />
          {results.length === 0 && <Empty icon="search" title="No matches" text={`Nothing you've copied matches "${query.trim()}".`} />}
          <ul class="feed">{results.map(row)}</ul>
        </section>
      ) : (
        <>
          {pinned.length > 0 && (
            <section>
              <FeedHead title="Pinned" count={pinned.length} />
              <ul class="feed">{pinned.map(row)}</ul>
            </section>
          )}
          <section>
            <FeedHead title="Recent" count={recent.length} />
            {recent.length === 0 && <Empty icon="inbox" title="Nothing here yet" text="Copy something on any of your devices and it shows up here." />}
            <ul class="feed">{recent.map(row)}</ul>
          </section>
        </>
      )}

      <DeviceList devices={devices} me={session.deviceId} />
    </main>
  );
}

function FeedHead({ title, count }: { title: string; count: number }) {
  return (
    <div class="feed-head">
      <h2>{title}</h2>
      {count > 0 && <span class="count">{count}</span>}
    </div>
  );
}

function Empty({ icon, title, text }: { icon: IconName; title: string; text: string }) {
  return (
    <div class="card empty">
      <span class="avatar lg">
        <Icon name={icon} />
      </span>
      <span class="title">{title}</span>
      <span class="small">{text}</span>
    </div>
  );
}

function StatusPill({ status, searching, via }: { status: Status; searching?: boolean; via?: 'lan' | 'relay' }) {
  const label =
    searching && status !== 'online' ? 'Looking for hub…' : status === 'online' && via === 'relay' ? 'Connected via relay' : { online: 'Connected', connecting: 'Connecting…', offline: 'Offline' }[status];
  const dot = status === 'online' ? 'dot on' : status === 'offline' && !searching ? 'dot bad' : 'dot warn pulse';
  return (
    <span class="status" role="status">
      <span class={dot} />
      {label}
    </span>
  );
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

function ClipRow({
  clip,
  session,
  platform,
  toast,
  onPin,
  onEdit,
}: {
  clip: Clip;
  session: Session;
  platform?: string;
  toast: (m: string) => void;
  onPin: (c: Clip) => void;
  /** Puts the clip's text in the note box to change before sending. */
  onEdit: (text: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  // images and files are downloaded and decrypted on this device, then shown from a local URL
  const [url, setUrl] = useState('');
  const loading = useRef<Promise<string>>();
  const getUrl = () =>
    (loading.current ??= loadBlob(session.token, clip).then((blob) => {
      const u = URL.createObjectURL(blob);
      setUrl(u);
      return u;
    }));
  useEffect(() => {
    if (clip.kind === 'image') getUrl().catch(() => (loading.current = undefined));
  }, [clip.id]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  const download = async () => {
    try {
      const a = document.createElement('a');
      a.href = await getUrl();
      a.download = clip.name ?? 'file';
      a.click();
    } catch (err) {
      loading.current = undefined;
      toast(err instanceof Error ? err.message : 'Download failed');
    }
  };
  const mine = clip.sourceDeviceId === session.deviceId;
  const to = clip.targetName ? (clip.targetDeviceId === session.deviceId ? 'you' : clip.targetName) : '';

  const copy = async () => {
    const ok = clip.kind === 'text' ? await copyText(clip.text ?? '', clip.html) : await copyImage(await getUrl());
    if (!ok) return toast('Copy failed');
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const share = async () => {
    if (NATIVE) {
      await (await native()).shareFile(await getUrl(), clip.name ?? 'file').catch(() => {});
      return;
    }
    try {
      const u = await getUrl();
      const blob = await (await fetch(u)).blob();
      const file = new File([blob], clip.name ?? 'file', { type: clip.mime });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] });
      else window.open(u, '_blank');
    } catch {
      // user cancelled the share sheet
    }
  };

  const text = clip.text ?? '';
  const isLink = clip.kind === 'text' && /^https?:\/\/\S+$/.test(text.trim());
  const long = text.length > 320 || text.split('\n').length > 5;

  return (
    <li class="clip card rise">
      <div class="clip-head">
        <span class={mine ? 'avatar sm grey' : 'avatar sm'}>
          <Icon name={platformIcon(platform)} />
        </span>
        <span class="from ellipsis">
          <b>{mine ? 'This device' : clip.sourceName}</b>
          {to && <span> → {to}</span>}
        </span>
        {clip.sensitive && (
          <span class="badge warn">
            <Icon name="lock" /> Secret
          </span>
        )}
        {isLink && (
          <span class="badge accent">
            <Icon name="link" /> Link
          </span>
        )}
        <time>{timeAgo(clip.createdAt)}</time>
      </div>
      {clip.kind === 'text' && clip.sensitive && !revealed && (
        <button class="secret" onClick={() => setRevealed(true)}>
          <span class="dots">••••••••</span>
          <span class="small muted grow">Password or code · tap to show · deleted after a minute</span>
          <Icon name="eye" size="sm" />
        </button>
      )}
      {clip.kind === 'text' && (!clip.sensitive || revealed) && (
        <pre class={['text', isLink && 'link', long && 'long', expanded && 'expanded'].filter(Boolean).join(' ')} onClick={() => setExpanded(!expanded)}>
          {text}
        </pre>
      )}
      {clip.kind === 'image' && (url ? <img class="thumb" src={url} alt={clip.name ?? 'image'} /> : <div class="thumb placeholder" />)}
      {clip.kind === 'file' && (
        <div class="file-tile">
          <span class="avatar lg">
            <Icon name={clip.folder ? 'folder' : 'file'} />
          </span>
          <div class="grow">
            <div class="name">{clip.name}</div>
            <div class="muted small">
              {clip.folder ? 'Folder · ' : ''}
              {formatSize(clip.size)}
            </div>
          </div>
        </div>
      )}
      <div class="clip-actions">
        {(clip.kind === 'text' || (clip.kind === 'image' && canCopyImages)) && (
          <button class="btn tint sm" onClick={copy}>
            <Icon name={copied ? 'check' : 'copy'} size="sm" />
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
        {isLink &&
          (NATIVE ? (
            <button class="btn sm" onClick={() => void native().then((n) => n.openUrl(text.trim()))}>
              <Icon name="external" size="sm" />
              Open
            </button>
          ) : (
            <a class="btn sm" href={text.trim()} target="_blank" rel="noreferrer">
              <Icon name="external" size="sm" />
              Open
            </a>
          ))}
        {clip.kind !== 'text' && !NATIVE && (
          <button class={clip.kind === 'file' ? 'btn tint sm' : 'btn sm'} onClick={download}>
            <Icon name="download" size="sm" />
            Download
          </button>
        )}
        {clip.kind !== 'text' && (NATIVE || 'share' in navigator) && (
          <button class={NATIVE && clip.kind === 'file' ? 'btn tint sm' : 'btn sm'} onClick={share}>
            <Icon name="share" size="sm" />
            {NATIVE ? 'Save or share' : 'Share'}
          </button>
        )}
        {clip.kind === 'text' && !clip.sensitive && (
          <button class="btn ghost icon sm edit" onClick={() => onEdit(text)} aria-label="Edit and send" title="Edit and send">
            <Icon name="pencil" size="sm" />
          </button>
        )}
        {!clip.sensitive && (
          <button
            class={clip.pinned ? 'btn ghost icon sm pin on' : 'btn ghost icon sm pin'}
            onClick={() => onPin(clip)}
            aria-label={clip.pinned ? 'Unpin' : 'Pin'}
            title={clip.pinned ? 'Unpin' : 'Pin'}
          >
            <Icon name="pin" size="sm" />
          </button>
        )}
      </div>
    </li>
  );
}

/** Adds or edits a snippet. */
function SnippetSheet({
  snippet,
  taken,
  onSave,
  onDelete,
  onClose,
}: {
  snippet: PlainSnippet | null;
  taken: PlainSnippet[];
  onSave: (s: { name: string; keyword?: string; text: string }) => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(snippet?.name ?? '');
  const [keyword, setKeyword] = useState(snippet?.keyword ?? '');
  const [text, setText] = useState(snippet?.text ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };
  const save = (e: Event) => {
    e.preventDefault();
    const k = normalizeKeyword(keyword);
    const clash = taken.find((s) => k && normalizeKeyword(s.keyword) === k && s.id !== snippet?.id);
    if (clash) return setError(`;${k} is already used by "${clash.name || 'another snippet'}".`);
    void run(() => onSave({ name: name.trim(), ...(k ? { keyword: k } : {}), text }));
  };
  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <form class="sheet card form-sheet" role="dialog" aria-label={snippet ? 'Edit snippet' : 'New snippet'} onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div class="grabber" />
        <h2>{snippet ? 'Edit snippet' : 'New snippet'}</h2>
        <p class="sub">Snippets are end-to-end encrypted and show up on all your devices.</p>
        <div class="pair">
          <label>
            Name
            <input class="field" value={name} maxLength={100} placeholder="Home address" onInput={(e) => setName(e.currentTarget.value)} />
          </label>
          <label>
            Keyword
            <input class="field kw" value={keyword} maxLength={40} placeholder="addr" autoCapitalize="off" autoCorrect="off" onInput={(e) => setKeyword(e.currentTarget.value)} />
          </label>
        </div>
        <label>
          Text
          <textarea class="field" rows={5} value={text} required onInput={(e) => setText(e.currentTarget.value)} />
        </label>
        <p class="hint">
          <code>{'{date}'}</code> <code>{'{time}'}</code> <code>{'{clipboard}'}</code> are filled in when you copy it.
        </p>
        {error && <ErrorNote text={error} />}
        <div class="sheet-actions">
          {snippet && (
            <button type="button" class="btn ghost danger" disabled={busy} onClick={() => void run(onDelete)}>
              <Icon name="trash" size="sm" />
              Delete
            </button>
          )}
          <span class="spacer" />
          <button type="button" class="btn" onClick={onClose}>
            Cancel
          </button>
          <button class="btn primary" disabled={busy || !text.trim()}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

/** Android: asks where things shared to OmniClip should go. */
function ShareSheet({ items, devices, onSend, onCancel }: { items: SharedItem[]; devices: Device[]; onSend: (d?: Device) => void; onCancel: () => void }) {
  const files = items.filter((i) => i.kind === 'file').length;
  const what =
    items.length === 1 ? (files ? (items[0] as { name: string }).name : 'this text') : files === items.length ? `${files} files` : `${items.length} items`;
  const sorted = [...devices].sort((a, b) => Number(!!b.online) - Number(!!a.online));
  return (
    <div class="sheet-backdrop" onClick={onCancel}>
      <div class="sheet card" role="dialog" aria-label="Send to" onClick={(e) => e.stopPropagation()}>
        <div class="grabber" />
        <h2>Send {what}</h2>
        <p class="sub">Choose where it goes.</p>
        <button class="btn primary lg all" onClick={() => onSend()}>
          <Icon name="devices" />
          All devices
        </button>
        {sorted.length > 0 && (
          <div class="group">
            {sorted.map((d) => (
              <button key={d.id} class="item" onClick={() => onSend(d)}>
                <span class="avatar">
                  <Icon name={platformIcon(d.platform)} />
                </span>
                <span class="grow">
                  <div class="label">{d.name}</div>
                  <div class="hint">{d.online ? 'Online' : 'Offline · gets it when it reconnects'}</div>
                </span>
                <Icon name="chevron" size="sm" />
              </button>
            ))}
          </div>
        )}
        <button class="btn ghost lg cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function DeviceList({ devices, me }: { devices: Device[]; me: string }) {
  const sorted = [...devices].sort((a, b) => Number(b.id === me) - Number(a.id === me) || Number(!!b.online) - Number(!!a.online));
  return (
    <section>
      <div class="feed-head">
        <h2>Devices</h2>
        <span class="count">
          {devices.filter((d) => d.online).length} of {devices.length} online
        </span>
      </div>
      <div class="group devices">
        {sorted.map((d) => (
          <div key={d.id} class="item">
            <span class={d.online ? 'avatar' : 'avatar grey'}>
              <Icon name={platformIcon(d.platform)} />
            </span>
            <span class="grow ellipsis name">{d.name}</span>
            {d.id === me && <span class="badge accent">This device</span>}
            <span class="state">
              <span class={d.online ? 'dot on' : 'dot'} />
              {d.online ? 'Online' : 'Offline'}
            </span>
          </div>
        ))}
      </div>
      <p class="muted small note">To remove a device, open Settings → Devices on the hub computer.</p>
    </section>
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
    <section class="settings">
      <div class="section-title">Settings</div>
      <div class="group">
        <label class="item">
          <span class="grow">
            <div class="label">Send my clipboard when I open OmniClip</div>
            {ios && (
              <div class="hint">
                To stop iOS asking every time, go to <b>Settings → Apps → OmniClip → Paste from Other Apps</b> and choose <b>Allow</b>.
              </div>
            )}
          </span>
          <input class="switch" type="checkbox" checked={auto} onChange={(e) => toggle(e.currentTarget.checked)} />
        </label>
        <div class="item">
          <span class="avatar grey">
            <Icon name="wifi" />
          </span>
          <span class="grow">
            <div class="label">{session.name}</div>
            <div class="hint">Connected to {session.hub ? new URL(session.hub).hostname : 'your hub'}</div>
          </span>
          <button
            class="btn danger sm"
            onClick={() => {
              saveSession(null);
              onUnpair();
            }}
          >
            Unpair
          </button>
        </div>
      </div>
    </section>
  );
}
