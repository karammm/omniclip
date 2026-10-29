import { describe, expect, it } from 'vitest';
import { TunnelClient, TunnelServer, relayUrl, toBase64, type TunnelMessage } from '../src/index';

const key = () => toBase64(crypto.getRandomValues(new Uint8Array(32)));
const tick = () => new Promise((r) => setTimeout(r, 20));

/** A device and a hub joined by an in-memory "relay" that records (and can tamper with) frames. */
function pair(deviceKey: string, hubKnows: string | undefined) {
  const toHub: Uint8Array[] = [];
  const toDevice: Uint8Array[] = [];
  let server!: TunnelServer;
  let client!: TunnelClient;
  const relay = { tamper: (_d: Uint8Array): Uint8Array | null => _d };
  client = new TunnelClient({ send: (d) => { toHub.push(d); const t = relay.tamper(d); if (t) server.receive(t); }, close: () => {} }, 'dev-1', deviceKey);
  server = new TunnelServer({ send: (d) => { toDevice.push(d); client.receive(d); }, close: () => {} }, (id) => (id === 'dev-1' ? hubKnows : undefined));
  return { client, server, toHub, toDevice, relay };
}

describe('relay tunnel', () => {
  it('handshakes and carries messages both ways, unreadable to the relay', async () => {
    const k = key();
    const { client, server, toHub } = pair(k, k);
    const atHub: TunnelMessage[] = [];
    const atDevice: TunnelMessage[] = [];
    server.onMessage = (m) => atHub.push(m);
    client.onMessage = (m) => atDevice.push(m);
    await client.start();
    await tick();
    expect(server.deviceId).toBe('dev-1');
    client.send({ t: 'req', secret: 'token-abc' });
    server.send({ t: 'res', body: 'x'.repeat(700_000) }); // several fragments
    await tick();
    await tick();
    expect(atHub).toEqual([{ t: 'req', secret: 'token-abc' }]);
    expect((atDevice[0]!.body as string).length).toBe(700_000);
    const seen = toHub.map((f) => new TextDecoder().decode(f)).join('');
    expect(seen).not.toContain('token-abc');
  });

  it('refuses a hub that does not know the tunnel key (a relay pretending to be the hub)', async () => {
    const { client } = pair(key(), key());
    await expect(client.start()).rejects.toThrow(/not your hub/);
  });

  it('refuses unknown devices', async () => {
    const { client, server } = pair(key(), undefined);
    let reason = '';
    server.onClose = (r) => (reason = r);
    void client.start().catch(() => {});
    await tick();
    expect(reason).toBe('unknown device');
  });

  it('drops the tunnel when a frame is replayed or changed', async () => {
    const k = key();
    const { client, server, relay } = pair(k, k);
    const atHub: TunnelMessage[] = [];
    server.onMessage = (m) => atHub.push(m);
    let closed = '';
    server.onClose = (r) => (closed = r);
    await client.start();
    await tick();
    let first: Uint8Array | null = null;
    relay.tamper = (d) => (first ??= d);
    client.send({ t: 'one' });
    await tick();
    client.send({ t: 'two' }); // the relay replays the first frame instead
    await tick();
    expect(atHub).toEqual([{ t: 'one' }]);
    expect(closed).toMatch(/tunnel error/);
  });

  it('builds relay URLs from what people type', () => {
    expect(relayUrl('omniclip-relay.me.workers.dev', 'n1', 'device')).toBe('wss://omniclip-relay.me.workers.dev/v1/n1/device');
    expect(relayUrl('https://relay.example.com/', 'n1', 'status')).toBe('https://relay.example.com/v1/n1/status');
    expect(relayUrl('http://127.0.0.1:8787', 'n1', 'hub')).toBe('ws://127.0.0.1:8787/v1/n1/hub');
  });
});
