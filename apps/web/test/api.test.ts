import { describe, expect, it } from 'vitest';
import { parseHubInput, pinOf } from '../src/api';

const urls = (host: string) => ({ host, hub: `https://${host}:7878`, http: `http://${host}:7879` });

describe('parseHubInput', () => {
  it('reads the desktop QR link, including the CA pin', () => {
    expect(parseHubInput('http://192.168.1.5:7879/setup#pair=123456&ca=abc_-9')).toEqual({ ...urls('192.168.1.5'), code: '123456', ca: 'abc_-9' });
  });

  it('accepts older QR links without a pin', () => {
    expect(parseHubInput('https://192.168.1.5:7878/#pair=654321')).toEqual({ ...urls('192.168.1.5'), code: '654321', ca: undefined });
  });

  it('accepts a bare address', () => {
    expect(parseHubInput(' 10.0.0.7 ')).toEqual({ ...urls('10.0.0.7'), code: undefined, ca: undefined });
  });

  it('reads omniclip:// pairing links', () => {
    expect(parseHubInput('omniclip://pair?hub=192.168.1.5&code=111222&ca=xyz')).toEqual({ ...urls('192.168.1.5'), code: '111222', ca: 'xyz' });
  });

  it('rejects junk', () => {
    expect(parseHubInput('')).toBeNull();
    expect(parseHubInput('omniclip://pair')).toBeNull();
  });
});

describe('pinOf', () => {
  it('matches the hub pin format (base64url SHA-256 of the DER)', async () => {
    const { createCA, pinFingerprint } = await import('../../hub/src/certs');
    const ca = createCA();
    expect(await pinOf(ca.certPem)).toBe(pinFingerprint(ca.certPem));
  });
});
