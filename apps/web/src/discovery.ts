// Finding the hub again after it moved (failover to another desktop, or a new IP address).
import { hubUrls, probeHub } from './api';

async function firstMatch(hosts: string[], networkId: string, timeoutMs: number): Promise<string | null> {
  if (!hosts.length) return null;
  try {
    return await Promise.any(
      hosts.map(async (host) => {
        if ((await probeHub(hubUrls(host).http, timeoutMs)) === networkId) return host;
        throw new Error('no');
      }),
    );
  } catch {
    return null;
  }
}

/**
 * Looks for the hub of `networkId`: first at the known desktop addresses, then across the
 * current /24 subnet. Only the active hub answers on its HTTP port, so the first match wins.
 */
export async function findHub(networkId: string, current: string, candidates: string[], cancelled: () => boolean): Promise<string | null> {
  const known = [...new Set([current, ...candidates])];
  const hit = await firstMatch(known, networkId, 2500);
  if (hit || cancelled()) return hit;

  const m = /^(\d+\.\d+\.\d+)\.\d+$/.exec(current);
  if (!m) return null;
  const rest = Array.from({ length: 254 }, (_, i) => `${m[1]}.${i + 1}`).filter((h) => !known.includes(h));
  for (let i = 0; i < rest.length; i += 64) {
    if (cancelled()) return null;
    const found = await firstMatch(rest.slice(i, i + 64), networkId, 1500);
    if (found) return found;
  }
  return null;
}
