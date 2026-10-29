// Standalone hub for development: `npm run dev:hub`
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { Hub } from './hub.js';
import { advertise, shutdownMdns } from './mdns.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dataDir = process.env.OMNICLIP_DATA ?? path.join(root, '.omniclip-dev');

// OMNICLIP_HISTORY_KEY (64 hex characters) encrypts saved history on disk
const keyHex = process.env.OMNICLIP_HISTORY_KEY;
if (keyHex && !/^[0-9a-f]{64}$/i.test(keyHex)) throw new Error('OMNICLIP_HISTORY_KEY must be 64 hex characters (openssl rand -hex 32)');
const historyKey = keyHex ? Buffer.from(keyHex, 'hex') : undefined;

const hub = new Hub({ dataDir, webDir: path.join(root, 'apps/web/dist'), historyKey, log: (m) => console.log(`[hub] ${m}`) });
await hub.start();
// OMNICLIP_RELAY_URL connects this hub to an internet relay (see "Away from home" in the README)
if (process.env.OMNICLIP_RELAY_URL !== undefined && process.env.OMNICLIP_RELAY_URL !== (hub.relay?.url ?? '')) hub.useRelayUrl(process.env.OMNICLIP_RELAY_URL);
hub.on('relayStatus', (r: { status: string; detail: string }) => console.log(`[relay] ${r.status}${r.detail ? `: ${r.detail}` : ''}`));
const stopAdvertising = advertise({ port: hub.ports.tls, networkId: hub.networkId, hubName: os.hostname() });

async function printPairing(): Promise<void> {
  const { code } = hub.getPairingCode();
  const httpUrl = hub.urls().http[0];
  console.log(`\nPairing code: ${code}`);
  if (httpUrl) {
    const url = `${httpUrl}/setup#pair=${code}&ca=${hub.caPin}`;
    console.log(`Scan to pair a phone: ${url}`);
    console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  }
}
hub.on('pairingCode', () => void printPairing());
hub.on('clip', (c) => console.log(`[clip] ${c.kind} from ${c.sourceName}: ${c.sensitive ? "(hidden)" : c.enc ? "(end-to-end encrypted)" : (c.text?.slice(0, 60) ?? c.name)}`));
await printPairing();

async function shutdown(): Promise<void> {
  stopAdvertising();
  await shutdownMdns();
  await hub.stop();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
