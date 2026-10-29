import { describe, expect, it } from 'vitest';
import { expandSnippet, matchSnippets, normalizeKeyword } from '../src/index';

type PlainSnippet = { id: string; name: string; keyword: string; text: string; updatedAt: number };

const s = (id: string, name: string, keyword: string, text: string): PlainSnippet => ({ id, name, keyword, text, updatedAt: 0 });
const all = [s('1', 'Home address', 'addr', '1 Main St'), s('2', 'Signature', 'sig', 'Best, Karam'), s('3', 'Zoom link', 'zoom', 'https://zoom.us/j/1 address')];

describe('snippets', () => {
  it('normalizes keywords', () => {
    expect(normalizeKeyword(';;Addr!')).toBe('addr');
    expect(normalizeKeyword(undefined)).toBe('');
  });

  it('lists nothing until something is typed, everything for ";"', () => {
    expect(matchSnippets(all, '')).toEqual([]);
    expect(matchSnippets(all, ';').map((x) => x.id)).toEqual(['1', '2', '3']);
    expect(matchSnippets(all, ';si').map((x) => x.id)).toEqual(['2']);
  });

  it('ranks exact keywords, then names, then contents', () => {
    expect(matchSnippets(all, 'zoom').map((x) => x.id)).toEqual(['3']);
    expect(matchSnippets(all, 'addr').map((x) => x.id)).toEqual(['1', '3']);
    expect(matchSnippets(all, 'karam').map((x) => x.id)).toEqual(['2']);
  });

  it('fills placeholders and keeps escaped braces', () => {
    const now = new Date(2026, 9, 29, 9, 5);
    const out = expandSnippet('On {date} at {time}: {clipboard} {{literal}}', 'copied', now);
    expect(out).toBe(`On ${now.toLocaleDateString()} at ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: copied {literal}`);
    expect(expandSnippet('{unknown}', '')).toBe('{unknown}');
  });
});
