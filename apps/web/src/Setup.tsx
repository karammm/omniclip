import { useState } from 'preact/hooks';
import { HUB_PORT_TLS } from '@omniclip/protocol';
import { detectPlatform, type Session } from './api';
import { copyText, secure } from './clipboard';
import { Icon } from './Icon';

export function Setup({ session }: { session: Session | null }) {
  const platform = detectPlatform();
  const apple = platform === 'ios' || platform === 'ipados';
  const hash = location.hash; // carries #pair=CODE from the QR
  const secureUrl = `https://${location.hostname}:${HUB_PORT_TLS}/${hash}`;
  const [shown, setShown] = useState(false);

  const step = (n: number | null, title: string) => (
    <div class="step-head">
      {n !== null && <span class="num">{n}</span>}
      <h2>{title}</h2>
    </div>
  );

  return (
    <main class="app setup">
      <header class="topbar">
        <div class="brand">
          <img class="logo" src="/icons/icon-192.png" alt="" width={30} height={30} />
          Setup
        </div>
        <span class="spacer" />
        <a class="btn sm" href={`/${hash}`}>
          Done
        </a>
      </header>

      {secure ? (
        <section class="card ok-card">
          <span class="avatar lg ok">
            <Icon name="lock" />
          </span>
          <div>
            <h2>Secure connection</h2>
            <p>Paste &amp; Send, image copy and offline mode all work here.</p>
          </div>
        </section>
      ) : (
        <>
          <section class="card step">
            {step(1, 'Install the OmniClip certificate')}
            <p>
              Your phone only allows clipboard access over a secure connection. OmniClip creates a private certificate on your computer. Install it once,
              and every OmniClip page becomes secure.
            </p>
            <a class="btn primary" href="/ca.crt">
              <Icon name="download" size="sm" />
              Download certificate
            </a>
            {apple ? (
              <ol>
                <li>
                  Tap <b>Allow</b> when Safari asks to download a configuration profile.
                </li>
                <li>
                  Open <b>Settings → Profile Downloaded → Install</b>.
                </li>
                <li>
                  Go to <b>Settings → General → About → Certificate Trust Settings</b> and switch on <b>OmniClip Local CA</b>.
                </li>
              </ol>
            ) : (
              <ol>
                <li>Download the certificate.</li>
                <li>
                  Open <b>Settings → Security &amp; privacy → More security settings → Install from device storage → CA certificate</b> (the wording varies
                  by phone; search Settings for "certificate").
                </li>
                <li>
                  Pick <b>OmniClip-CA.crt</b> from Downloads.
                </li>
              </ol>
            )}
          </section>

          <section class="card step">
            {step(2, 'Open the secure app')}
            <a class="btn primary" href={secureUrl}>
              <Icon name="lock" size="sm" />
              Open OmniClip (secure)
            </a>
            <p class="muted small" style={{ marginTop: '10px' }}>
              {secureUrl}
            </p>
          </section>
        </>
      )}

      <section class="card step">
        {step(secure ? null : 3, 'Add to Home Screen')}
        {apple ? (
          <p>
            In Safari, tap <b>Share</b> → <b>Add to Home Screen</b>. OmniClip then opens like an app.
          </p>
        ) : (
          <p>
            In Chrome, tap <b>⋮</b> → <b>Install app</b>. OmniClip then appears in your <b>Share</b> menu, so you can send text, photos and files from any
            app.
          </p>
        )}
      </section>

      {!secure && (
        <section class="card step">
          {step(null, "Can't install certificates?")}
          <p>Use basic mode instead. You can still copy from other devices. To send, you paste into a text box by hand.</p>
          <a class="btn" href={`/${hash}`}>
            Continue in basic mode
          </a>
        </section>
      )}

      {apple && session && secure && (
        <section class="card step">
          <div class="step-head">
            <span class="avatar">
              <Icon name="zap" />
            </span>
            <h2>Optional: one-tap Shortcut</h2>
          </div>
          <p>iOS can send your clipboard without opening the app, from the Share sheet or with Back Tap:</p>
          <ol>
            <li>
              Open <b>Shortcuts</b> → <b>+</b> → add <b>Get Clipboard</b>.
            </li>
            <li>
              Add <b>Get Contents of URL</b>. URL: the address below. Method: <b>POST</b>. Header <b>Authorization</b>: the value below. Request Body:{' '}
              <b>File</b> → <i>Clipboard</i>.
            </li>
            <li>
              Name it "Send to OmniClip". Optionally turn it on under <b>Settings → Accessibility → Touch → Back Tap</b>.
            </li>
          </ol>
          <div class="kv">
            <span>URL</span>
            <code>{`${location.origin}/api/clips`}</code>
            <button class="btn sm" onClick={() => copyText(`${location.origin}/api/clips`)}>
              Copy
            </button>
          </div>
          <div class="kv">
            <span>Authorization</span>
            <code>{shown ? `Bearer ${session.token}` : 'Bearer ••••••••'}</code>
            <button class="btn sm" onClick={() => (shown ? copyText(`Bearer ${session.token}`) : setShown(true))}>
              {shown ? 'Copy' : 'Reveal'}
            </button>
          </div>
          <p class="muted small">This token works like a password for this device. Don't share it.</p>
        </section>
      )}
    </main>
  );
}
