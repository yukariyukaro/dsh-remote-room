import { Duplex } from 'node:stream';
import WebSocket, { type RawData } from 'ws';

export interface RelayOptions {
  /** Independent random relay reservation capability; NEVER an invitation private key. Host only. */
  hostToken?: string;
  /** Optional deployment-wide creation gate (not E2E authentication). */
  createToken?: string;
  maxQueueBytes?: number;
  maxMessageBytes?: number;
  signal?: AbortSignal;
  allowInsecureLoopback?: boolean;
  connectTimeoutMs?: number;
}
function positive(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('Invalid relay limit');
  return value;
}
function rawBuffer(data: RawData): Buffer {
  return Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}
class RelayDuplex extends Duplex {
  private sendCredit = 0;
  private sending = false;
  private receiveCredit = 0;
  private hello = false;
  private paired = false;
  private window = 0;
  private frame = 0;
  private pending?: { data: Buffer; offset: number; callback: (error?: Error | null) => void };
  private timer?: ReturnType<typeof setTimeout>;
  private refillScheduled = false;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private readonly abort = () => this.destroy(new Error('Relay connection aborted'));
  private readonly keepalive: ReturnType<typeof setInterval>;
  constructor(private readonly ws: WebSocket, private readonly options: RelayOptions,
    private readonly queueLimit: number, private readonly frameLimit: number) {
    super({ readableHighWaterMark: queueLimit, writableHighWaterMark: queueLimit, allowHalfOpen: false });
    // A room expires only when it goes idle; a host waiting for its first guest has no
    // peer to exchange bytes with, so it keeps its reservation warm in a control frame.
    this.keepalive = setInterval(() => {
      if (this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send('{"type":"keepalive"}', () => {});
    }, 60_000);
    this.keepalive.unref();
    ws.on('message', this.message);
    ws.on('error', this.socketError);
    ws.on('close', this.socketClose);
    options.signal?.addEventListener('abort', this.abort, { once: true });
    if (options.signal?.aborted) this.abort();
  }
  /** Relay-level pairing, before any TLS record exists. */
  get isPaired(): boolean { return this.paired; }
  private socketError = (error: Error) => { this.destroy(error); };
  private socketClose = (code: number) => {
    if (code === 1000) { this.push(null); this.destroy(); }
    else this.destroy(new Error(`Relay closed (${code})`));
  };
  private control(value: object): void {
    const text = JSON.stringify(value);
    if (this.ws.readyState !== WebSocket.OPEN || this.ws.bufferedAmount + text.length > this.queueLimit) {
      this.destroy(new Error('Relay control queue exceeded')); return;
    }
    this.ws.send(text, (error) => { if (error) this.destroy(error); });
  }
  private message = (raw: RawData, binary: boolean) => {
    if (this.destroyed) return;
    const data = rawBuffer(raw);
    if (!binary) {
      if (data.length > 256) { this.destroy(new Error('Oversized relay control')); return; }
      try {
        const value = JSON.parse(data.toString()) as Record<string, unknown>;
        if (!value || typeof value !== 'object') throw new Error('Invalid relay control');
        if (value.type === 'hello' && !this.hello && value.version === 1 &&
            typeof value.maxMessageBytes === 'number' && typeof value.maxBufferedBytes === 'number') {
          const remoteFrame = positive(value.maxMessageBytes, 1024 * 1024);
          const remoteQueue = positive(value.maxBufferedBytes, 16 * 1024 * 1024);
          // Credit also bounds each peer's possible frame when local frame limit is smaller.
          this.window = Math.min(remoteQueue, this.queueLimit, this.frameLimit);
          this.frame = Math.min(remoteFrame, this.frameLimit, this.window);
          this.hello = true; this.refill();
        } else if (value.type === 'paired' && this.hello && !this.paired) {
          this.paired = true; this.emit('paired'); this.pump();
        } else if (value.type === 'credit' && this.hello && this.paired &&
            typeof value.bytes === 'number' && Number.isSafeInteger(value.bytes) && value.bytes > 0 &&
            this.sendCredit + value.bytes <= 16 * 1024 * 1024) {
          this.sendCredit += value.bytes; this.pump();
        } else throw new Error('Invalid relay control');
      } catch (error) { this.destroy(error instanceof Error ? error : new Error('Invalid relay control')); }
      return;
    }
    if (!this.hello || !this.paired || data.length === 0 || data.length > this.frameLimit ||
        data.length > this.receiveCredit || this.readableLength + data.length > this.queueLimit) {
      this.destroy(new Error('Relay receive budget exceeded')); return;
    }
    this.receiveCredit -= data.length;
    this.push(data);
    this.scheduleRefill();
  };
  private scheduleRefill(): void {
    if (this.refillScheduled || this.destroyed) return;
    this.refillScheduled = true;
    queueMicrotask(() => { this.refillScheduled = false; this.refill(); });
  }
  private refill(): void {
    if (!this.hello || this.destroyed) return;
    const amount = this.window - this.readableLength - this.receiveCredit;
    if (amount > 0) { this.receiveCredit += amount; this.control({ type: 'credit', bytes: amount }); }
  }
  override read(size?: number): any {
    const result: unknown = super.read(size);
    this.scheduleRefill();
    return result;
  }
  override _read(): void { this.scheduleRefill(); }
  // Enforce a hard bound even when a caller ignores Writable.write() === false.
  override write(chunk: any, encoding?: any, callback?: any): boolean {
    const length = typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : undefined)
      : ArrayBuffer.isView(chunk) ? chunk.byteLength : this.queueLimit + 1;
    if (length + this.writableLength > this.queueLimit) {
      const error = new Error('Relay write queue exceeded');
      const cb = typeof encoding === 'function' ? encoding : callback;
      if (typeof cb === 'function') queueMicrotask(() => cb(error));
      this.destroy(error); return false;
    }
    return super.write(chunk, encoding, callback);
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (chunk.length > this.queueLimit || this.writableLength > this.queueLimit) {
      callback(new Error('Relay write queue exceeded')); return;
    }
    this.pending = { data: chunk, offset: 0, callback }; this.pump();
  }
  private pump(): void {
    if (this.destroyed || !this.pending || !this.paired || this.sending) return;
    const pending = this.pending;
    if (pending.offset === pending.data.length) {
      this.pending = undefined; pending.callback(); return;
    }
    if (this.sendCredit === 0) return;
    const size = Math.min(this.frame, this.sendCredit, pending.data.length - pending.offset);
    if (this.ws.bufferedAmount + size > this.queueLimit) {
      this.timer ??= setTimeout(() => { this.timer = undefined; this.pump(); }, 10);
      return;
    }
    this.sendCredit -= size;
    const frame = pending.data.subarray(pending.offset, pending.offset + size);
    pending.offset += size;
    this.sending = true;
    this.ws.send(frame, { binary: true, compress: false }, (error) => {
      this.sending = false;
      if (error) this.destroy(error); else this.pump();
    });
  }
  override _final(callback: (error?: Error | null) => void): void {
    this.ws.close(1000, 'Stream ended'); callback();
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    clearInterval(this.keepalive);
    if (this.timer) clearTimeout(this.timer);
    this.options.signal?.removeEventListener('abort', this.abort);
    this.ws.off('message', this.message);
    // Keep an error listener until termination, including abort while connecting.
    this.ws.off('error', this.socketError);
    this.ws.on('error', () => {});
    this.ws.off('close', this.socketClose);
    const pending = this.pending; this.pending = undefined;
    if (pending) pending.callback(error ?? new Error('Relay disconnected'));
    if (this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.close(error ? 1008 : 1000, error ? 'Stream failed' : 'Stream closed');
      this.closeTimer = setTimeout(() => this.ws.terminate(), 250);
      this.closeTimer.unref();
      this.ws.once('close', () => { if (this.closeTimer) clearTimeout(this.closeTimer); });
    }
    callback(error);
  }
}

