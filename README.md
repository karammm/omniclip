# OmniClip

One clipboard for every device on your Wi-Fi. Copy on your MacBook and paste on your iPhone. Share a photo from Android and paste it on Windows. Drop a file on the Mac and pick it up on the iPad.

| Device | How it joins | Sending | Receiving |
| --- | --- | --- | --- |
| Mac / Windows | Desktop tray app | Automatic: just copy | Automatic: just paste |
| Android | Web app (installable) | **Paste & Send**, or **Share → OmniClip** from any app | Tap **Copy** |
| iPhone / iPad | Web app (Add to Home Screen) | **Paste & Send**, or a one-tap Shortcut | Tap **Copy** |

Everything stays on your local network. There is no cloud and no account.

## How it works

```
 ┌──────────── Desktop app (Electron, Mac/Win) ────────────┐
 │  Tray menu · clipboard watcher                           │
 │  Embedded hub (on one desktop, chosen automatically):     │
 │    HTTPS + WebSocket server · history · file store        │
 │    advertised on the LAN with mDNS · serves the web app   │
 └──────────────────────────────────────────────────────────┘
        ▲ wss (found via mDNS)          ▲ https (paired via QR)
 Other Mac/Windows desktops      iPhone / iPad / Android (PWA)
```

- **Hub election.** Every desktop runs the same app. On launch it looks for an OmniClip hub on the LAN. If it finds one, it joins. If not, it becomes the hub.
- **Failover.** The hub shares its device list and certificate authority with the other paired desktops. If the hub computer goes away for more than 10 seconds, another desktop takes over. Desktops reconnect automatically.
- **Security.** Devices pair with a one-time 6-digit code. Each device gets its own token, and you can remove a device from the tray menu. Traffic is encrypted with TLS using a private certificate authority that the hub generates.
- **Why phones need a certificate.** Browsers only allow clipboard access and app install over HTTPS. You install OmniClip's certificate once per phone. If you can't, there is a **basic mode** over plain HTTP: copying still works, and to send you paste into a text box.
- **iOS limits.** iOS never lets apps read the clipboard in the background, so sending from an iPhone or iPad always takes one tap. That's an Apple restriction, not an OmniClip one.

## Using it

1. **Install the desktop app** on your Mac and/or Windows PC (see *Build* below) and launch it. A clipboard icon appears in the menu bar or system tray.
2. **Pair a phone.** In the tray menu, choose **Pair a phone or tablet…** and scan the QR code with the phone's camera. The setup page walks you through it:
   - Download and trust the certificate (one time).
   - Open the secure app and tap **Pair**.
   - Add it to the Home Screen (iOS: Share → Add to Home Screen; Android: ⋮ → Install app).
3. **Add another computer.** Launch OmniClip on it. It finds the hub and shows a notification. Choose **Join …** in its tray menu and enter the code from the hub's pairing window.

### iPhone one-tap Shortcut (optional)

The app's setup page (⚙︎ in the app, secure mode) shows your device's URL and token. In the Shortcuts app:

1. **Get Clipboard**
2. **Get Contents of URL**: `https://<hub-ip>:7878/api/clips`, Method **POST**, Header `Authorization: Bearer <token>`, Request Body **File** = *Clipboard*

Add it to the Share sheet, or to **Settings → Accessibility → Touch → Back Tap** for a double-tap on the back of the phone. Text and images both work.

### Tray menu

- **Recent**: click any clip to put it back on this computer's clipboard.
- **Send file…** (or drag files onto the menu-bar icon on a Mac): files land in `Downloads/OmniClip` on the other computers, with a notification.
- **Pause syncing**, **Devices** (remove a device), **Open at login**.

## Development

Requirements: Node 22.12+ (developed on Node 24).

```bash
npm install
node node_modules/electron/install.js   # npm 11 blocks Electron's download script; run it once
npm run icons                           # regenerate icons (already generated)

npm test                 # unit tests (vitest)
npm run test:e2e         # real TLS hub + 3 fake devices exchanging text/image/file
npm run typecheck

npm run dev:hub          # standalone hub in the terminal, prints a pairing QR
npm run dev:desktop      # builds the web app, bundles and launches the Electron tray app
```

Layout:

```
packages/protocol   zod schemas + types shared by everything
apps/hub            Fastify HTTPS/WebSocket server, JSON store, local CA, mDNS
apps/web            Preact PWA served by the hub (feed, Paste & Send, setup, share target)
apps/desktop        Electron tray app: election/failover, clipboard watcher, pairing window
scripts             icon generator, end-to-end smoke test
```

Ports: `7878` (HTTPS/WSS) and `7879` (HTTP for first-time setup and basic mode). Hub data, certificates and file blobs live in the app's user-data folder. History keeps 200 clips and up to 1 GB of images and files, deleting the oldest first.

## Build installers

```bash
npm run dist:mac    # apps/desktop/release/OmniClip-<version>.dmg
npm run dist:win    # apps/desktop/release/OmniClip Setup <version>.exe (run on Windows, or on a Mac with Wine)
```

The installers are unsigned:
- **macOS:** right-click OmniClip.app → **Open** the first time. Also allow **Local Network** access when macOS asks.
- **Windows:** on the SmartScreen prompt, click **More info → Run anyway**. Allow access on **private networks** when the firewall asks.

## Known limitations (v1)

- iPhone and iPad need a tap to send and to copy (iOS restriction).
- After a hub failover, phones keep working only if they reopen the app at the **new hub's** address (rescan the QR from the new hub). Desktops move over automatically.
- No Bluetooth. Devices must be on the same Wi-Fi/LAN, and guest networks with client isolation won't work.
- Copying files in Finder or Explorer isn't picked up automatically. Use **Send file…** or drag onto the tray icon.
