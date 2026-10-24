import { describe, expect, it } from 'vitest';
import { parseHubInput } from '../src/api';

describe('parseHubInput', () => {
  it('reads the desktop QR link', () => {
    expect(parseHubInput('http://192.168.1.5:7879/setup#pair=123456')).toEqual({ hub: 'http://192.168.1.5:7879', code: '123456' });
  });

  it('switches the HTTPS link to the plain-HTTP port', () => {
    expect(parseHubInput('https://192.168.1.5:7878/#pair=654321')).toEqual({ hub: 'http://192.168.1.5:7879', code: '654321' });
  });

  it('accepts a bare address', () => {
    expect(parseHubInput(' 10.0.0.7 ')).toEqual({ hub: 'http://10.0.0.7:7879', code: undefined });
  });

  it('reads omniclip:// pairing links', () => {
    expect(parseHubInput('omniclip://pair?hub=192.168.1.5&code=111222')).toEqual({ hub: 'http://192.168.1.5:7879', code: '111222' });
  });

  it('rejects junk', () => {
    expect(parseHubInput('')).toBeNull();
    expect(parseHubInput('omniclip://pair')).toBeNull();
  });
});
