import { describe, expect, it } from 'vitest';
import { ClipSchema, PairRequestSchema, detectSensitive, isDesktopPlatform, parseServerMessage } from '../src/index.js';

const clip = {
  id: '00000000-0000-0000-0000-000000000000',
  kind: 'text',
  text: 'hi',
  mime: 'text/plain',
  size: 2,
  hash: 'x',
  sourceDeviceId: 'd',
  sourceName: 'Mac',
  createdAt: 1,
};

describe('protocol', () => {
  it('validates clips', () => {
    expect(ClipSchema.safeParse(clip).success).toBe(true);
    expect(ClipSchema.safeParse({ ...clip, kind: 'video' }).success).toBe(false);
  });

  it('parses server messages and rejects garbage', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'clip:new', clip }))?.type).toBe('clip:new');
    expect(parseServerMessage(JSON.stringify({ type: 'nope' }))).toBeNull();
    expect(parseServerMessage('not json')).toBeNull();
  });

  it('validates pair requests', () => {
    expect(PairRequestSchema.safeParse({ code: '123456', name: 'iPhone', platform: 'ios' }).success).toBe(true);
    expect(PairRequestSchema.safeParse({ code: '1', name: 'iPhone', platform: 'ios' }).success).toBe(false);
  });

  it('knows desktop platforms', () => {
    expect(isDesktopPlatform('windows')).toBe(true);
    expect(isDesktopPlatform('android')).toBe(false);
  });
});

describe('detectSensitive', () => {
  it.each([
    ['482913', 'code'],
    ['482 913', 'code'],
    ['4111 1111 1111 1111', 'card'],
    ['4111-1111-1111-1111', 'card'],
    ['P@ssw0rd!', 'password'],
    ['Tr0ub4dor&3', 'password'],
    ['xK9#mP2$vL', 'password'],
    ['Hxkfo2-pidwyc-jemxuz', 'password'],
  ])('flags %s as %s', (text, kind) => {
    expect(detectSensitive(text)).toBe(kind);
  });

  it.each([
    'hello world',
    'https://example.com/a?b=1',
    'someone@example.com',
    '/Users/karam/file.txt',
    'C:\\Users\\karam',
    'getElementById',
    'my_var2',
    'Hello-World2',
    'v1.2.3-beta',
    'rgba(0,0,0,0.5)',
    '2026',
    '4111 1111 1111 1112',
    'Meet at 10:30 tomorrow',
  ])('leaves %s alone', (text) => {
    expect(detectSensitive(text)).toBeNull();
  });
});
