/**
 * Cloudflare Worker relay for DSH Room.
 *
 * Guests speak normal HTTPS/WSS to this Worker. The Host dials /tunnel and stays attached,
 * so no inbound port or public DNS record is needed on the Host machine.
 *
 * Everything for one room lives in a single Durable Object: it owns the Host socket, the
 * in-flight requests and the guest streams. A Worker alone cannot do this — isolates are
 * stateless and cannot hold a long-lived socket between two requests.
 */

const PROTOCOL = 1
const MAX_RELAY_BODY = 64 * 1024 * 1024

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
})

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/healthz') {
      const room = env.ROOM.get(env.ROOM.idFromName(env.ROOM_NAME ?? 'default'))
      const state = await room.fetch(new Request('https://room.internal/healthz'))
      return new Response(JSON.stringify({ ok: true, ...(await state.json()) }), {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      })
    }
    const room = env.ROOM.get(env.ROOM.idFromName(env.ROOM_NAME ?? 'default'))
    return room.fetch(request)
  },
}

export class Room {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.host = null
    this.requests = new Map()
    this.streams = new Map()
    this.waiting = new Map()
    this.seq = 0
  }

  id() {
    this.seq += 1
    return `${Date.now().toString(36)}-${this.seq.toString(36)}`
  }

  send(frame) {
    if (this.host?.readyState !== 1) return false
    try { this.host.send(JSON.stringify(frame)); return true } catch { return false }
  }

  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/healthz') {
      return json({ host: this.host?.readyState === 1, protocol: PROTOCOL })
    }
    const upgrade = (request.headers.get('Upgrade') ?? '').toLowerCase()
    if (url.pathname === '/tunnel') {
      if (upgrade !== 'websocket') return json({ error: 'expected a WebSocket upgrade' }, 426)
      const auth = request.headers.get('authorization') ?? ''
      if (!this.env.RELAY_SECRET || auth !== `Bearer ${this.env.RELAY_SECRET}`) {
        return new Response('unauthorized', { status: 401 })
      }
      return this.acceptHost(request)
    }
    if (this.host?.readyState !== 1) return new Response('no host is attached\n', { status: 503, headers: { 'cache-control': 'no-store' } })
    if (upgrade === 'websocket') return this.guestStream(request, url)
    return this.guestRequest(request, url)
  }

  acceptHost(request) {
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    // Hibernation: the DO may be evicted between frames, so the socket must be accepted by the
    // platform and its role carried on the socket itself, not in a field.
    this.state.acceptWebSocket(server)
    server.serializeAttachment({ role: 'host' })
    if (this.host?.readyState === 1) { try { this.host.close(1000, 'replaced') } catch { /* already gone */ } }
    this.host = server
    this.host = server
    server.send(JSON.stringify({ type: 'ready', room: this.env.ROOM_NAME ?? 'default', protocol: PROTOCOL }))
    return new Response(null, { status: 101, webSocket: client })
  }

  failAll() {
    for (const [id, waiter] of this.waiting) {
      try { waiter.reject(new Error('host detached')) } catch { /* already settled */ }
      this.waiting.delete(id)
    }
    for (const [, stream] of this.streams) { try { stream.ws.close(1011, 'host detached') } catch { /* gone */ } }
    this.streams.clear()
    for (const [, request] of this.requests) { try { request.close() } catch { /* gone */ } }
    this.requests.clear()
  }

  /** Platform callback for every message, including after a hibernation wake. */
  async webSocketMessage(ws, message) {
    const attachment = ws.deserializeAttachment?.() ?? null
    if (attachment?.role === 'host') {
      this.host = ws
      this.onHostFrame(message)
      return
    }
    console.log('[do] guest message', typeof message, attachment?.streamId)
    const streamId = attachment?.streamId
    if (typeof streamId !== 'string') return
    const binary = typeof message !== 'string'
    const bytes = binary ? new Uint8Array(message) : new TextEncoder().encode(message)
    const stream = this.streams.get(streamId)
    if (stream?.opened === true) this.send({ type: 'stream.data', id: streamId, data: base64(bytes), binary })
    else stream?.queue.push({ items: bytes, binary })
  }

  async webSocketClose(ws, code) {
    console.log('[do] close', code, JSON.stringify(ws.deserializeAttachment?.() ?? null))
    const attachment = ws.deserializeAttachment?.() ?? null
    if (attachment?.role === 'host') { if (this.host === ws) this.host = null; this.failAll(); return }
    const streamId = attachment?.streamId
    if (typeof streamId === 'string') { this.streams.delete(streamId); this.send({ type: 'stream.close', id: streamId, code }) }
  }

  onHostFrame(raw) {
    let frame
    try { frame = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)) } catch { return }
    if (frame.type?.startsWith('stream')) console.log('[do] host frame', frame.type, String(frame.id).slice(0, 6), frame.binary ?? '')
    if (frame.type === 'hello' && frame.protocol !== PROTOCOL) {
      this.send({ type: 'error', reason: 'protocol mismatch' })
      try { this.host?.close(1002, 'protocol mismatch') } catch { /* gone */ }
      return
    }
    if (frame.type === 'response') {
      const waiter = this.waiting.get(frame.id)
      if (!waiter) return
      this.waiting.delete(frame.id)
      waiter.resolve({ status: frame.status, headers: frame.headers ?? {} })
      return
    }
    if (frame.type === 'response.body') {
      const request = this.requests.get(frame.id)
      if (request) request.write(base64ToBytes(frame.data))
      return
    }
    if (frame.type === 'response.end') {
      const request = this.requests.get(frame.id)
      this.requests.delete(frame.id)
      if (request) request.close()
      return
    }
    if (frame.type === 'stream.opened') {
      const stream = this.streams.get(frame.id)
      if (!stream) return
      stream.opened = true
      for (const queued of stream.queue.splice(0)) this.send({ type: 'stream.data', id: frame.id, data: base64(queued.items), binary: queued.binary })
      void 0
      return
    }
    if (frame.type === 'stream.failed') {
      const stream = this.streams.get(frame.id)
      this.streams.delete(frame.id)
      if (stream) { try { stream.ws.close(1011, frame.reason ?? 'upstream failed') } catch { /* gone */ } }
      return
    }
    if (frame.type === 'stream.data') {
      const stream = this.streams.get(frame.id)
      // A text frame must stay text: DSH's mux rejects a binary frame with 1003.
      if (stream) { try { stream.ws.send(frame.binary ? base64ToBytes(frame.data) : new TextDecoder().decode(base64ToBytes(frame.data))) } catch { /* gone */ } }
      return
    }
    if (frame.type === 'stream.close') {
      const stream = this.streams.get(frame.id)
      this.streams.delete(frame.id)
      if (stream) { try { stream.ws.close(frame.code ?? 1000, frame.reason ?? '') } catch { /* gone */ } }
    }
  }

  async guestRequest(request, url) {
    const id = this.id()
    let buffered = 0
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    this.requests.set(id, {
      write: chunk => { writer.write(chunk).catch(() => {}) },
      close: () => { writer.close().catch(() => {}) },
    })
    const header = new Promise((resolve, reject) => { this.waiting.set(id, { resolve, reject }) })
    const headers = {}
    for (const [name, value] of request.headers) {
      if (['host', 'connection', 'upgrade', 'cf-connecting-ip', 'cf-ray'].includes(name.toLowerCase())) continue
      headers[name.toLowerCase()] = value
    }
    const peer = request.headers.get('CF-Connecting-IP') ?? undefined
    this.send({ type: 'request', id, method: request.method, path: url.pathname + url.search, headers, peer })
    if (request.body) {
      const reader = request.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffered += value.byteLength
        if (buffered > MAX_RELAY_BODY) break
        this.send({ type: 'request.body', id, data: base64(value), binary: true })
      }
    }
    this.send({ type: 'request.end', id })
    let head
    try { head = await header } catch { return new Response('host detached\n', { status: 503 }) }
    // 204/205/304 forbid a body; keep the stream unused rather than letting the runtime throw.
    if (head.status === 204 || head.status === 205 || head.status === 304) return new Response(null, { status: head.status, headers: stripHopByHop(head.headers) })
    return new Response(readable, { status: head.status, headers: stripHopByHop(head.headers) })
  }

  guestStream(request, url) {
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    const id = this.id()
    this.state.acceptWebSocket(server)
    server.serializeAttachment({ role: 'guest', streamId: id })
    const stream = { ws: server, opened: false, queue: [] }
    this.streams.set(id, stream)
    const headers = {}
    for (const [name, value] of request.headers) {
      if (['connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions'].includes(name.toLowerCase())) continue
      headers[name.toLowerCase()] = value
    }
    const peer = request.headers.get('CF-Connecting-IP') ?? undefined
    this.send({ type: 'stream.open', id, path: url.pathname + url.search, headers, peer })
    return new Response(null, { status: 101, webSocket: client })
  }
}

// Room cookies are minted by the Host gateway and must reach the guest. DSH's own cookie is
// already stripped one hop earlier, so this layer forwards set-cookie untouched.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length'])
function stripHopByHop(headers) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower) || lower.startsWith('access-control-')) continue
    out[name] = value
  }
  return out
}

function base64(bytes) {
  let binary = ''
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  for (let index = 0; index < view.length; index += 1) binary += String.fromCharCode(view[index])
  return btoa(binary)
}

function base64ToBytes(text) {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index)
  return out
}
