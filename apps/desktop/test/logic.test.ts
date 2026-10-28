import { describe, expect, it } from 'vitest';
import { matchesApp } from '../src/frontApp.js';
import { isNewer } from '../src/version.js';
import type { DiscoveredHub } from '@omniclip/hub';
import { EchoGuard } from '../src/echoGuard.js';
import { decideRole, shouldStepDown } from '../src/election.js';

const hub = (name: string, networkId: string, addresses = ['192.168.1.5']): DiscoveredHub => ({
  name,
  host: `${name}.local`,
  addresses,
  port: 7878,
  networkId,
  hubName: name,
});

describe('decideRole', () => {
  it('becomes the hub when nothing is on the LAN', () => {
    expect(decideRole([], [])).toEqual({ role: 'hub' });
  });

  it('joins a known network without a code', () => {
    const r = decideRole([hub('A', 'other'), hub('B', 'mine')], ['mine']);
    expect(r).toMatchObject({ role: 'client', paired: true, hub: { name: 'B' } });
  });

  it('offers to join an unknown hub', () => {
    expect(decideRole([hub('A', 'other')], ['mine'])).toMatchObject({ role: 'client', paired: false });
  });

  it('ignores hubs without usable addresses', () => {
    expect(decideRole([hub('A', 'mine', [])], ['mine'])).toEqual({ role: 'hub' });
  });
});

describe('shouldStepDown', () => {
  it('yields to a hub on the same network with a lower name', () => {
    expect(shouldStepDown([hub('OmniClip A', 'n'), hub('OmniClip B', 'n')], 'n', 'OmniClip B')?.name).toBe('OmniClip A');
    expect(shouldStepDown([hub('OmniClip A', 'n'), hub('OmniClip B', 'n')], 'n', 'OmniClip A')).toBeUndefined();
    expect(shouldStepDown([hub('OmniClip A', 'x')], 'n', 'OmniClip B')).toBeUndefined();
  });
});

describe('EchoGuard', () => {
  it('does not report what was already on the clipboard at startup', () => {
    const g = new EchoGuard();
    g.prime('t:a');
    expect(g.isLocalChange('t:a')).toBe(false);
    expect(g.isLocalChange('t:b')).toBe(true);
    expect(g.isLocalChange('t:b')).toBe(false);
  });

  it('suppresses the echo of remote content but sees the next local copy', () => {
    const g = new EchoGuard();
    g.prime(null);
    g.markApplied('t:remote');
    expect(g.isLocalChange('t:remote')).toBe(false);
    expect(g.isLocalChange('t:local')).toBe(true);
  });
});

describe('isNewer', () => {
  it('compares versions numerically', () => {
    expect(isNewer('v0.10.0', '0.9.2')).toBe(true);
    expect(isNewer('0.3.0', '0.3.0')).toBe(false);
    expect(isNewer('0.2.9', '0.3.0')).toBe(false);
    expect(isNewer('1.0', '0.99.99')).toBe(true);
  });
});

describe('matchesApp', () => {
  it('matches app names regardless of case, versions and .exe', () => {
    expect(matchesApp(['1Password 7'], ['1password'])).toBe('1password');
    expect(matchesApp(['KeePassXC.exe', 'KeePassXC'], ['KeePassXC'])).toBe('KeePassXC');
    expect(matchesApp(['Bitwarden'], ['1Password', 'Bitwarden'])).toBe('Bitwarden');
  });

  it("doesn't match other apps that merely contain the name", () => {
    expect(matchesApp(['Xcode'], ['Code'])).toBeNull();
    expect(matchesApp(['Passwords'], ['1Password'])).toBeNull();
    expect(matchesApp([], ['1Password'])).toBeNull();
    expect(matchesApp(['Safari'], [])).toBeNull();
  });
});
