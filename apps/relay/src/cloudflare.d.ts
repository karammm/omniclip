// The few Cloudflare Workers runtime types the relay uses (avoids a dependency on @cloudflare/workers-types).

interface CfWebSocket extends WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

declare class WebSocketPair {
  0: CfWebSocket;
  1: CfWebSocket;
}

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
  acceptWebSocket(ws: CfWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): CfWebSocket[];
}

interface DurableObjectId {}
interface DurableObjectStub {
  fetch(req: Request): Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface ResponseInit {
  webSocket?: CfWebSocket;
}
