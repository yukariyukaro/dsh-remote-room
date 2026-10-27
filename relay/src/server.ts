import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { Room, limits, parseRoute, validToken, type Limits } from './room.js';

export interface StartRelayOptions extends Partial<Limits> {
  host: '127.0.0.1' | '::1' | '0.0.0.0'; port: number;
  /** Required to bind a network address: this relay carries sealed TLS records, never plaintext content. */
  allowLan?: boolean;
  maxRooms?: number; maxCreatesPerMinute?: number; createToken?: string;
}
/** Local integration fixture/self-host backend. Terminate TLS at a trusted reverse proxy for production. */
export async function startRelay(options: StartRelayOptions): Promise<{ url: string; close(): Promise<void> }> {
  const loopback = options.host === '127.0.0.1' || options.host === '::1';
  if (!loopback && !(options.host === '0.0.0.0' && options.allowLan === true)) throw new Error('Plain WS server must bind loopback unless allowLan is set');
  const config = limits(options);
  const maxRooms = options.maxRooms ?? 256;
  const maxCreates = options.maxCreatesPerMinute ?? 32;
  if (!Number.isSafeInteger(maxRooms) || maxRooms < 1 || !Number.isSafeInteger(maxCreates) || maxCreates < 1)
    throw new Error('Invalid room limit');
  const rooms = new Map<string, Room>();
  // A global creation budget avoids an unbounded attacker-controlled IP map.
  let rateAt = Date.now(); let creates = 0;
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: Math.max(config.maxMessageBytes, 128), perMessageDeflate: false });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  server.on('upgrade', (request, socket, head) => {
    const reject = (status: number, reason: string) => { socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    const route = parseRoute(request.url ?? '');
    if (!route || request.headers.upgrade?.toLowerCase() !== 'websocket') { reject(400, 'Bad Request'); return; }
    let room = rooms.get(route.roomId);
    if (room && Date.now() >= room.expiresAt) { room.shutdown(1008, 'Room expired'); room = undefined; }
    if (route.role === 'host') {
      if (!validToken(route.token)) { reject(401, 'Unauthorized'); return; }
      if (options.createToken) {
        const actual = Buffer.from(new URL(request.url!, 'http://relay.invalid').searchParams.get('createToken') ?? '');
        const expected = Buffer.from(options.createToken);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { reject(401, 'Unauthorized'); return; }
      }
      if (room) { reject(409, 'Conflict'); return; }
      if (Date.now() - rateAt > 60_000) { rateAt = Date.now(); creates = 0; }
      if (rooms.size >= maxRooms || ++creates > maxCreates) { reject(429, 'Too Many Requests'); return; }
    } else if (!room || !room.members.has('host')) { reject(404, 'Not Found'); return; }
    else if (room.members.has('guest')) { reject(409, 'Conflict'); return; }
    // handleUpgrade's callback is synchronous: reservation and add cannot race another upgrade.
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (!room) {
        let timer: ReturnType<typeof setTimeout>;
        room = new Room(config, Date.now() + config.ttlMs, undefined, () => {
          rooms.delete(route.roomId); if (timer) { clearTimeout(timer); timers.delete(timer); }
        });
        rooms.set(route.roomId, room);
        const created = room;
        timer = setTimeout(() => created.shutdown(1008, 'Room expired'), config.ttlMs);
        timer.unref(); timers.add(timer);
      }
      const active = room;
      const endpoint = {
        get bufferedAmount() { return ws.bufferedAmount; },
        send(data: string | Uint8Array) { ws.send(data, { binary: typeof data !== 'string', compress: false }); },
        close(code: number, reason: string) {
          ws.close(code, reason);
          const timer = setTimeout(() => ws.terminate(), 250); timer.unref();
          ws.once('close', () => clearTimeout(timer));
        },
      };
      ws.on('error', () => active.shutdown(1011, 'Socket failed'));
      ws.on('close', () => active.shutdown());
      ws.on('message', (raw: RawData, binary: boolean) => {
        const data = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
        active.message(route.role, binary ? data : data.toString());
      });
      try { active.add(route.role, endpoint); } catch { ws.close(1008, 'Pairing conflict'); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing relay address');
  let closing: Promise<void> | undefined;
  return { url: `ws://${options.host === '::1' ? '[::1]' : options.host}:${address.port}`,
    close() {
      return closing ??= new Promise<void>((resolve, reject) => {
        for (const timer of timers) clearTimeout(timer);
        for (const room of [...rooms.values()]) room.shutdown(1001, 'Relay stopped');
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    } };
}
