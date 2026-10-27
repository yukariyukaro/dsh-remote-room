import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { json, object, RoomError, text, type Json } from '../protocol.ts'

export interface RpcLimits {
  maxMessageBytes: number
  maxPending: number
  maxHandlers: number
  maxQueuedBytes: number
  timeoutMs: number
}
export const defaultRpcLimits: RpcLimits = {
  maxMessageBytes: 12 * 1024 * 1024,
  maxPending: 8,
  maxHandlers: 8,
  maxQueuedBytes: 16 * 1024 * 1024,
  timeoutMs: 30_000,
}
export type RpcHandler = (method: string, args: Json, signal: AbortSignal) => Promise<Json>
function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)) return error.code
  return 'REMOTE_FAILURE'
}
interface Pending { resolve(value: Json): void; reject(error: Error): void; cleanup(): void }

/** Length-framed RPC over an authenticated stream. Mutations are never automatically retried. */
export class RpcPeer {
  private buffer = Buffer.alloc(0)
  private readonly pending = new Map<string, Pending>()
  private readonly handlers = new Map<string, AbortController>()
  private sendTail: Promise<void> = Promise.resolve()
  private queuedBytes = 0
  private closed = false
  private sequence = 0
  private readonly prefix = randomBytes(8).toString('hex')
  private readonly closedCallbacks = new Set<(error: Error) => void>()
  private handler: RpcHandler = async () => { throw new RoomError('METHOD_NOT_FOUND', 'Method is not available') }

