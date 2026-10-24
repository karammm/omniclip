import { z } from 'zod';

export const HUB_PORT_TLS = 7878;
export const HUB_PORT_HTTP = 7879;
export const MDNS_TYPE = 'omniclip';
export const PROTOCOL_VERSION = 1;

export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const HISTORY_LIMIT = 200;
export const BLOB_BUDGET_BYTES = 1024 * 1024 * 1024;

export const PlatformSchema = z.enum(['mac', 'windows', 'linux', 'ios', 'ipados', 'android', 'web', 'shortcut']);
export type Platform = z.infer<typeof PlatformSchema>;

export const ClipKindSchema = z.enum(['text', 'image', 'file']);
export type ClipKind = z.infer<typeof ClipKindSchema>;

export const ClipSchema = z.object({
  id: z.string(),
  kind: ClipKindSchema,
  /** Inline content for text clips. */
  text: z.string().optional(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  /** Original filename for file/image clips. */
  name: z.string().optional(),
  /** sha256 of the content; used by desktops to avoid echo loops. */
  hash: z.string(),
  sourceDeviceId: z.string(),
  sourceName: z.string(),
  createdAt: z.number(),
});
export type Clip = z.infer<typeof ClipSchema>;

export const DeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: PlatformSchema,
  createdAt: z.number(),
  lastSeen: z.number(),
  online: z.boolean().optional(),
});
export type Device = z.infer<typeof DeviceSchema>;

/** Device record as stored by the hub (and replicated to desktop peers for failover). */
export const DeviceRecordSchema = DeviceSchema.omit({ online: true }).extend({
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
});

// ---- WebSocket (server -> client) ----

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    deviceId: z.string(),
    networkId: z.string(),
    hubDeviceId: z.string(),
    history: z.array(ClipSchema),
    devices: z.array(DeviceSchema),
  }),
  z.object({ type: z.literal('clip:new'), clip: ClipSchema }),
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
