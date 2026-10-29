// Relay end-to-end test: a hub and a "far away" device that can only reach it through the relay.
// Start the relay first:  npm run dev -w @omniclip/relay   (http://127.0.0.1:8787)
// Then:                   npm run test:relay
// A recording proxy sits between everyone and the relay, to check the relay never sees anything readable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { Hub } from '../apps/hub/src/hub.js';
import { SyncClient, pairWithHub } from '../apps/desktop/src/client.js';
import type { Clip, PlainSnippet } from '../apps/desktop/src/client.js';

const RELAY = process.env.RELAY_URL ?? 'http://127.0.0.1:8787';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => T | undefined | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(100);
  }
}

// ---- recording proxy in front of the relay
const seen: Buffer[] = [];
const proxy = http.createServer(async (req, res) => {
  const upstream = await fetch(RELAY + req.url, { headers: { authorization: req.headers.authorization ?? '' } });
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'text/plain' });
  res.end(Buffer.from(await upstream.arrayBuffer()));
});
const wss = new WebSocketServer({ server: proxy });
wss.on('connection', (client, req) => {
  const up = new WebSocket(RELAY.replace(/^http/, 'ws') + req.url);
  const queue: Array<[Buffer, boolean]> = [];
  up.on('open', () => queue.splice(0).forEach(([d, b]) => up.send(d, { binary: b })));
  client.on('message', (d: Buffer, b) => {
    seen.push(Buffer.from(d));
    if (up.readyState === WebSocket.OPEN) up.send(d, { binary: b });
    else queue.push([d, b]);
  });
  up.on('message', (d: Buffer, b) => {
    seen.push(Buffer.from(d));
    if (client.readyState === WebSocket.OPEN) client.send(d, { binary: b });
  });
  const end = (ws: WebSocket, code: number, reason: Buffer) => ws.readyState <= WebSocket.OPEN && ws.close(code >= 3000 || code === 1000 ? code : 1000, reason);
  client.on('close', (c, r) => end(up, c, r));
  up.on('close', (c, r) => end(client, c, r));
});
await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;

// ---- hub, a computer at home, and a phone away from home
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omniclip-relay-'));
const port = 31000 + Math.floor(Math.random() * 9000);
const hub = new Hub({ dataDir, portTls: port, portHttp: port + 1 });
await hub.start();
const addr = { host: '127.0.0.1', port };

hub.useRelayUrl(proxyUrl);
await until('the hub to reach the relay', () => hub.relayStatus.status === 'online');
console.log('✓ hub connected to the relay');

const homeRes = await pairWithHub(addr, hub.getPairingCode().code, 'Home Mac', 'mac');
const home = new SyncClient(addr, homeRes.token, homeRes.caPem, { keys: homeRes.keys });
const phoneRes = await pairWithHub(addr, hub.getPairingCode().code, 'Far phone', 'android');
assert.ok(phoneRes.relay && phoneRes.tunnelKey, 'pairing hands out the relay and a tunnel key');

// the phone "leaves home": its local-network address no longer answers
const nowhere = { host: '127.0.0.1', port: 9 };
const phone = new SyncClient(nowhere, phoneRes.token, phoneRes.caPem, { keys: phoneRes.keys, tunnelKey: phoneRes.tunnelKey, relay: phoneRes.relay }, { networkId: phoneRes.networkId, deviceId: phoneRes.deviceId, viaRelay: true });
const atHome: Clip[] = [];
const atPhone: Clip[] = [];
let phoneSnippets: PlainSnippet[] = [];
home.on('clip', (c) => atHome.push(c));
phone.on('clip', (c) => atPhone.push(c));
phone.on('snippets', (s) => (phoneSnippets = s));
await new Promise<void>((r) => {
  home.once('hello', () => r());
  home.start();
});
const phoneHello = new Promise<void>((r) => phone.once('hello', () => r()));
phone.start();
await phoneHello;
assert.equal(phone.via, 'relay');
console.log('✓ the far-away phone connected through the relay and the tunnel');

