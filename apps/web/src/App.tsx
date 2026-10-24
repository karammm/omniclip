import { useEffect, useRef, useState } from 'preact/hooks';
import type { Clip, Device } from '@omniclip/protocol';
import { ApiError, blobUrl, defaultDeviceName, detectPlatform, loadSession, pair, saveSession, sendFile, sendText, type Session } from './api';
import { canCopyImages, canReadClipboard, copyImage, copyText, readClipboard, secure } from './clipboard';
import { Setup } from './Setup';
import { useHub, type Status } from './useHub';

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

export function App() {
  const [session, setSession] = useState<Session | null>(loadSession);
  const [toast, showToast] = useToast();
  const path = location.pathname;

  const signOut = () => {
    saveSession(null);
    setSession(null);
  };

  let page;
  if (path.startsWith('/setup')) page = <Setup session={session} />;
  else if (!session) page = <PairScreen onPaired={setSession} />;
  else page = <Main session={session} onRevoked={signOut} toast={showToast} />;

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

// ---------------------------------------------------------------- main

function Main({ session, onRevoked, toast }: { session: Session; onRevoked: () => void; toast: (m: string) => void }) {
  const { status, clips, devices } = useHub(session.token, onRevoked);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

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
      if (content.kind === 'text') await sendText(session.token, content.text);
      else await sendFile(session.token, content.blob, `image.${content.blob.type.split('/')[1] ?? 'png'}`);
    }, 'Sent to all devices');

  const sendDraft = (e: Event) => {
    e.preventDefault();
    if (!draft.trim()) return;
    void run(async () => {
      await sendText(session.token, draft);
      setDraft('');
    }, 'Sent to all devices');
  };

  const onFiles = (files: FileList | null) => {
    if (!files?.length) return;
    void run(async () => {
      for (const f of Array.from(files)) await sendFile(session.token, f, f.name, f.type.startsWith('image/') ? undefined : 'file');
    }, files.length > 1 ? `Sent ${files.length} files` : 'Sent');
    if (fileInput.current) fileInput.current.value = '';
  };

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
        <StatusPill status={status} />
        <a class="ghost" href="/setup" aria-label="Setup">
          ⚙︎
        </a>
      </header>

      {!secure && (
        <p class="banner">
          Basic mode. Copy works, but to send you have to paste into the box below. <a href="/setup">Turn on secure mode</a>
        </p>
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

      <section>
        <h2>Recent</h2>
        {clips.length === 0 && <p class="muted">Nothing yet. Copy something on any device.</p>}
        <ul class="feed">
          {clips.map((c) => (
            <ClipRow key={c.id} clip={c} session={session} toast={toast} />
          ))}
        </ul>
      </section>

      <DeviceList devices={devices} me={session.deviceId} />
    </main>
  );
}

function StatusPill({ status }: { status: Status }) {
  const label = { online: 'Connected', connecting: 'Connecting…', offline: 'Offline' }[status];
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

function ClipRow({ clip, session, toast }: { clip: Clip; session: Session; toast: (m: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const url = clip.kind === 'text' ? '' : blobUrl(session.token, clip);
  const mine = clip.sourceDeviceId === session.deviceId;

  const copy = async () => {
    const ok = clip.kind === 'text' ? await copyText(clip.text ?? '') : await copyImage(url);
    toast(ok ? 'Copied' : 'Copy failed');
  };

  const share = async () => {
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
        <span>{mine ? 'This device' : clip.sourceName}</span>
        <span>{timeAgo(clip.createdAt)}</span>
      </div>
      {clip.kind === 'text' && (
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
        {isLink && (
          <a class="button" href={clip.text!.trim()} target="_blank" rel="noreferrer">
            Open
          </a>
        )}
        {clip.kind !== 'text' && (
          <a class="button" href={url} download={clip.name}>
            Download
          </a>
        )}
        {clip.kind !== 'text' && 'share' in navigator && <button onClick={share}>Share</button>}
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
