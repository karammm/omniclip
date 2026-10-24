import { describe, expect, it } from 'vitest';
import { ClipSchema, PairRequestSchema, isDesktopPlatform, parseServerMessage } from '../src/index.js';

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
