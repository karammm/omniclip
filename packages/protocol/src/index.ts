import { z } from 'zod';

export const HUB_PORT_TLS = 7878;
export const HUB_PORT_HTTP = 7879;
export const MDNS_TYPE = 'omniclip';
export const PROTOCOL_VERSION = 1;

export const MAX_TEXT_BYTES = 1024 * 1024;
/** Formatting (HTML or RTF) bigger than this is dropped and the plain text is sent alone. */
export const MAX_RICH_BYTES = 2 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const HISTORY_LIMIT = 200;
export const BLOB_BUDGET_BYTES = 1024 * 1024 * 1024;
/** Passwords and codes live this long, then the hub deletes them everywhere. */
export const SENSITIVE_TTL_MS = 60_000;

export const PlatformSchema = z.enum(['mac', 'windows', 'linux', 'ios', 'ipados', 'android', 'web', 'shortcut']);
export type Platform = z.infer<typeof PlatformSchema>;

export const ClipKindSchema = z.enum(['text', 'image', 'file']);
export type ClipKind = z.infer<typeof ClipKindSchema>;

export const ClipSchema = z.object({
  id: z.string(),
  kind: ClipKindSchema,
  /** Inline content for text clips. */
  text: z.string().optional(),
  /** Formatting copied along with the text, so it pastes with fonts and links on other computers. */
  html: z.string().optional(),
  rtf: z.string().optional(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  /** Original filename for file/image clips. */
  name: z.string().optional(),
  /** A zipped folder: computers unpack it, phones get the .zip. */
  folder: z.boolean().optional(),
  /** sha256 of the content; used by desktops to avoid echo loops. */
  hash: z.string(),
  sourceDeviceId: z.string(),
  sourceName: z.string(),
  createdAt: z.number(),
  /** Pinned clips are kept at the top and never pruned. */
  pinned: z.boolean().optional(),
  /** Sent to one device only (the sender sees it too). */
  targetDeviceId: z.string().optional(),
  targetName: z.string().optional(),
  /** Looks like a password, code or card number: never written to disk, deleted at `expiresAt`. */
  sensitive: z.boolean().optional(),
  expiresAt: z.number().optional(),
});
export type Clip = z.infer<typeof ClipSchema>;

export const DeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: PlatformSchema,
  createdAt: z.number(),
  lastSeen: z.number(),
  online: z.boolean().optional(),
  /** LAN addresses of online desktops: where phones look for a new hub after a failover. */
  addresses: z.array(z.string()).optional(),
});
export type Device = z.infer<typeof DeviceSchema>;

/** Device record as stored by the hub (and replicated to desktop peers for failover). */
export const DeviceRecordSchema = DeviceSchema.omit({ online: true, addresses: true }).extend({
  tokenHash: z.string(),
});
export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;

export const RegistrySchema = z.object({
  networkId: z.string(),
  devices: z.array(DeviceRecordSchema),
  ca: z.object({ certPem: z.string(), keyPem: z.string() }),
});
export type Registry = z.infer<typeof RegistrySchema>;

// ---- REST ----

export const PairRequestSchema = z.object({
  code: z.string().min(4).max(16),
  name: z.string().min(1).max(64),
  platform: PlatformSchema,
});
export type PairRequest = z.infer<typeof PairRequestSchema>;

export const PairResponseSchema = z.object({
  token: z.string(),
  deviceId: z.string(),
  networkId: z.string(),
  caPem: z.string(),
});
export type PairResponse = z.infer<typeof PairResponseSchema>;

export const TextClipRequestSchema = z.object({
  text: z.string().min(1),
  html: z.string().optional(),
  rtf: z.string().optional(),
});

export const PinRequestSchema = z.object({ pinned: z.boolean() });

export const RenameRequestSchema = z.object({ name: z.string().trim().min(1).max(64) });

// ---- WebSocket (server -> client) ----

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    deviceId: z.string(),
    networkId: z.string(),
    hubDeviceId: z.string(),
    history: z.array(ClipSchema),
    /** Pinned clips, which may be older than `history` reaches. */
    pinned: z.array(ClipSchema).optional(),
    devices: z.array(DeviceSchema),
  }),
  z.object({ type: z.literal('clip:new'), clip: ClipSchema }),
  /** A clip changed (pinned or unpinned). */
  z.object({ type: z.literal('clip:update'), clip: ClipSchema }),
  /** A clip was deleted (a password or code that expired). */
  z.object({ type: z.literal('clip:remove'), id: z.string() }),
  z.object({ type: z.literal('devices'), devices: z.array(DeviceSchema) }),
  /** Sent only to desktop devices so another desktop can take over as hub. */
  z.object({ type: z.literal('registry'), registry: RegistrySchema }),
  z.object({ type: z.literal('revoked') }),
  z.object({ type: z.literal('pong') }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export const ClientMessageSchema = z.discriminatedUnion('type', [z.object({ type: z.literal('ping') })]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export function isDesktopPlatform(p: Platform): boolean {
  return p === 'mac' || p === 'windows' || p === 'linux';
}

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const result = ServerMessageSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export type SensitiveKind = 'code' | 'card' | 'password';

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1 && (d *= 2) > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Best-effort guess at whether copied text is a secret: a one-time code, a card number or a
 * password. It errs towards ordinary text; password managers also mark their copies explicitly.
 */
export function detectSensitive(text: string): SensitiveKind | null {
  const t = text.trim();
  if (!t || t.length > 64) return null;
  if (/^(\d{6,8}|\d{3}[- ]\d{3})$/.test(t)) return 'code';
  if (/^[\d -]+$/.test(t)) {
    const digits = t.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? 'card' : null;
  }
  if (t.length < 8 || /\s/.test(t)) return null;
  // links, e-mail addresses, paths and code like rgba(0,0,0,.5)
  if (/^[a-z][a-z0-9+.-]*:|^www\.|^[~./\\$]|[/\\]|^\w+\(.*\)$/i.test(t) || /^[^@]+@[^@]+\.[a-z]{2,}$/i.test(t)) return null;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(t)).length;
  // identifiers and versions (my_var2, Hello-World2, v1.2.3-beta) mix character kinds too
  const identifier = /^[A-Za-z][A-Za-z0-9]*([_.-][A-Za-z0-9]+)*$/.test(t);
  if (classes === 4 && (!identifier || t.length >= 16)) return 'password';
  if (classes === 3 && !identifier) return 'password';
  return null;
}
