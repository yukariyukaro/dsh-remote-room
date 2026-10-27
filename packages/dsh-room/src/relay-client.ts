/**
 * Host side of the relay: dials out to a relay server and replays tunneled guest traffic
 * against the local gateway. Nothing here listens, so the Host works behind NAT.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import {
  RELAY_CHUNK_BYTES, RELAY_MAX_BODY_BYTES, RELAY_PROTOCOL,
  decodeBody, encodeBody, isRelayFrame, type RelayFrame,
} from './relay-protocol.ts'

export interface RelayOptions {
  /** Public relay endpoint, e.g. wss://room.example.com/tunnel */
  url: string
  room: string
  secret: string
  /** Per-process token the gateway requires on tunneled requests, so guests cannot spoof their peer. */
  relayToken?: string
  /** Loopback gateway the tunneled traffic is replayed into. */
  gateway: () => { host: string; port: number } | undefined
  log?: (line: string) => void
}

interface PendingRequest {
  chunks: Buffer[]
  size: number
  timer: ReturnType<typeof setTimeout>
  request?: import('node:http').ClientRequest
  responded: boolean
}

export class RelayClient {
  private socket: WebSocket | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private readonly requests = new Map<string, PendingRequest>()
  private readonly streams = new Map<string, WebSocket>()

  constructor(private readonly options: RelayOptions) {}

