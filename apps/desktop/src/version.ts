/** Compares dotted versions numerically: 0.10.0 > 0.9.2. */
export function isNewer(candidate: string, current: string): boolean {
  const a = candidate.replace(/^v/, '').split('.').map(Number);
  const b = current.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}
