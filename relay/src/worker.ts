import { Room, limits, parseRoute, validToken, type Attachment, type Endpoint, type Limits, type Role } from './room.js';

// Minimal structural runtime types keep this standalone package independently typecheckable
// without importing Node or installing Cloudflare ambient types into the plugin.
interface Socket extends Endpoint {
  serializeAttachment(value: Attachment): void;
  deserializeAttachment(): Attachment | null;
}
interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(time: number): Promise<void>;
  deleteAll(): Promise<void>;
}
interface State {
  storage: Storage;
  getWebSockets(): Socket[];
  acceptWebSocket(socket: Socket, tags?: string[]): void;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
interface Stub { fetch(request: Request): Promise<Response> }
interface Namespace { idFromName(name: string): unknown; get(id: unknown): Stub }
interface Env {
  ROOMS: Namespace;
  /** REQUIRED deployment secret; host creation only. Never an invitation PSK. */
  CREATE_TOKEN: string;
  TTL_MS?: string; MAX_MESSAGE_BYTES?: string; MAX_BUFFERED_BYTES?: string;
}
declare const WebSocketPair: { new(): { 0: Socket; 1: Socket } };
function settings(env: Env): Limits {
  return limits({ ttlMs: Number(env.TTL_MS ?? 600000),
    maxMessageBytes: Number(env.MAX_MESSAGE_BYTES ?? 65536),
    maxBufferedBytes: Number(env.MAX_BUFFERED_BYTES ?? 262144) });
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = parseRoute(request.url);
    if (url.protocol !== 'https:') return new Response('HTTPS required', { status: 400 });
    if (!route || request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return new Response('Not found', { status: 404 });
    if (route.role === 'host' && (!validToken(route.token) || !env.CREATE_TOKEN ||
        url.searchParams.get('createToken') !== env.CREATE_TOKEN))
      return new Response('Unauthorized', { status: 401 });
    // Deployment ingress rate limits are mandatory: per-room DO limits cannot bound namespace cardinality.
    return env.ROOMS.get(env.ROOMS.idFromName(route.roomId)).fetch(request);
  },
};

export class RelayRoom {
  private room?: Room;
  private readonly config: Limits;
  private recovering = false;
  constructor(private readonly ctx: State, env: Env) {
    this.config = settings(env);
    void ctx.blockConcurrencyWhile(async () => {
      const meta = await ctx.storage.get<{ expiresAt: number }>('room');
      const sockets = ctx.getWebSockets();
      if (!meta || meta.expiresAt <= Date.now()) {
        for (const socket of sockets) socket.close(1008, 'Room expired');
        if (meta) await ctx.storage.deleteAll();
        return;
      }
      const room = this.makeRoom(meta.expiresAt);
      this.recovering = true;
      // Host first; attachments carry credit and rate counters, never payload or TLS secrets.
      const sorted = sockets.map(socket => ({ socket, state: socket.deserializeAttachment() }))
        .sort((a, b) => a.state?.role === 'host' ? -1 : b.state?.role === 'host' ? 1 : 0);
      try {
        for (const entry of sorted) {
          const state = entry.state;
          if (!state || !['host', 'guest'].includes(state.role) || state.expiresAt !== meta.expiresAt ||
              !Number.isSafeInteger(state.receiveCredit) || state.receiveCredit < 0 || state.receiveCredit > this.config.maxBufferedBytes ||
              !Number.isSafeInteger(state.sessionBytes) || state.sessionBytes < 0 || state.sessionBytes > this.config.maxSessionBytes)
            throw new Error('Invalid attachment');
          room.add(state.role, entry.socket, state);
        }
        if (!room.members.has('host')) throw new Error('Missing host');
      } catch {
        room.shutdown(1008, 'Invalid recovered room');
        for (const socket of sockets) { try { socket.close(1008, 'Invalid recovered room'); } catch {} }
      } finally { this.recovering = false; }
      await ctx.storage.setAlarm(meta.expiresAt);
    });
  }
  private makeRoom(expiresAt: number): Room {
    const room = new Room(this.config, expiresAt,
      member => (member.socket as Socket).serializeAttachment(member.state),
      () => { if (!this.recovering) this.room = undefined; });
    this.room = room; return room;
  }
  async fetch(request: Request): Promise<Response> {
    // Serialize the storage awaits with upgrades: two concurrent hosts cannot both reserve.
    return this.ctx.blockConcurrencyWhile(() => this.upgrade(request));
  }
  private async upgrade(request: Request): Promise<Response> {
    const route = parseRoute(request.url);
    if (!route) return new Response('Bad route', { status: 400 });
    let room = this.room;
    if (room && (room.closed || room.expiresAt <= Date.now())) {
      room.shutdown(1008, 'Room expired'); room = undefined;
    }
    // Persist a tombstone until TTL: no same-ID reconnect after disconnect/hibernation.
    const meta = await this.ctx.storage.get<{ expiresAt: number }>('room');
    if (route.role === 'host') {
      if (!validToken(route.token)) return new Response('Unauthorized', { status: 401 });
      if (room || (meta && meta.expiresAt > Date.now())) return new Response('Conflict', { status: 409 });
      room = this.makeRoom(Date.now() + this.config.ttlMs);
      await this.ctx.storage.put('room', { expiresAt: room.expiresAt });
      await this.ctx.storage.setAlarm(room.expiresAt);
    } else if (!room || !room.members.has('host')) return new Response('Host required', { status: 404 });
    else if (room.members.has('guest')) return new Response('Conflict', { status: 409 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [route.role]);
    try { room!.add(route.role, pair[1]); } catch { pair[1].close(1008, 'Pairing conflict'); }
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }
  webSocketMessage(socket: Socket, data: string | ArrayBuffer): void {
    const role = socket.deserializeAttachment()?.role;
    if (!role || this.room?.members.get(role)?.socket !== socket) { socket.close(1008, 'Unknown member'); return; }
    this.room.message(role, typeof data === 'string' ? data : new Uint8Array(data));
  }
  webSocketClose(socket: Socket, _code: number, _reason: string, _wasClean: boolean): void {
    const role = socket.deserializeAttachment()?.role;
    if (role && this.room?.members.get(role)?.socket === socket) this.room.shutdown();
  }
  webSocketError(socket: Socket, _error: unknown): void {
    const role = socket.deserializeAttachment()?.role;
    if (role && this.room?.members.get(role)?.socket === socket) this.room.shutdown(1011, 'Socket failed');
  }
  async alarm(): Promise<void> {
    this.room?.shutdown(1008, 'Room expired');
    for (const socket of this.ctx.getWebSockets()) { try { socket.close(1008, 'Room expired'); } catch {} }
    await this.ctx.storage.deleteAll();
  }
}
