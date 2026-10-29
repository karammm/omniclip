import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  E2E_HEADER,
  decryptBlob,
  decryptClip,
  encryptBlob,
  openJson,
  parseServerMessage,
  sealJson,
  type Clip,
  type Keyring,
  type PairResponse,
  type ServerMessage,
} from '@omniclip/protocol';
import { Hub, VIA_RELAY_HEADER } from '../src/hub.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omniclip-hub-'));
const base = 20000 + Math.floor(Math.random() * 20000);
const hub = new Hub({ dataDir, portTls: base, portHttp: base + 1, sensitiveTtlMs: 400 });
const http = `http://127.0.0.1:${base + 1}`;

async function pair(name: string, platform = 'android'): Promise<PairResponse> {
  const res = await fetch(`${http}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: hub.getPairingCode().code, name, platform }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as PairResponse;
}

function connect(token: string, e2e = false): Promise<{ ws: WebSocket; next: (type: ServerMessage['type']) => Promise<ServerMessage> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${base + 1}/ws?token=${token}${e2e ? '&e2e=1' : ''}`);
  const queue: ServerMessage[] = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (raw) => {
    const msg = parseServerMessage(raw.toString());
    if (msg) queue.push(msg);
    waiters.splice(0).forEach((w) => w());
  });
  const next = async (type: ServerMessage['type']): Promise<ServerMessage> => {
    for (;;) {
      const i = queue.findIndex((m) => m.type === type);
      if (i >= 0) return queue.splice(i, 1)[0]!;
      await new Promise<void>((r) => waiters.push(r));
    }
  };
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, next }));
    ws.once('error', reject);
  });
}

function close(...conns: { ws: WebSocket }[]): Promise<void> {
  return Promise.all(conns.map(({ ws }) => new Promise<void>((r) => (ws.readyState === ws.CLOSED ? r() : (ws.once('close', () => r()), ws.close()))))).then(
    () => new Promise((r) => setTimeout(r, 50)),
  );
}

beforeAll(() => hub.start());
afterAll(async () => {
  await hub.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('Hub', () => {
  it('rejects a wrong pairing code and unauthenticated calls', async () => {
    const res = await fetch(`${http}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '999999x', name: 'x', platform: 'ios' }),
    });
    expect(res.status).toBe(403);
    expect((await fetch(`${http}/api/clips`)).status).toBe(401);
  });

  it('single-use pairing codes rotate after success', async () => {
    const before = hub.getPairingCode().code;
    await pair('Rotator');
    expect(hub.getPairingCode().code).not.toBe(before);
  });

  it('broadcasts text and file clips to other devices', async () => {
    const phone = await pair('Pixel');
    const mac = await pair('MacBook', 'mac');
    const a = await connect(phone.token);
    const b = await connect(mac.token);
    await a.next('hello');
    const hello = await b.next('hello');
    expect(hello.type === 'hello' && hello.networkId).toBe(hub.networkId);
    expect((await b.next('registry')).type).toBe('registry'); // desktops get the failover registry

    await fetch(`${http}/api/clips`, {
      method: 'POST',
      headers: { authorization: `Bearer ${phone.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello from android' }),
    });
    const got = await b.next('clip:new');
    expect(got.type === 'clip:new' && got.clip.text).toBe('hello from android');
    expect(got.type === 'clip:new' && got.clip.sourceName).toBe('Pixel');

    const form = new FormData();
    form.append('file', new Blob([Buffer.from('PNGDATA')], { type: 'image/png' }), 'shot.png');
    const up = await fetch(`${http}/api/clips`, { method: 'POST', headers: { authorization: `Bearer ${mac.token}` }, body: form });
    const clip = (await up.json()) as { id: string; kind: string };
    expect(clip.kind).toBe('image');
    await a.next('clip:new');
    const blob = await fetch(`${http}/api/clips/${clip.id}/blob?token=${phone.token}`);
    expect(await blob.text()).toBe('PNGDATA');

    const history = (await (await fetch(`${http}/api/clips`, { headers: { authorization: `Bearer ${phone.token}` } })).json()) as unknown[];
    expect(history.length).toBe(2);
    a.ws.close();
    b.ws.close();
  });

  it('accepts raw text bodies (Apple Shortcuts)', async () => {
    const dev = await pair('Shortcut', 'shortcut');
    const res = await fetch(`${http}/api/clips`, {
      method: 'POST',
      headers: { authorization: `Bearer ${dev.token}`, 'content-type': 'text/plain' },
      body: 'plain text',
    });
    expect(((await res.json()) as { text: string }).text).toBe('plain text');
  });

  it('revoking a device kicks it and invalidates its token', async () => {
    const dev = await pair('Old phone');
    const c = await connect(dev.token);
    await c.next('hello');
    expect(hub.revokeDevice(dev.deviceId)).toBe(true);
    expect((await c.next('revoked')).type).toBe('revoked');
    expect((await fetch(`${http}/api/clips`, { headers: { authorization: `Bearer ${dev.token}` } })).status).toBe(401);
  });

  it('serves TLS with a cert chained to its CA', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      https
        .get(`https://127.0.0.1:${base}/api/info`, { ca: hub.caPem }, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve(data));
        })
        .on('error', reject);
    });
    expect(JSON.parse(body).secure).toBe(true);
  });
});

