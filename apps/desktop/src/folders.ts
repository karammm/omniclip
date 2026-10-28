// Folders travel as zip files: the sender zips the folder, computers unpack it on arrival, phones keep the .zip.
import fs from 'node:fs';
import path from 'node:path';
import { unzip, zip, type AsyncZippable, type Unzipped } from 'fflate';

const SKIP = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
/** Already-compressed formats are stored as-is; squeezing them again only costs time. */
const STORED = /\.(zip|gz|tgz|bz2|xz|7z|rar|jpe?g|png|gif|webp|heic|mp4|mov|m4v|mkv|mp3|m4a|aac|ogg|pdf|docx|xlsx|pptx)$/i;

export interface ZippedFolder {
  data: Buffer;
  name: string;
  files: number;
}

export class FolderError extends Error {}

/** Counts the files and bytes in a folder (symlinks are skipped), stopping once over either limit. */
export function measureFolder(dir: string, maxBytes: number, maxFiles: number): { files: number; bytes: number; tooBig: boolean } {
  let files = 0;
  let bytes = 0;
  const walk = (d: string): boolean => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!walk(p)) return false;
      } else if (e.isFile()) {
        files++;
        bytes += fs.statSync(p).size;
        if (bytes > maxBytes || files > maxFiles) return false;
      }
    }
    return true;
  };
  const ok = walk(dir);
  return { files, bytes, tooBig: !ok };
}

/** Zips a folder, keeping the folder itself as the top entry (`Photos/…`), like Finder and Explorer do. */
export async function zipFolder(dir: string, maxBytes: number, maxFiles = 10_000): Promise<ZippedFolder> {
  const name = path.basename(path.resolve(dir));
  const size = measureFolder(dir, maxBytes, maxFiles);
  if (size.tooBig) throw new FolderError(`${name} is too big to send (over ${Math.round(maxBytes / 1048576)} MB or ${maxFiles} files). Zip it yourself and use "Send file…".`);
  const build = (d: string): AsyncZippable => {
    const out: AsyncZippable = {};
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) out[e.name] = build(p);
      else if (e.isFile()) out[e.name] = [fs.readFileSync(p), { level: STORED.test(e.name) ? 0 : 6 }];
    }
    return out;
  };
  const tree = { [name]: build(dir) };
  const data = await new Promise<Uint8Array>((resolve, reject) => zip(tree, (err, out) => (err ? reject(err) : resolve(out))));
  return { data: Buffer.from(data.buffer, data.byteOffset, data.byteLength), name, files: size.files };
}

/** Entry names that would land outside the destination (zip slip) or are otherwise unusable. */
function safeParts(entry: string): string[] | null {
  const parts = entry.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  if (!parts.length || entry.startsWith('/') || /^[a-z]:/i.test(entry)) return null;
  if (parts.some((p) => p === '..' || /[\u0000-\u001f<>:"|?*]/.test(p))) return null;
  return parts;
}

/**
 * Unpacks a zipped folder into `parentDir`, under a new folder named after the zip's single top folder
 * (or `fallbackName`). The folder name gets " (2)", " (3)"… if it already exists. Returns its path.
 */
export async function unzipFolder(data: Buffer, parentDir: string, fallbackName: string): Promise<string> {
  const entries = await new Promise<Unzipped>((resolve, reject) => unzip(new Uint8Array(data), (err, out) => (err ? reject(err) : resolve(out))));
  const files: Array<{ parts: string[]; dir: boolean; data: Uint8Array }> = [];
  for (const [entry, content] of Object.entries(entries)) {
    if (entry.startsWith('__MACOSX/')) continue;
    const parts = safeParts(entry);
    if (!parts) throw new FolderError(`The folder contains an unsafe path: ${entry}`);
    files.push({ parts, dir: entry.endsWith('/'), data: content });
  }
  // strip the shared top folder, if there is one, and use its name
  const top = files[0]?.parts[0];
  const shared = top !== undefined && files.every((f) => f.parts[0] === top && (f.parts.length > 1 || f.dir));
  const base = (shared ? top : fallbackName).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'Folder';
  let dest = path.join(parentDir, base);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(parentDir, `${base} (${i})`);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of files) {
    const rel = shared ? f.parts.slice(1) : f.parts;
    if (!rel.length) continue;
    const target = path.join(dest, ...rel);
    if (f.dir) fs.mkdirSync(target, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.data);
    }
  }
  return dest;
}
