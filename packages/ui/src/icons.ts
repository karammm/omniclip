// One line-icon set for every OmniClip screen: 24×24, drawn with currentColor strokes.
// Values are the inner SVG markup; wrap them with iconSvg() (HTML strings) or <Icon> (Preact).

export const ICONS = {
  clipboard: '<rect x="8" y="2.5" width="8" height="4" rx="1.2"/><path d="M8 4.5H6.5A2.5 2.5 0 0 0 4 7v12a2.5 2.5 0 0 0 2.5 2.5h11A2.5 2.5 0 0 0 20 19V7a2.5 2.5 0 0 0-2.5-2.5H16"/>',
  send: '<path d="M20.5 3.5 10.6 13.4"/><path d="M20.5 3.5 14.3 20.6a.6.6 0 0 1-1.1 0l-2.6-7.2-7.2-2.6a.6.6 0 0 1 0-1.1z"/>',
  paperclip: '<path d="m20.5 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6A2.5 2.5 0 0 0 13 3.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  pin: '<path d="M12 16.5v5"/><path d="M8.6 3.5h6.8l-.9 5.6 3 3.6v1.8H6.5v-1.8l3-3.6z"/>',
  external: '<path d="M14 4h6v6"/><path d="m20 4-8.5 8.5"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  download: '<path d="M12 4v11"/><path d="m7 10.5 5 5 5-5"/><path d="M4.5 19.5h15"/>',
  share: '<path d="M12 14.5v-11"/><path d="M7.5 8 12 3.5 16.5 8"/><path d="M8.5 10.5h-2A2.5 2.5 0 0 0 4 13v5.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V13a2.5 2.5 0 0 0-2.5-2.5h-2"/>',
  sliders: '<path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
  laptop: '<rect x="4.5" y="5" width="15" height="10.5" rx="1.6"/><path d="M2.5 19h19"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6m-3-4v4"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7.5 9.5 3 2.5-3 2.5M13 15h3.5"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.6"/><path d="M11 18.5h2"/>',
  tablet: '<rect x="4.5" y="2.5" width="15" height="19" rx="2.6"/><path d="M11 18.5h2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.4 2.6 3.7 5.6 3.7 9s-1.3 6.4-3.7 9c-2.4-2.6-3.7-5.6-3.7-9S9.6 5.6 12 3z"/>',
  zap: '<path d="M13 2.5 4.8 13.2a.5.5 0 0 0 .4.8H12l-1 7.5 8.2-10.7a.5.5 0 0 0-.4-.8H12z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5v-3a3.5 3.5 0 0 1 7 0v3"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8a1.5 1.5 0 0 1 1.2.6l1.3 1.9h6.7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m20.5 15.5-4.6-4.6a1 1 0 0 0-1.4 0L6 19.5"/>',
  text: '<path d="M5 6.5V5h14v1.5M12 5v14m-2.5 0h5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  camera: '<path d="M4 8.5a2 2 0 0 1 2-2h1.8l1.5-2h5.4l1.5 2H18a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.5" r="3.3"/>',
  qr: '<rect x="4" y="4" width="6" height="6" rx="1.2"/><rect x="14" y="4" width="6" height="6" rx="1.2"/><rect x="4" y="14" width="6" height="6" rx="1.2"/><path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 20h1M20 14v1"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  devices: '<rect x="2.5" y="5" width="13" height="9.5" rx="1.6"/><path d="M1.5 18h11"/><rect x="16.5" y="8" width="5.5" height="11" rx="1.4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  filter: '<path d="M4 5h16l-6.2 7.4V19l-3.6-1.8v-4.8z"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M19.5 10A8 8 0 0 0 5 7.5L3.5 9.5"/><path d="M3.5 4.5v5h5"/><path d="M4.5 14A8 8 0 0 0 19 16.5l1.5-2"/><path d="M20.5 19.5v-5h-5"/>',
  pencil: '<path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  power: '<path d="M12 3v8"/><path d="M6.6 6.6a7.5 7.5 0 1 0 10.8 0"/>',
  wifi: '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.6 16a5 5 0 0 1 6.8 0"/><circle cx="12" cy="19.2" r=".6"/>',
  inbox: '<path d="M3.5 13.5 6 5.5h12l2.5 8V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M3.5 13.5h5l1 2h5l1-2h5"/>',
} as const;

export type IconName = keyof typeof ICONS;

/** The icon as an SVG string, for pages built from HTML strings. */
export function iconSvg(name: IconName, cls = ''): string {
  return `<svg class="i${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
}

/** Which icon stands for each kind of device. */
export const PLATFORM_ICON: Record<string, IconName> = {
  mac: 'laptop',
  windows: 'monitor',
  linux: 'terminal',
  ios: 'phone',
  ipados: 'tablet',
  android: 'phone',
  web: 'globe',
  shortcut: 'zap',
};

export function platformIcon(platform: string | undefined): IconName {
  return PLATFORM_ICON[platform ?? ''] ?? 'devices';
}