describe('pins, search, rename and removal', () => {
  const auth = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

  it('pins a clip, broadcasts the change and finds it by search', async () => {
    const phone = await pair('Searcher');
    const c = await connect(phone.token);
    await c.next('hello');
    const res = await fetch(`${http}/api/clips`, { method: 'POST', headers: auth(phone.token), body: JSON.stringify({ text: 'find the needle here' }) });
    const clip = (await res.json()) as { id: string };
    await fetch(`${http}/api/clips/${clip.id}/pin`, { method: 'POST', headers: auth(phone.token), body: JSON.stringify({ pinned: true }) });
    const upd = await c.next('clip:update');
    expect(upd.type === 'clip:update' && upd.clip.pinned).toBe(true);
    const found = (await (await fetch(`${http}/api/clips?q=NEEDLE`, { headers: auth(phone.token) })).json()) as { id: string }[];
    expect(found.map((x) => x.id)).toEqual([clip.id]);
    const pinned = (await (await fetch(`${http}/api/clips?pinned=1`, { headers: auth(phone.token) })).json()) as { id: string }[];
    expect(pinned.map((x) => x.id)).toContain(clip.id);
    c.ws.close();
  });

  it('renames the calling device', async () => {
    const phone = await pair('Old name');
    const res = await fetch(`${http}/api/me`, { method: 'PATCH', headers: auth(phone.token), body: JSON.stringify({ name: 'New name' }) });
    expect(((await res.json()) as { name: string }).name).toBe('New name');
    expect(hub.listDevices().find((d) => d.id === phone.deviceId)?.name).toBe('New name');
  });

  it('lets computers remove devices, but not phones', async () => {
    const phone = await pair('Victim');
    const other = await pair('Other phone');
    const mac = await pair('Admin Mac', 'mac');
    expect((await fetch(`${http}/api/devices/${phone.deviceId}`, { method: 'DELETE', headers: { authorization: `Bearer ${other.token}` } })).status).toBe(403);
    expect((await fetch(`${http}/api/devices/${phone.deviceId}`, { method: 'DELETE', headers: { authorization: `Bearer ${mac.token}` } })).status).toBe(200);
    expect(hub.listDevices().some((d) => d.id === phone.deviceId)).toBe(false);
  });
});