  constructor(private readonly stream: Duplex, readonly limits: RpcLimits = defaultRpcLimits) {
    for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid RPC limit: ${key}`)
    stream.on('data', this.receive)
    stream.once('error', this.fail)
    stream.once('close', this.onClose)
    stream.once('end', this.onClose)
  }

  serve(handler: RpcHandler): void { this.handler = handler }
  onClosed(callback: (error: Error) => void): () => void {
    this.closedCallbacks.add(callback)
    return () => { this.closedCallbacks.delete(callback) }
  }

  call(method: string, args: Json = null, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Json> {
    if (this.closed) return Promise.reject(new RoomError('DISCONNECTED', 'Remote connection is closed'))
    if (options.signal?.aborted) return Promise.reject(new RoomError('CANCELLED', 'Request cancelled'))
    if (this.pending.size >= this.limits.maxPending) return Promise.reject(new RoomError('BUSY', 'Too many in-flight requests'))
    text(method, 'method', 128)
    const id = `${this.prefix}:${++this.sequence}`
    return new Promise<Json>((resolve, reject) => {
      const abort = () => {
        const error = new RoomError('RESULT_UNKNOWN', 'Request cancelled or timed out; a mutation may already have executed. Do not replay it automatically.')
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        pending.cleanup()
        reject(error)
        void this.send({ type: 'cancel', id }).catch(this.fail)
      }
      const timeout = setTimeout(abort, options.timeoutMs ?? this.limits.timeoutMs)
      timeout.unref()
      options.signal?.addEventListener('abort', abort, { once: true })
      const cleanup = () => { clearTimeout(timeout); options.signal?.removeEventListener('abort', abort) }
      this.pending.set(id, { resolve, reject, cleanup })
      void this.send({ type: 'request', id, method, args }).catch(error => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id); cleanup(); reject(error)
      })
    })
  }

  close(reason = new RoomError('DISCONNECTED', 'Remote connection closed')): void { this.fail(reason) }

  private readonly onClose = () => { this.fail(new RoomError('DISCONNECTED', 'Remote connection closed; in-flight mutation results may be unknown')) }
  private readonly fail = (cause: unknown) => {
    if (this.closed) return
    this.closed = true
    const error = cause instanceof Error ? cause : new Error(String(cause))
    this.stream.off('data', this.receive)
    this.buffer = Buffer.alloc(0)
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error) }
    this.pending.clear()
    for (const controller of this.handlers.values()) controller.abort(error)
    this.handlers.clear()
    this.stream.destroy()
    for (const callback of this.closedCallbacks) { try { callback(error) } catch { /* Observers cannot prevent peer resource cleanup. */ } }
    this.closedCallbacks.clear()
  }

  private readonly receive = (chunk: Buffer) => {
    try {
      // TLS/readable chunks are bounded; reject before copying a hostile declared payload.
      if (this.buffer.length + chunk.length > this.limits.maxMessageBytes + 4 + 65536) throw new RoomError('LIMIT_EXCEEDED', 'RPC receive buffer exceeded')
      this.buffer = Buffer.concat([this.buffer, chunk])
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32BE(0)
        if (length < 2 || length > this.limits.maxMessageBytes) throw new RoomError('LIMIT_EXCEEDED', 'RPC message length exceeded')
        if (this.buffer.length < length + 4) break
        const payload = this.buffer.subarray(4, length + 4)
        this.buffer = this.buffer.subarray(length + 4)
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(payload)
        this.dispatch(json(JSON.parse(decoded)))
      }
    } catch (error) { this.fail(error) }
  }

  private dispatch(frame: Json): void {
    const value = object(frame)
    const type = text(value.type, 'frame type', 16)
    const id = text(value.id, 'request id', 96)
    if (type === 'cancel') { this.handlers.get(id)?.abort(new RoomError('CANCELLED', 'Peer cancelled request')); return }
    if (type === 'result' || type === 'error') {
      const pending = this.pending.get(id)
      if (!pending) return // Late replies never start work or settle a different request.
      this.pending.delete(id); pending.cleanup()
      if (type === 'result') pending.resolve(json(value.value))
      else pending.reject(new RoomError(text(value.code, 'error code', 128), text(value.message, 'error message', 4096)))
      return
    }
    if (type !== 'request') throw new RoomError('INVALID_FRAME', 'Unsupported RPC frame')
    const method = text(value.method, 'method', 128)
    const args = json(value.args)
    // Within a connection, peer-generated sequence ids are strictly increasing.
    const match = /^([a-f0-9]{16}):(\d+)$/.exec(id)
    if (!match || Number(match[2]) !== this.receivedSequence + 1 || (this.remotePrefix && match[1] !== this.remotePrefix)) throw new RoomError('REPLAY', 'Invalid or replayed request identifier')
    this.remotePrefix = match[1]
    this.receivedSequence++
    if (this.handlers.size >= this.limits.maxHandlers) { void this.send({ type: 'error', id, code: 'BUSY', message: 'Too many concurrent requests' }).catch(this.fail); return }
    const controller = new AbortController()
    this.handlers.set(id, controller)
    void Promise.resolve().then(() => this.handler(method, args, controller.signal)).then(
      value => this.send({ type: 'result', id, value: json(value) }),
      error => this.send({ type: 'error', id, code: errorCode(error), message: error instanceof Error ? error.message.slice(0, 4096) : 'Remote operation failed' }),
    ).catch(this.fail).finally(() => { this.handlers.delete(id) })
  }
  private receivedSequence = 0
  private remotePrefix: string | undefined

  private send(frame: Json): Promise<void> {
    if (this.closed) return Promise.reject(new RoomError('DISCONNECTED', 'Remote connection is closed'))
    const payload = Buffer.from(JSON.stringify(frame))
    if (payload.length > this.limits.maxMessageBytes || payload.length + 4 + this.queuedBytes > this.limits.maxQueuedBytes) return Promise.reject(new RoomError('LIMIT_EXCEEDED', 'RPC send queue exceeded'))
    const header = Buffer.allocUnsafe(4); header.writeUInt32BE(payload.length)
    this.queuedBytes += payload.length + 4
    const send = async () => {
      if (this.closed) throw new RoomError('DISCONNECTED', 'Remote connection is closed')
      for (const bytes of [header, payload]) {
        for (let offset = 0; offset < bytes.length; offset += 65536) {
          await new Promise<void>((resolve, reject) => {
            this.stream.write(bytes.subarray(offset, offset + 65536), error => error ? reject(error) : resolve())
          })
        }
      }
    }
    const task = this.sendTail.then(send).finally(() => { this.queuedBytes -= payload.length + 4 })
    this.sendTail = task.catch(() => { /* The caller owns the failure; keep the queue settled. */ })
    return task
  }
}
