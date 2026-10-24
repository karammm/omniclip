import type { DiscoveredHub } from '@omniclip/hub';

export type Role = { role: 'hub' } | { role: 'client'; hub: DiscoveredHub; paired: boolean };

/**
 * Decides whether this desktop should join an existing hub or become the hub.
 * Prefers a hub on a network we're already paired with; otherwise offers to join any
 * hub found (needs a pairing code); with no hub on the LAN, we become the hub.
 */
export function decideRole(found: DiscoveredHub[], knownNetworks: string[], ownNetworkId?: string): Role {
  const others = found.filter((h) => h.addresses.length > 0);
  const known = others.find((h) => knownNetworks.includes(h.networkId));
  if (known) return { role: 'client', hub: known, paired: true };
  const first = others[0];
  if (first && first.networkId !== ownNetworkId) return { role: 'client', hub: first, paired: false };
  return { role: 'hub' };
}

/**
 * Two desktops can take over at the same moment after the hub quits. When a hub sees
 * another hub for the same network, the one with the greater name steps down.
 */
export function shouldStepDown(found: DiscoveredHub[], networkId: string, ownName: string): DiscoveredHub | undefined {
  return found.find((h) => h.networkId === networkId && h.name !== ownName && h.name < ownName && h.addresses.length > 0);
}
