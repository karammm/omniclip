// Which app is in front when something is copied, so copies made in apps the user excluded aren't sent.
import { execFile } from 'node:child_process';
import fs from 'node:fs';

function run(cmd: string, args: string[], timeout = 3000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout, windowsHide: true, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  );
}

const WIN_SCRIPT = `Add-Type @"
using System; using System.Runtime.InteropServices;
public static class OmniClipFront {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$id = 0; [void][OmniClipFront]::GetWindowThreadProcessId([OmniClipFront]::GetForegroundWindow(), [ref]$id)
$p = Get-Process -Id $id; $p.ProcessName; $p.Description`;

/**
 * Names of the front app: its display name on macOS, process name and description on Windows,
 * process and window class on Linux (X11 only). Empty when it can't be told.
 */
export async function frontAppNames(): Promise<string[]> {
  try {
    if (process.platform === 'darwin') {
      const asn = (await run('lsappinfo', ['front'])).trim();
      const info = await run('lsappinfo', ['info', '-only', 'name', asn]);
      const name = /"LSDisplayName"="([^"]*)"/.exec(info)?.[1] ?? /^"([^"]+)"/m.exec(info)?.[1];
      return name ? [name] : [];
    }
    if (process.platform === 'win32') {
      const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_SCRIPT], 5000);
      return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
    const [pid, cls] = await Promise.all([
      run('xdotool', ['getactivewindow', 'getwindowpid']).then((s) => s.trim()),
      run('xdotool', ['getactivewindow', 'getwindowclassname']).then((s) => s.trim(), () => ''),
    ]);
    const comm = /^\d+$/.test(pid) ? fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() : '';
    return [comm, cls].filter(Boolean);
  } catch {
    return [];
  }
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\.(exe|app)$/, '');
}

/** True when one of the front app's names is the excluded app ("1Password" also matches "1Password 7"). */
export function matchesApp(names: string[], rules: string[]): string | null {
  for (const rule of rules) {
    const r = norm(rule);
    if (r && names.some((n) => norm(n) === r || norm(n).startsWith(`${r} `))) return rule;
  }
  return null;
}
