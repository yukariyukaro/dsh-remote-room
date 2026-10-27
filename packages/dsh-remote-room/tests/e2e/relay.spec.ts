import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { type Duplex } from 'node:stream';
import WebSocket from 'ws';
import { connectRelay } from '../../src/wire/websocket.js';
import { startRelay } from '../../relay/src/server.js';
import { RelayRoom } from '../../relay/src/worker.js';
import { type Attachment } from '../../relay/src/room.js';

const roomId = () => randomBytes(24).toString('base64url');
const hostToken = () => randomBytes(32).toString('base64url');
const resources: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });
async function relay(options: Partial<Parameters<typeof startRelay>[0]> = {}) {
  const server = await startRelay({ host: '127.0.0.1', port: 0, ...options });
  resources.push(() => server.close()); return server;
}
async function adapter(url: string, id: string, role: 'host' | 'guest', options = {}) {
  const stream = await connectRelay(url, id, role, { allowInsecureLoopback: true,
    hostToken: role === 'host' ? hostToken() : undefined, ...options });
  stream.on('error', () => {});
  resources.push(() => { stream.destroy(); }); return stream;
}
async function raw(url: string, id: string, role: 'host' | 'guest') {
  const socket = new WebSocket(`${url}/v1/rooms/${id}/${role}${role === 'host' ? `?hostToken=${hostToken()}` : ''}`);
  resources.push(() => socket.terminate());
  socket.on('error', () => {});
  await once(socket, 'open'); return socket;
}
function bytes(stream: Duplex, size: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const data: Buffer[] = []; let total = 0;
    const onData = (chunk: Buffer) => { data.push(chunk); total += chunk.length; if (total >= size) { cleanup(); resolve(Buffer.concat(data)); } };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => { stream.off('data', onData); stream.off('error', onError); };
    stream.on('data', onData); stream.once('error', onError);
  });
}
describe('real WebSocket relay and bounded Duplex', () => {
  it('pairs two outbound sockets, waits for guest credit, and transfers exact bidirectional bytes', async () => {
    const { url } = await relay(); const id = roomId();
    const host = await adapter(url, id, 'host');
    const payload = randomBytes(128 * 1024);
    let completed = false;
    host.write(payload, () => { completed = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(completed).toBe(false);
    const guest = await adapter(url, id, 'guest');
    expect(await bytes(guest, payload.length)).toEqual(payload);
    const response = randomBytes(1024);
    const received = bytes(host, response.length); guest.write(response);
    expect(await received).toEqual(response);
  });
  it('rejects missing host, duplicate host/guest, and missing host token', async () => {
    const { url } = await relay(); const id = roomId();
    await expect(adapter(url, id, 'guest')).rejects.toThrow();
    await expect(connectRelay(url, id, 'host', { allowInsecureLoopback: true })).rejects.toThrow('hostToken');
    await adapter(url, id, 'host');
    await expect(adapter(url, id, 'host')).rejects.toThrow();
    await adapter(url, id, 'guest');
    await expect(adapter(url, id, 'guest')).rejects.toThrow();
  });
  it('disconnects peer and cleans room after close', async () => {
    const { url } = await relay(); const id = roomId();
    const host = await adapter(url, id, 'host'); const guest = await adapter(url, id, 'guest');
    const closed = new Promise<void>(resolve => guest.once('close', resolve));
    host.destroy(); await closed;
    await expect(adapter(url, id, 'guest')).rejects.toThrow();
    await adapter(url, id, 'host');
  });
  it('rejects oversized binary messages at parser boundary', async () => {
    const { url } = await relay({ maxMessageBytes: 1024 }); const id = roomId();
    const host = await raw(url, id, 'host');
    const closed = once(host, 'close'); host.send(Buffer.alloc(1025));
    expect((await closed)[0]).toBe(1009);
  });
  it('rejects binary without receiver credit (no unbounded prepair queue)', async () => {
    const { url } = await relay(); const id = roomId(); const host = await raw(url, id, 'host');
    const closed = once(host, 'close'); host.send(Buffer.from('not paired'));
    expect((await closed)[0]).toBe(1008);
  });
  it('bounds unread receiver and resumes with consumption feedback', async () => {
    const { url } = await relay({ maxMessageBytes: 512, maxBufferedBytes: 2048 }); const id = roomId();
    const host = await adapter(url, id, 'host', { maxQueueBytes: 8192 });
    const guest = await adapter(url, id, 'guest', { maxQueueBytes: 2048 });
    const payload = randomBytes(4096); let written = false;
    host.write(payload, () => { written = true; });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(guest.readableLength).toBeGreaterThan(0);
    expect(guest.readableLength).toBeLessThanOrEqual(2048); expect(written).toBe(false);
    expect(await bytes(guest, payload.length)).toEqual(payload);
  });
  it('enforces hard writable bounds when caller ignores backpressure', async () => {
    const { url } = await relay(); const host = await adapter(url, roomId(), 'host', { maxQueueBytes: 1024 });
    const closed = new Promise<void>(resolve => host.once('close', resolve));
    host.write(Buffer.alloc(1025)); await closed; expect(host.destroyed).toBe(true);
  });
  it('expires waiting rooms and cleans aborted adapters', async () => {
    const { url } = await relay({ ttlMs: 100 }); const id = roomId();
    const host = await adapter(url, id, 'host');
    await new Promise<void>(resolve => host.once('close', resolve)); expect(host.destroyed).toBe(true);
    const controller = new AbortController();
    const next = await adapter(url, roomId(), 'host', { signal: controller.signal });
    const closed = new Promise<void>(resolve => next.once('close', resolve)); controller.abort(); await closed;
    expect(next.destroyed).toBe(true);
  });
  it('bounds total session traffic even when a peer advertises fresh credit', async () => {
    const { url } = await relay({ maxSessionBytes: 256 }); const id = roomId();
    const host = await raw(url, id, 'host'); const guest = await raw(url, id, 'guest');
    const closed = once(host, 'close');
    guest.send(JSON.stringify({ type: 'credit', bytes: 1024 }));
    await new Promise(resolve => setTimeout(resolve, 10));
    host.send(Buffer.alloc(257));
    expect((await closed)[0]).toBe(1008);
  });
  it('restores DO attachments and credit after hibernation; alarm clears sockets and storage', async () => {
    const expiresAt = Date.now() + 30_000;
    function socket(role: 'host' | 'guest') {
      let attachment: Attachment = { role, expiresAt, receiveCredit: role === 'guest' ? 128 : 0,
        rateAt: Date.now(), rateBytes: 0, rateMessages: 0, sessionBytes: 0 };
      const sent: Array<string | Uint8Array> = []; const closed: number[] = [];
      return { bufferedAmount: 0, sent, closed,
        send(data: string | Uint8Array) { sent.push(data); },
        close(code: number) { closed.push(code); },
        serializeAttachment(value: Attachment) { attachment = structuredClone(value); },
        deserializeAttachment() { return structuredClone(attachment); } };
    }
    const host = socket('host'); const guest = socket('guest');
    const stored = new Map<string, unknown>([['room', { expiresAt }]]);
    let ready: Promise<unknown> = Promise.resolve(); let alarm = 0;
    const state = {
      storage: { async get<T>(key: string) { return stored.get(key) as T | undefined; },
        async put<T>(key: string, value: T) { stored.set(key, value); },
        async setAlarm(value: number) { alarm = value; }, async deleteAll() { stored.clear(); } },
      getWebSockets: () => [guest, host], acceptWebSocket() {},
      blockConcurrencyWhile<T>(fn: () => Promise<T>) { const result = fn(); ready = result; return result; },
    };
    const worker = new RelayRoom(state, { ROOMS: { idFromName() {}, get() { throw new Error('not used'); } }, CREATE_TOKEN: 'test' });
    await ready;
    expect(alarm).toBe(expiresAt);
    expect(host.sent).toEqual([]); expect(guest.sent).toEqual([]); // no replayed hello/paired or credits
    worker.webSocketMessage(host, new Uint8Array([0, 1, 255]).buffer);
    expect(guest.sent).toEqual([new Uint8Array([0, 1, 255])]);
    expect(guest.deserializeAttachment().receiveCredit).toBe(125);
    expect(host.deserializeAttachment().sessionBytes).toBe(3);
    await worker.alarm();
    expect(host.closed).toContain(1008); expect(guest.closed).toContain(1008); expect(stored.size).toBe(0);
  });
  it('allows explicit loopback only and rejects plaintext remote/credentials', async () => {
    await expect(connectRelay('ws://example.com', roomId(), 'guest', { allowInsecureLoopback: true })).rejects.toThrow('WSS');
    await expect(connectRelay('ws://127.0.0.1:1', roomId(), 'guest')).rejects.toThrow('WSS');
    await expect(connectRelay('wss://user:pass@example.com', roomId(), 'guest')).rejects.toThrow('base URL');
  });
});