/** Resolves on accepted upgrade, NOT on pairing or authentication. Host may wait for guest.
 * `paired` is an informational stream event; control messages never enter TLS bytes.
 * Receiver credit bounds bytes through this adapter, not TLS/RPC's downstream queues.
 */
export async function connectRelay(url: string, roomId: string, role: 'host' | 'guest', options: RelayOptions = {}): Promise<Duplex> {
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(roomId) || (role !== 'host' && role !== 'guest')) throw new Error('Invalid relay route');
  if (role === 'host' && !/^[A-Za-z0-9_-]{32,128}$/.test(options.hostToken ?? '')) throw new Error('Random hostToken required');
  const target = new URL(url);
  const loopback = ['127.0.0.1', '[::1]'].includes(target.hostname);
  if (target.protocol !== 'wss:' && !(target.protocol === 'ws:' && loopback && options.allowInsecureLoopback === true))
    throw new Error('Relay requires WSS (explicit loopback WS is test-only)');
  if (target.username || target.password || target.hash || target.search) throw new Error('Invalid relay base URL');
  target.pathname = `/v1/rooms/${roomId}/${role}`;
  if (role === 'host') target.searchParams.set('hostToken', options.hostToken!);
  if (options.createToken && role === 'host') target.searchParams.set('createToken', options.createToken);
  const queue = positive(options.maxQueueBytes ?? 256 * 1024, 16 * 1024 * 1024);
  const frame = positive(options.maxMessageBytes ?? 64 * 1024, 1024 * 1024);
  const timeout = positive(options.connectTimeoutMs ?? 10_000, 120_000);
  if (options.signal?.aborted) throw new Error('Relay connection aborted');
  // ws is intentional: Node's global WebSocket exposes no strict maxPayload bound.
  const ws = new WebSocket(target, { maxPayload: Math.max(frame, 256), perMessageDeflate: false,
    handshakeTimeout: timeout, followRedirects: false });
  return new Promise<Duplex>((resolve, reject) => {
    const abort = () => { ws.terminate(); fail(new Error('Relay connection aborted')); };
    const cleanup = () => { options.signal?.removeEventListener('abort', abort); ws.off('error', fail); ws.off('close', closed); };
    const fail = (error: Error) => { cleanup(); ws.on('error', () => {}); reject(error); };
    const closed = () => fail(new Error('Relay closed before upgrade'));
    ws.once('error', fail); ws.once('close', closed);
    options.signal?.addEventListener('abort', abort, { once: true });
    ws.once('open', () => { cleanup(); resolve(new RelayDuplex(ws, options, queue, frame)); });
  });
}
