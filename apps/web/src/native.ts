// Native (Capacitor) bridges for the Android and iOS apps. Only loaded in `--mode native` builds.
import { App } from '@capacitor/app';
import { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { Browser } from '@capacitor/browser';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { Clipboard } from '@capacitor/clipboard';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type { ClipboardContent } from './clipboard';

export const platform = Capacitor.getPlatform() as 'ios' | 'android' | 'web';

export async function scanQr(): Promise<string | null> {
  const res = await CapacitorBarcodeScanner.scanBarcode({ hint: CapacitorBarcodeScannerTypeHint.QR_CODE });
  return res.ScanResult || null;
}

export async function writeText(text: string): Promise<void> {
  await Clipboard.write({ string: text });
}

export async function writeImage(dataUrl: string): Promise<void> {
  if (platform === 'android') {
    // the Capacitor plugin would paste the data URL as text on Android
    const [head, data = ''] = dataUrl.split(',');
    await OmniClip.copyImage({ data, mime: /data:([^;]+)/.exec(head!)?.[1] ?? 'image/png' });
    return;
  }
  await Clipboard.write({ image: dataUrl });
}

export async function read(): Promise<ClipboardContent> {
  const { type, value } = await Clipboard.read();
  // Android reports copied images and files as content:// URIs we can't read; ignore them
  if (!value || /^content:\/\//.test(value)) return null;
  if (type.startsWith('image/') || value.startsWith('data:image/')) {
    const blob = await (await fetch(value)).blob();
    return { kind: 'image', blob };
  }
  return { kind: 'text', text: value };
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Saves a clip's file to the app cache and opens the system share sheet (Save to Files, Photos, other apps…). */
export async function shareFile(url: string, name: string): Promise<void> {
  const blob = await (await fetch(url)).blob();
  const safe = name.replace(/[\\/:*?"<>|]/g, '_') || 'file';
  const { uri } = await Filesystem.writeFile({ path: safe, data: await toBase64(blob), directory: Directory.Cache });
  await Share.share({ files: [uri] });
}

export async function openUrl(url: string): Promise<void> {
  await Browser.open({ url });
}

/** `omniclip://pair?hub=192.168.1.5&code=123456` links open the app straight into pairing. */
export async function pairLinks(fn: (url: string) => void): Promise<() => void> {
  // Android reports a link that launched the app both as the launch URL and as an appUrlOpen event
  let last = '';
  const once = (url: string) => {
    if (url && url !== last) fn((last = url));
  };
  const handle = await App.addListener('appUrlOpen', (e) => once(e.url));
  const launch = await App.getLaunchUrl();
  if (launch?.url) once(launch.url);
  return () => void handle.remove();
}

export function onResume(fn: () => void): () => void {
  const handle = App.addListener('resume', fn);
  return () => void handle.then((h) => h.remove());
}

export type SharedItem = { kind: 'text'; text: string } | { kind: 'file'; name: string; mime: string; data: string };

interface OmniClipPlugin {
  trustCa(opts: { pem: string }): Promise<void>;
  take(): Promise<{ items: SharedItem[] }>;
  copyImage(opts: { data: string; mime: string }): Promise<void>;
  addListener(event: 'shared', fn: () => void): Promise<PluginListenerHandle>;
}

// App-local plugin (OmniClipPlugin.java / OmniClipPlugin.swift). trustCa works on both platforms;
// the share inbox and image copy are Android only.
const OmniClip = registerPlugin<OmniClipPlugin>('OmniClip');

/** Pins the network's CA so HTTPS and WebSocket connections to the hub are accepted. */
export async function trustCa(pem: string): Promise<void> {
  await OmniClip.trustCa({ pem });
}

export async function takeShared(): Promise<SharedItem[]> {
  if (platform !== 'android') return [];
  return (await OmniClip.take()).items;
}

export function onShared(fn: () => void): () => void {
  if (platform !== 'android') return () => {};
  const handle = OmniClip.addListener('shared', fn);
  return () => void handle.then((h) => h.remove());
}