  get connected(): boolean { return this.socket?.readyState === WebSocket.OPEN }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.retry !== undefined) clearTimeout(this.retry)
    this.retry = undefined
    for (const [id, pending] of this.requests) {
      clearTimeout(pending.timer)
      pending.request?.destroy()
      this.requests.delete(id)
    }
    for (const [id, socket] of this.streams) {
      try { socket.close(1001, 'relay stopped') } catch { socket.terminate() }
      this.streams.delete(id)
    }
    const socket = this.socket
    this.socket = undefined
    if (socket !== undefined) { try { socket.close(1000, 'stopped') } catch { socket.terminate() } }
  }

  private connect(): void {
    if (this.stopped) return
    const url = new URL(this.options.url)
    url.searchParams.set('room', this.options.room)
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${this.options.secret}` },
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
    })
    this.socket = socket
    socket.on('open', () => {
      this.options.log?.('relay connected')
      this.send({ type: 'hello', room: this.options.room, protocol: RELAY_PROTOCOL })
    })
    socket.on('message', data => { void this.receive(data.toString()) })
    socket.on('close', () => { this.scheduleRetry() })
    socket.on('error', error => { this.options.log?.(`relay error: ${error.message}`) })
  }

  private scheduleRetry(): void {
    this.socket = undefined
    if (this.stopped) return
    this.retry = setTimeout(() => this.connect(), 2_000)
  }

  private send(frame: RelayFrame): void {
    const socket = this.socket
    if (socket?.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(frame))
  }

  private async receive(raw: string): Promise<void> {
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { return }
    if (!isRelayFrame(parsed)) return
    const frame = parsed
    try {
      switch (frame.type) {
        case 'request': this.beginRequest(frame); return
        case 'request.body': this.pushRequest(frame); return
        case 'request.end': this.endRequest(frame.id); return
        case 'stream.open': this.openStream(frame); return
        case 'stream.data': this.pushStream(frame.id, decodeBody(frame), frame.binary); return
        case 'stream.close': this.closeStream(frame.id); return
        default: return
      }
    } catch (error) {
      this.options.log?.(`relay frame failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private gateway(): { host: string; port: number } | undefined { return this.options.gateway() }

  private beginRequest(frame: Extract<RelayFrame, { type: 'request' }>): void {
    const pending: PendingRequest = { chunks: [], size: 0, responded: false, timer: setTimeout(() => this.endRequest(frame.id), 30_000) }
    this.requests.set(frame.id, pending)
    const headers = { ...frame.headers }
    if (frame.peer !== undefined) headers['x-dsh-room-peer'] = frame.peer
    if (this.options.relayToken !== undefined) headers['x-dsh-room-relay'] = this.options.relayToken
    const target = this.gateway()
    if (target === undefined) {
      this.send({ type: 'response', id: frame.id, status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } })
      this.send({ type: 'response.end', id: frame.id, error: 'gateway closed' })
      this.requests.delete(frame.id)
      return
    }
    const outgoing = httpRequest({ host: target.host, port: target.port, method: frame.method, path: frame.path, headers, agent: false }, incoming => {
      this.respond(frame.id, incoming)
    })
    pending.request = outgoing
    outgoing.on('error', error => {
      const entry = this.requests.get(frame.id)
      if (entry === undefined) return
      clearTimeout(entry.timer)
      if (!entry.responded) this.send({ type: 'response', id: frame.id, status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } })
      this.send({ type: 'response.end', id: frame.id, error: error.message })
      this.requests.delete(frame.id)
    })
  }

  private pushRequest(frame: Extract<RelayFrame, { type: 'request.body' }>): void {
    const pending = this.requests.get(frame.id)
    if (pending === undefined) return
    const chunk = decodeBody(frame)
    pending.size += chunk.length
    if (pending.size > RELAY_MAX_BODY_BYTES) {
      pending.request?.destroy(new Error('relayed body too large'))
      return
    }
    pending.chunks.push(chunk)
  }

  private endRequest(id: string): void {
    const pending = this.requests.get(id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    const request = pending.request
    if (request === undefined) return
    for (const chunk of pending.chunks) request.write(chunk)
    pending.chunks.length = 0
    request.end()
  }

  private respond(id: string, incoming: IncomingMessage): void {
    const pending = this.requests.get(id)
    if (pending === undefined) { incoming.resume(); return }
    pending.responded = true
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value === undefined) continue
      const lower = name.toLowerCase()
      if (lower === 'transfer-encoding' || lower === 'connection' || lower === 'keep-alive') continue
      headers[lower] = Array.isArray(value) ? value.join(', ') : value
    }
    this.send({ type: 'response', id, status: incoming.statusCode ?? 502, headers })
    incoming.on('data', (chunk: Buffer) => {
      for (let offset = 0; offset < chunk.length; offset += RELAY_CHUNK_BYTES) {
        this.send({ type: 'response.body', id, binary: true, ...encodeBody(chunk.subarray(offset, offset + RELAY_CHUNK_BYTES)) })
      }
    })
    incoming.on('end', () => {
      this.send({ type: 'response.end', id })
      this.requests.delete(id)
    })
    incoming.on('error', error => {
      this.send({ type: 'response.end', id, error: error.message })
      this.requests.delete(id)
    })
  }

  private openStream(frame: Extract<RelayFrame, { type: 'stream.open' }>): void {
    const target = this.gateway()
    if (target === undefined) {
      this.send({ type: 'stream.failed', id: frame.id, status: 503, reason: 'gateway closed' })
      return
    }
    const headers = { ...frame.headers }
    if (frame.peer !== undefined) headers['x-dsh-room-peer'] = frame.peer
    if (this.options.relayToken !== undefined) headers['x-dsh-room-relay'] = this.options.relayToken
    const protocols = (headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim()).filter(Boolean)
    // The guest's handshake headers describe its own peer; the ws client must negotiate its own.
    for (const name of ['sec-websocket-protocol', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-accept', 'connection', 'upgrade']) {
      delete headers[name]
    }
    const upstream = new WebSocket(`ws://${target.host}:${target.port}${frame.path}`, protocols, { headers, perMessageDeflate: false })
    this.streams.set(frame.id, upstream)
    upstream.on('open', () => { this.send({ type: 'stream.opened', id: frame.id }) })
    upstream.on('message', (data, isBinary) => {
      // One WebSocket message stays one relay frame, and keeps its text/binary identity.
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
      this.send({ type: 'stream.data', id: frame.id, data: buffer.toString('base64'), binary: isBinary })
    })
    upstream.on('close', (code, reason) => {
      this.streams.delete(frame.id)
      this.send({ type: 'stream.close', id: frame.id, code, reason: reason.toString() })
    })
    upstream.on('error', () => {
      this.streams.delete(frame.id)
      this.send({ type: 'stream.failed', id: frame.id, status: 502, reason: 'upstream failed' })
    })
  }

  private pushStream(id: string, data: Buffer, binary: boolean): void {
    const socket = this.streams.get(id)
    if (socket?.readyState !== WebSocket.OPEN) return
    socket.send(data, { binary })
  }

  private closeStream(id: string): void {
    const socket = this.streams.get(id)
    this.streams.delete(id)
    if (socket !== undefined) { try { socket.close(1000, 'relay closed') } catch { socket.terminate() } }
  }

  /** Allocate an id for a stream the Host initiates (unused today, kept for symmetry). */
  static id(): string { return randomUUID() }
}
