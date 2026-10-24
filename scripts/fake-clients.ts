// End-to-end smoke test: a real hub (TLS) plus three fake devices. Run: npm run test:e2e
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hub } from '../apps/hub/src/hub.js';
import { SyncClient, pairWithHub } from '../apps/desktop/src/client.js';
import type { Clip } from '../packages/protocol/src/index.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omniclip-e2e-'));
const port = 30000 + Math.floor(Math.random() * 10000);
const hub = new Hub({ dataDir, portTls: port, portHttp: port + 1 });
await hub.start();
const addr = { host: '127.0.0.1', port };

const names = ['MacBook', 'Windows laptop', 'Pixel'] as const;
const platforms = ['mac', 'windows', 'android'] as const;
const clients: SyncClient[] = [];
const received = new Map<string, Clip[]>();

for (let i = 0; i < names.length; i++) {
  const res = await pairWithHub(addr, hub.getPairingCode().code, names[i], platforms[i]);
  const c = new SyncClient(addr, res.token, res.caPem);
  received.set(names[i], []);
  c.on('clip', (clip) => received.get(names[i])!.push(clip));
  clients.push(c);
}
await Promise.all(
  clients.map(
    (c) =>
      new Promise<void>((resolve) => {
        c.once('hello', () => resolve());
        c.start();
      }),
  ),
);
console.log(`✓ ${clients.length} devices paired over TLS and connected`);

const [mac, win, pixel] = clients as [SyncClient, SyncClient, SyncClient];
await mac.sendText('copied on the mac');
await win.sendFile(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'screenshot.png', 'image/png');
await pixel.sendFile(Buffer.from('%PDF-1.4 hello'), 'notes.pdf', 'application/pdf', true);
await new Promise((r) => setTimeout(r, 500));

for (const name of names) {
  const kinds = received.get(name)!.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ['file', 'image', 'text'], `${name} should receive all three clips`);
}
console.log('✓ every device received the text, image and file clips');

const file = received.get('MacBook')!.find((c) => c.kind === 'file')!;
assert.equal((await mac.fetchBlob(file)).toString(), '%PDF-1.4 hello');
console.log('✓ blobs download intact');

assert.equal(hub.store.clips().length, 3);
console.log('✓ history holds all clips');

clients.forEach((c) => c.stop());
await hub.stop();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('\nE2E passed');
process.exit(0);
