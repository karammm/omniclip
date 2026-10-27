import { describe, expect, it } from 'vitest';
import { renderPairPage } from '../src/pairPage.js';
import { renderPickerPage } from '../src/pickerPage.js';
import { renderSettingsPage } from '../src/settingsPage.js';

// The pages are built from template strings, where an escape like \' silently changes the generated script.
function scripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
}

describe('window pages', () => {
  it.each([
    ['settings', renderSettingsPage()],
    ['picker', renderPickerPage()],
    ['pair', renderPairPage({ mode: 'join', hubName: 'Mac' })],
  ])('%s page script parses', (_name, html) => {
    for (const src of scripts(html)) expect(() => new Function(src)).not.toThrow();
  });
});
