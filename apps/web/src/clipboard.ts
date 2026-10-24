// Clipboard helpers that work in the secure (HTTPS) app and degrade gracefully in basic (HTTP) mode.
// The native app uses the system clipboard through Capacitor instead.
import { NATIVE } from './api';

// inline MODE check so the browser build drops the native chunk entirely
const native = () => (import.meta.env.MODE === 'native' ? import('./native') : Promise.reject(new Error('native only')));

/** In the native app the hub is reached over the LAN, but the clipboard is the OS one, so it counts as secure. */
export const secure = NATIVE || window.isSecureContext;
export const canReadClipboard = NATIVE || (secure && !!navigator.clipboard?.read);
export const canCopyImages = NATIVE || (secure && typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write);

function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.fontSize = '16px'; // stops iOS from zooming
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length); // iOS ignores select()
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } finally {
    ta.remove();
  }
  return ok;
}

export async function copyText(text: string): Promise<boolean> {
  if (NATIVE) {
    try {
      await (await native()).writeText(text);
      return true;
    } catch {
      return false;
    }
  }
  if (secure && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to execCommand
    }
  }
  return legacyCopy(text);
}

async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png'));
}

/**
 * Safari only allows clipboard writes synchronously inside the tap handler, so the
 * ClipboardItem is created immediately with a promise for the (fetched) image data.
 */
export async function copyImage(url: string): Promise<boolean> {
  if (NATIVE) {
    try {
      const blob = await (await fetch(url)).blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
      await (await native()).writeImage(dataUrl);
      return true;
    } catch {
      return false;
    }
  }
  if (!canCopyImages) return false;
  const png = fetch(url)
    .then((r) => r.blob())
    .then(toPng);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return true;
  } catch {
    return false;
  }
}

export type ClipboardContent = { kind: 'text'; text: string } | { kind: 'image'; blob: Blob } | null;

export async function readClipboard(): Promise<ClipboardContent> {
  if (NATIVE) return (await native()).read();
  if (!secure) return null;
  if (navigator.clipboard?.read) {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find((t) => t.startsWith('image/'));
      if (imageType) return { kind: 'image', blob: await item.getType(imageType) };
      if (item.types.includes('text/plain')) {
        const text = await (await item.getType('text/plain')).text();
        if (text) return { kind: 'text', text };
      }
    }
    return null;
  }
  const text = await navigator.clipboard?.readText?.();
  return text ? { kind: 'text', text } : null;
}
