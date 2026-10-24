// Standalone hub for development: `npm run dev:hub`
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { Hub } from './hub.js';
import { advertise, shutdownMdns } from './mdns.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dataDir = process.env.OMNICLIP_DATA ?? path.join(root, '.omniclip-dev');

const hub = new Hub({ dataDir, webDir: path.join(root, 'apps/web/dist'), log: (m) => console.log(`[hub] ${m}`) });
await hub.start();
const stopAdvertising = advertise({ port: hub.ports.tls, networkId: hub.networkId, hubName: os.hostname() });

async function printPairing(): Promise<void> {
  const { code } = hub.getPairingCode();
  const httpUrl = hub.urls().http[0];
  console.log(`\nPairing code: ${code}`);
  if (httpUrl) {
    const url = `${httpUrl}/setup#pair=${code}`;
    console.log(`Scan to pair a phone: ${url}`);
    console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  }
}
hub.on('pairingCode', () => void printPairing());
hub.on('clip', (c) => console.log(`[clip] ${c.kind} from ${c.sourceName}: ${c.text?.slice(0, 60) ?? c.name}`));
await printPairing();

async function shutdown(): Promise<void> {
  stopAdvertising();
  await shutdownMdns();
  await hub.stop();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
