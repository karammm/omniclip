import os from 'node:os';
import { Bonjour, type Service } from 'bonjour-service';
import { MDNS_TYPE } from '@omniclip/protocol';

export interface DiscoveredHub {
  name: string;
  host: string;
  addresses: string[];
  port: number;
  networkId: string;
  hubName: string;
}

let bonjour: Bonjour | null = null;
function instance(): Bonjour {
  return (bonjour ??= new Bonjour());
}

export function advertise(opts: { port: number; networkId: string; hubName: string }): () => void {
  const service = instance().publish({
    name: `OmniClip ${opts.hubName} ${opts.networkId.slice(0, 4)}`,
    type: MDNS_TYPE,
    port: opts.port,
    txt: { networkId: opts.networkId, hubName: opts.hubName, host: os.hostname() },
  });
  return () => service.stop?.();
}

function toHub(s: Service): DiscoveredHub | null {
  const txt = (s.txt ?? {}) as Record<string, string>;
  if (!txt.networkId) return null;
  const addresses = (s.addresses ?? []).filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  return { name: s.name, host: s.host, addresses, port: s.port, networkId: txt.networkId, hubName: txt.hubName ?? s.name };
}

/** Browses the LAN for OmniClip hubs for `timeoutMs` and returns everything found. */
export function discover(timeoutMs = 3000): Promise<DiscoveredHub[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredHub>();
    const browser = instance().find({ type: MDNS_TYPE }, (s) => {
      const hub = toHub(s);
      if (hub) found.set(hub.name, hub);
    });
    setTimeout(() => {
      browser.stop();
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

export function shutdownMdns(): Promise<void> {
  return new Promise((resolve) => {
    if (!bonjour) return resolve();
    bonjour.unpublishAll(() => {
      bonjour?.destroy();
      bonjour = null;
      resolve();
    });
  });
}
