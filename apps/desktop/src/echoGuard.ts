/**
 * Tracks the fingerprint of what's currently on the local clipboard so the watcher only
 * reports real changes, and never re-sends content that just arrived from another device.
 */
export class EchoGuard {
  private current: string | null = null;

  /** Call right after writing remote content to the clipboard (with the read-back fingerprint). */
  markApplied(fingerprint: string): void {
    this.current = fingerprint;
  }

  /** Returns true when the clipboard changed because the user copied something new. */
  isLocalChange(fingerprint: string): boolean {
    if (fingerprint === this.current) return false;
    this.current = fingerprint;
    return true;
  }

  /** Seeds the guard at startup so whatever was already on the clipboard isn't broadcast. */
  prime(fingerprint: string | null): void {
    this.current = fingerprint;
  }
}
