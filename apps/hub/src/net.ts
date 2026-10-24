import os from 'node:os';

function rank(ip: string): number {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  if (ip.startsWith('169.254.')) return 9;
  return 5;
}

/** Non-internal IPv4 addresses, most likely home-LAN address first. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return [...new Set(out)].sort((a, b) => rank(a) - rank(b));
}
