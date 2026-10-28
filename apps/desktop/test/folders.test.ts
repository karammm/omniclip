import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { FolderError, unzipFolder, zipFolder } from '../src/folders.js';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'omniclip-folders-'));
  dirs.push(d);
  return d;
}
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function makeFolder(): string {
  const root = path.join(tmp(), 'Trip photos');
  fs.mkdirSync(path.join(root, 'day 1', 'raw'), { recursive: true });
  fs.mkdirSync(path.join(root, 'empty'));
  fs.writeFileSync(path.join(root, 'notes.txt'), 'packing list '.repeat(100));
  fs.writeFileSync(path.join(root, 'day 1', 'beach.jpg'), Buffer.from([0xff, 0xd8, 1, 2, 3]));
  fs.writeFileSync(path.join(root, '.DS_Store'), 'junk');
  return root;
}

describe('folders', () => {
  it('zips a folder and unpacks it into a new folder with the same contents', async () => {
    const zipped = await zipFolder(makeFolder(), 10 * 1024 * 1024);
    expect(zipped.name).toBe('Trip photos');
    expect(zipped.files).toBe(2);

    const out = tmp();
    const dest = await unzipFolder(zipped.data, out, 'fallback');
    expect(dest).toBe(path.join(out, 'Trip photos'));
    expect(fs.readFileSync(path.join(dest, 'notes.txt'), 'utf8')).toBe('packing list '.repeat(100));
    expect([...fs.readFileSync(path.join(dest, 'day 1', 'beach.jpg'))]).toEqual([0xff, 0xd8, 1, 2, 3]);
    expect(fs.existsSync(path.join(dest, '.DS_Store'))).toBe(false);
    expect(fs.statSync(path.join(dest, 'empty')).isDirectory()).toBe(true);

    // a second copy doesn't overwrite the first
    expect(await unzipFolder(zipped.data, out, 'fallback')).toBe(path.join(out, 'Trip photos (2)'));
  });

  it('refuses folders over the size limit', async () => {
    await expect(zipFolder(makeFolder(), 100)).rejects.toBeInstanceOf(FolderError);
  });

  it('uses the fallback name for zips without a single top folder', async () => {
    const data = Buffer.from(zipSync({ 'a.txt': new TextEncoder().encode('a'), 'b.txt': new TextEncoder().encode('b') }));
    const dest = await unzipFolder(data, tmp(), 'Shared');
    expect(path.basename(dest)).toBe('Shared');
    expect(fs.readFileSync(path.join(dest, 'b.txt'), 'utf8')).toBe('b');
  });

  it('rejects entries that would escape the destination', async () => {
    const data = Buffer.from(zipSync({ 'x/../../evil.txt': new TextEncoder().encode('no') }));
    const out = tmp();
    await expect(unzipFolder(data, out, 'x')).rejects.toBeInstanceOf(FolderError);
    expect(fs.existsSync(path.join(out, '..', 'evil.txt'))).toBe(false);
  });
});