const SECRET_TEXT = 'sent through the relay 7f3a';
await home.sendText(SECRET_TEXT);
await until('the phone to get the text', () => atPhone.find((c) => c.text === SECRET_TEXT));
const FAR_TEXT = 'typed far from home 91bc';
await phone.sendText(FAR_TEXT);
await until('home to get the text', () => atHome.find((c) => c.text === FAR_TEXT));
console.log('✓ text goes both ways through the relay');

const photo = Buffer.alloc(700_000, 7);
photo.write('PHOTO-MARKER-55', 1000);
await phone.sendFile(photo, 'beach.png', 'image/png');
const img = await until('home to get the photo', () => atHome.find((c) => c.kind === 'image'));
assert.ok((await home.fetchBlob(img)).equals(photo));
assert.ok((await phone.fetchBlob(img)).equals(photo), 'downloads through the relay too');
console.log('✓ a 700 KB photo goes through the relay and downloads intact');

assert.deepEqual((await phone.search('relay 7f3a')).map((c) => c.text), [SECRET_TEXT]);
await phone.saveSnippet('far', { name: 'From afar', text: 'SNIPPET-BODY-88' });
await until('the snippet to sync', () => phoneSnippets.some((s) => s.text === 'SNIPPET-BODY-88'));
console.log('✓ search and snippets work through the relay');

// the relay only ever saw encrypted frames
const all = Buffer.concat(seen).toString('latin1');
for (const needle of [SECRET_TEXT, FAR_TEXT, 'PHOTO-MARKER-55', 'SNIPPET-BODY-88', 'beach.png', phoneRes.token, phoneRes.tunnelKey!, phoneRes.keys!.keys[phoneRes.keys!.current]!]) {
  assert.ok(!all.includes(needle), `the relay saw ${needle.slice(0, 20)}`);
}
console.log(`✓ the relay saw ${seen.length} frames and none of the text, file, names, token or keys`);

// the hub reconnects (e.g. after a restart): the phone finds its way back
hub.useRelayUrl(proxyUrl);
await until('the phone to drop', () => phone.status !== 'online', 10_000);
await until('the phone to reconnect through the relay', () => phone.status === 'online' && phone.via === 'relay', 40_000);
await phone.sendText('after the reconnect');
await until('home to get it', () => atHome.find((c) => c.text === 'after the reconnect'));
console.log('✓ the phone reconnects after the hub reconnects to the relay');

// a laptop on the local network loses the hub, falls back to the relay, and switches back when home
const lanPort = 41000 + Math.floor(Math.random() * 9000);
const live = new Set<net.Socket>();
let lan: net.Server | undefined;
const openLan = () =>
  new Promise<void>((r) => {
    lan = net.createServer((sock) => {
      const up = net.connect(port, '127.0.0.1');
      live.add(sock).add(up);
      sock.pipe(up).pipe(sock);
      const done = () => (sock.destroy(), up.destroy());
      sock.on('error', done).on('close', done);
      up.on('error', done).on('close', done);
    });
    lan.listen(lanPort, '127.0.0.1', () => r());
  });
const cutLan = () => {
  lan?.close();
  for (const s of live) s.destroy();
  live.clear();
};
await openLan();
const laptopRes = await pairWithHub({ host: '127.0.0.1', port: lanPort }, hub.getPairingCode().code, 'Laptop', 'windows');
const laptop = new SyncClient({ host: '127.0.0.1', port: lanPort }, laptopRes.token, laptopRes.caPem, { keys: laptopRes.keys, tunnelKey: laptopRes.tunnelKey, relay: laptopRes.relay }, { networkId: laptopRes.networkId, deviceId: laptopRes.deviceId });
await new Promise<void>((r) => {
  laptop.once('hello', () => r());
  laptop.start();
});
assert.equal(laptop.via, 'lan');
cutLan();
await until('the laptop to fall back to the relay', () => laptop.status === 'online' && laptop.via === 'relay', 30_000);
console.log('✓ a laptop that loses the hub on the local network moves to the relay');
await openLan();
await until('the laptop to come back to the local network', () => laptop.status === 'online' && laptop.via === 'lan', 60_000);
console.log('✓ and moves back when the hub is reachable again');
laptop.stop();
cutLan();

home.stop();
phone.stop();
await hub.stop();
proxy.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('\nRelay E2E passed');
process.exit(0);