describe('raw uploads', () => {
  it('stores a raw image body as an image clip', async () => {
    const dev = await pair('Shortcut img', 'shortcut');
    const res = await fetch(`${http}/api/clips`, {
      method: 'POST',
      headers: { authorization: `Bearer ${dev.token}`, 'content-type': 'image/png' },
      body: Buffer.from('rawpng'),
    });
    const clip = (await res.json()) as { kind: string; size: number; name: string };
    expect(clip).toMatchObject({ kind: 'image', size: 6, name: 'image.png' });
  });

  it('delivers a clip sent to one device only to that device and the sender', async () => {
    const a = await pair('Sender', 'mac');
    const b = await pair('Target', 'android');
    const c = await pair('Bystander', 'ios');
    const [ca, cb, cc] = await Promise.all([connect(a.token), connect(b.token), connect(c.token)]);
    await Promise.all([ca.next('hello'), cb.next('hello'), cc.next('hello')]);
    const seenByBystander: string[] = [];
    cc.ws.on('message', (raw) => {
      const m = parseServerMessage(raw.toString());
      if (m?.type === 'clip:new') seenByBystander.push(m.clip.text ?? '');
    });

    const res = await fetch(`${http}/api/clips?to=${b.deviceId}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'just for you' }),
    });
    expect(res.status).toBe(200);
    const sent = (await res.json()) as { id: string; targetDeviceId: string; targetName: string };
    expect(sent.targetName).toBe('Target');

    const atTarget = await cb.next('clip:new');
    const atSender = await ca.next('clip:new');
    expect(atTarget.type === 'clip:new' && atTarget.clip.text).toBe('just for you');
    expect(atSender.type === 'clip:new' && atSender.clip.id).toBe(sent.id);

    const list = async (token: string) =>
      ((await (await fetch(`${http}/api/clips`, { headers: { authorization: `Bearer ${token}` } })).json()) as { id: string }[]).map((x) => x.id);
    expect(await list(b.token)).toContain(sent.id);
    expect(await list(c.token)).not.toContain(sent.id);
    const blob = await fetch(`${http}/api/clips/${sent.id}/blob`, { headers: { authorization: `Bearer ${c.token}` } });
    expect(blob.status).toBe(404);

    const unknown = await fetch(`${http}/api/clips?to=nope`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    expect(unknown.status).toBe(404);
    expect(seenByBystander).not.toContain('just for you');
    await close(ca, cb, cc);
  });

  it('keeps passwords off disk, refuses to pin them and deletes them when they expire', async () => {
    const a = await pair('Laptop', 'windows');
    const conn = await connect(a.token);
    await conn.next('hello');
    const post = (text: string, query = '') =>
      fetch(`${http}/api/clips${query}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      }).then((r) => r.json() as Promise<{ id: string; sensitive?: boolean; expiresAt?: number }>);

    const secret = await post('Tr0ub4dor&3');
    expect(secret.sensitive).toBe(true);
    expect(secret.expiresAt).toBeGreaterThan(Date.now());
    expect((await post('plain words')).sensitive).toBeUndefined();
    expect((await post('Tr0ub4dor&4', '?sensitive=0')).sensitive).toBeUndefined();
    expect((await post('hello there', '?sensitive=1')).sensitive).toBe(true);

    expect(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8')).not.toContain('Tr0ub4dor&3');
    const pin = await fetch(`${http}/api/clips/${secret.id}/pin`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    });
    expect(pin.status).toBe(400);

    const removed = await conn.next('clip:remove');
    expect(removed.type === 'clip:remove' && removed.id).toBe(secret.id);
    expect(hub.store.clip(secret.id)).toBeUndefined();
    await close(conn);
  });

  it('keeps formatting with text, but not with passwords', async () => {
    const mac = await pair('Rich Mac', 'mac');
    const post = async (body: object) =>
      (await (
        await fetch(`${http}/api/clips`, {
          method: 'POST',
          headers: { authorization: `Bearer ${mac.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as { html?: string; rtf?: string; sensitive?: boolean };
    const rich = await post({ text: 'hello bold', html: '<b>hello</b> bold', rtf: '{\\rtf1 {\\b hello} bold}' });
    expect(rich.html).toBe('<b>hello</b> bold');
    expect(rich.rtf).toContain('rtf1');
    const secret = await post({ text: 'Tr0ub4dor&3xyz', html: '<span>Tr0ub4dor&amp;3xyz</span>' });
    expect(secret.sensitive).toBe(true);
    expect(secret.html).toBeUndefined();
  });

  it('marks a zip uploaded as a folder', async () => {
    const mac = await pair('Folder Mac', 'mac');
    const upload = async (mime: string, name: string) => {
      const form = new FormData();
      form.append('kind', 'file');
      form.append('folder', '1');
      form.append('file', new Blob([new Uint8Array([80, 75, 5, 6])], { type: mime }), name);
      return (await (await fetch(`${http}/api/clips`, { method: 'POST', headers: { authorization: `Bearer ${mac.token}` }, body: form })).json()) as {
        kind: string;
        folder?: boolean;
      };
    };
    expect(await upload('application/zip', 'Photos.zip')).toMatchObject({ kind: 'file', folder: true });
    expect((await upload('text/plain', 'notes.txt')).folder).toBeUndefined();
  });
});

describe('end-to-end encryption', () => {
  const e2eHeaders = (t: string) => ({ authorization: `Bearer ${t}`, [E2E_HEADER]: '1', 'content-type': 'application/json' });

  it('hands out the keyring and a tunnel key when pairing', async () => {
    const phone = await pair('Keyed phone');
    expect(phone.keys?.keys[phone.keys.current]).toBeTruthy();
    expect(phone.tunnelKey).toBeTruthy();
    expect(phone.keys).toEqual(hub.store.keys);
  });

  it('relays encrypted text untouched to encrypting devices and decrypted to the others', async () => {
    const a = await pair('E2E sender', 'mac');
    const b = await pair('E2E reader', 'android');
    const old = await pair('Old v0.7 phone', 'ios');
    const keys = a.keys as Keyring;
    const [ca, cb, co] = await Promise.all([connect(a.token, true), connect(b.token, true), connect(old.token)]);
    const helloB = await cb.next('hello');
    expect(helloB.type === 'hello' && helloB.keys?.current).toBe(keys.current);
    const helloOld = await co.next('hello');
    expect(helloOld.type === 'hello' && helloOld.keys).toBeUndefined();
    await ca.next('hello');

    const enc = await sealJson(keys, { text: 'only devices can read this', hash: 'h1' });
    const res = await fetch(`${http}/api/clips`, { method: 'POST', headers: e2eHeaders(a.token), body: JSON.stringify({ enc, size: 26 }) });
    expect(res.status).toBe(200);
    const sent = (await res.json()) as Clip;
    expect(sent.text).toBeUndefined();

    const atB = await cb.next('clip:new');
    expect(atB.type === 'clip:new' && atB.clip.enc).toEqual(enc);
    expect(atB.type === 'clip:new' && (await decryptClip(atB.clip, keys)).text).toBe('only devices can read this');
    const atOld = await co.next('clip:new');
    expect(atOld.type === 'clip:new' && atOld.clip.text).toBe('only devices can read this');
    expect(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8')).not.toContain('only devices can read this');
    await close(ca, cb, co);
  });

  it('encrypts what plain clients send, so it is never stored readable', async () => {
    const shortcut = await pair('Plain Shortcut', 'shortcut');
    const res = await fetch(`${http}/api/clips`, { method: 'POST', headers: { authorization: `Bearer ${shortcut.token}`, 'content-type': 'text/plain' }, body: 'sent by a shortcut' });
    const back = (await res.json()) as Clip;
    expect(back.text).toBe('sent by a shortcut');
    const stored = hub.store.clip(back.id)!;
    expect(stored.text).toBeUndefined();
    expect((await openJson<{ text: string }>(hub.store.keys, stored.enc!)).text).toBe('sent by a shortcut');
    expect(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8')).not.toContain('sent by a shortcut');
  });

  it('stores encrypted files as uploaded and serves plain clients the decrypted file', async () => {
    const mac = await pair('E2E files', 'mac');
    const phone = await pair('Plain browser', 'web');
    const keys = mac.keys as Keyring;
    const form = new FormData();
    form.append('kind', 'image');
    form.append('size', '9');
    form.append('enc', JSON.stringify(await sealJson(keys, { name: 'cat.png', mime: 'image/png', hash: 'x' })));
    form.append('file', new Blob([await encryptBlob(keys, new TextEncoder().encode('CAT-IMAGE'))]), 'blob');
    const clip = (await (await fetch(`${http}/api/clips`, { method: 'POST', headers: { authorization: `Bearer ${mac.token}`, [E2E_HEADER]: '1' }, body: form })).json()) as Clip;
    expect(clip).toMatchObject({ kind: 'image', size: 9 });

    const raw = new Uint8Array(await (await fetch(`${http}/api/clips/${clip.id}/blob`, { headers: { authorization: `Bearer ${mac.token}`, [E2E_HEADER]: '1' } })).arrayBuffer());
    expect(new TextDecoder().decode(await decryptBlob(keys, raw))).toBe('CAT-IMAGE');
    const plain = await fetch(`${http}/api/clips/${clip.id}/blob?token=${phone.token}`);
    expect(plain.headers.get('content-type')).toBe('image/png');
    expect(await plain.text()).toBe('CAT-IMAGE');
  });

  it('rotates the key when a device is removed and tells the others', async () => {
    const stay = await pair('Staying Mac', 'mac');
    const leave = await pair('Leaving phone');
    const c = await connect(stay.token, true);
    await c.next('hello');
    const before = hub.store.keys.current;
    expect(hub.revokeDevice(leave.deviceId)).toBe(true);
    const msg = await c.next('keys');
    expect(msg.type === 'keys' && msg.keys.current).not.toBe(before);
    expect(msg.type === 'keys' && msg.keys.keys[before]).toBeTruthy(); // old history stays readable
    await close(c);
  });

  it('serves only encrypting clients through the relay, and never pairs there', async () => {
    const dev = await pair('Far away phone');
    const viaRelay = { authorization: `Bearer ${dev.token}`, [VIA_RELAY_HEADER]: '1' };
    expect((await fetch(`${http}/api/clips`, { headers: viaRelay })).status).toBe(403);
    expect((await fetch(`${http}/api/clips`, { headers: { ...viaRelay, [E2E_HEADER]: '1' } })).status).toBe(200);
    const pairRes = await fetch(`${http}/api/pair`, { method: 'POST', headers: { [VIA_RELAY_HEADER]: '1', 'content-type': 'application/json' }, body: '{}' });
    expect(pairRes.status).toBe(403);
  });

  it('keeps snippets encrypted and decrypts them for plain clients', async () => {
    const mac = await pair('Snippet Mac', 'mac');
    const plain = await pair('Snippet browser', 'web');
    const keys = mac.keys as Keyring;
    const c = await connect(mac.token, true);
    await c.next('hello');
    const enc = await sealJson(keys, { name: 'Address', keyword: 'addr', text: '1 Infinite Loop' });
    expect((await fetch(`${http}/api/snippets/addr-1`, { method: 'PUT', headers: e2eHeaders(mac.token), body: JSON.stringify({ enc }) })).status).toBe(200);
    const update = await c.next('snippets');
    expect(update.type === 'snippets' && update.snippets[0]?.enc).toEqual(enc);
    const list = (await (await fetch(`${http}/api/snippets`, { headers: { authorization: `Bearer ${plain.token}` } })).json()) as { text?: string }[];
    expect(list.map((x) => x.text)).toContain('1 Infinite Loop');
    expect(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8')).not.toContain('Infinite Loop');
    expect((await fetch(`${http}/api/snippets/addr-1`, { method: 'DELETE', headers: { authorization: `Bearer ${mac.token}` } })).status).toBe(200);
    await close(c);
  });
});
