/**
 * Exercises the Cloudflare Durable Object logic without deploying it: the Worker runtime
 * pieces used here (WebSocketPair, accept/send/close, Response) are stubbed in memory.
 *
 * Socket roles: `client` is the peer the runtime hands to the caller (the Host connector or a
 * guest browser); `server` is what the Durable Object holds. Sending on one delivers to the other.
 */
import { beforeEach, describe, expect, it } from 'vitest'

interface ListenerMap {
  message?: ((event: { data: unknown }) => void)[]
  close?: ((event: { code?: number }) => void)[]
  error?: (() => void)[]
}

class FakeSocket {
  readyState = 1
  peer: FakeSocket | undefined
  readonly listeners: ListenerMap = {}
  readonly sent: unknown[] = []
  readonly received: unknown[] = []
  accept(): void {}
  addEventListener(type: keyof ListenerMap, handler: never): void {
    (this.listeners[type] ??= [] as never[]).push(handler)
  }
  send(data: unknown): void { this.sent.push(data); this.peer?.deliverMessage(data) }
  close(code?: number): void { this.readyState = 3; this.peer?.deliverClose(code) }
  deliverMessage(data: unknown): void {
    this.received.push(data)
    for (const handler of this.listeners.message ?? []) handler({ data })
  }
  deliverClose(code?: number): void {
    this.readyState = 3
    for (const handler of this.listeners.close ?? []) handler({ code })
  }
}

// The Workers runtime accepts `new Response(null, { status: 101, webSocket })`; Node's does not.
const NodeResponse = globalThis.Response
class WebSocketResponse extends NodeResponse {
  readonly webSocket: unknown
  constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
    if (init?.status === 101) {
      super(null)
      this.webSocket = init.webSocket
      return
    }
    super(body, init)
    this.webSocket = undefined
  }
}
;(globalThis as unknown as { Response: unknown }).Response = WebSocketResponse

let pair: { client: FakeSocket; server: FakeSocket } | undefined

beforeEach(() => {
  pair = undefined
  ;(globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = function WebSocketPair() {
    const client = new FakeSocket()
    const server = new FakeSocket()
    client.peer = server
    server.peer = client
    pair = { client, server }
    return { 0: client, 1: server }
  }
})

// @ts-expect-error the Worker bundle is plain JavaScript without declarations.
const worker = await import('../../relay/worker/src/index.js')
const { Room } = worker as unknown as {
  Room: new (state: unknown, env: Record<string, unknown>) => { fetch(request: Request): Promise<Response> }
}

const env = { RELAY_SECRET: 'secret-secret-secret', ROOM_NAME: 'test' }
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

interface Host {
  room: InstanceType<typeof Room>
  /** Frames the Durable Object sent towards the Host connector. */
  inbound(): Record<string, unknown>[]
  /** Simulate a frame coming from the Host connector. */
  send(frame: Record<string, unknown>): void
}

async function connectHost(authorization = 'Bearer secret-secret-secret'): Promise<Host | undefined> {
  const room = new Room({}, env)
  await room.fetch(new Request('https://relay.invalid/tunnel', { headers: { upgrade: 'websocket', authorization } }))
  if (pair === undefined) return undefined
  const hostPair = pair
  return {
    room,
    inbound: () => hostPair.server.sent.map(raw => JSON.parse(String(raw)) as Record<string, unknown>),
    send: frame => hostPair.client.send(JSON.stringify(frame)),
  }
}

describe('worker room', () => {
  it('refuses a host without the secret', async () => {
    const room = new Room({}, env)
    const answer = await room.fetch(new Request('https://relay.invalid/tunnel', { headers: { upgrade: 'websocket', authorization: 'Bearer wrong' } }))
    expect(answer.status).toBe(401)
  })

  it('answers health without a host', async () => {
    const room = new Room({}, env)
    const answer = await room.fetch(new Request('https://relay.invalid/healthz'))
    expect(await answer.json()).toEqual({ host: false, protocol: 1 })
  })

  it('rejects a non-upgrade request on /tunnel', async () => {
    const room = new Room({}, env)
    const answer = await room.fetch(new Request('https://relay.invalid/tunnel', { headers: { authorization: 'Bearer secret-secret-secret' } }))
    expect(answer.status).toBe(426)
  })

  it('streams an HTTP response through the tunnel', async () => {
    const host = await connectHost()
    if (host === undefined) throw new Error('host did not attach')
    const pending = host.room.fetch(new Request('https://relay.invalid/hello', { headers: { 'cf-connecting-ip': '203.0.113.9' } }))
    await tick()
    const request = host.inbound().find(frame => frame.type === 'request')
    expect(request?.path).toBe('/hello')
    expect(request?.peer).toBe('203.0.113.9')
    expect(request?.headers).not.toHaveProperty('cf-connecting-ip')
    host.send({ type: 'response', id: request?.id, status: 200, headers: { 'content-type': 'text/plain' } })
    host.send({ type: 'response.body', id: request?.id, data: b64('relayed body') })
    host.send({ type: 'response.end', id: request?.id })
    const answer = await pending
    expect(answer.status).toBe(200)
    expect(await answer.text()).toBe('relayed body')
  })

  it('forwards the request body to the host', async () => {
    const host = await connectHost()
    if (host === undefined) throw new Error('host did not attach')
    const pending = host.room.fetch(new Request('https://relay.invalid/upload', { method: 'POST', body: 'payload' }))
    await tick()
    const request = host.inbound().find(frame => frame.type === 'request')
    const body = host.inbound().find(frame => frame.type === 'request.body')
    expect(Buffer.from(String(body?.data), 'base64').toString()).toBe('payload')
    host.send({ type: 'response', id: request?.id, status: 204, headers: {} })
    host.send({ type: 'response.end', id: request?.id })
    expect((await pending).status).toBe(204)
  })

  it('queues early guest frames and relays them once the stream opens', async () => {
    const host = await connectHost()
    if (host === undefined) throw new Error('host did not attach')
    const answering = host.room.fetch(new Request('https://relay.invalid/api/remote.mux', { headers: { upgrade: 'websocket', 'cf-connecting-ip': '203.0.113.9' } }))
    await tick()
    const guest = pair?.client as FakeSocket
    const open = host.inbound().find(frame => frame.type === 'stream.open')
    expect(open?.path).toBe('/api/remote.mux')
    guest.send('early')
    host.send({ type: 'stream.opened', id: open?.id })
    await tick()
    const queued = host.inbound().filter(frame => frame.type === 'stream.data')
    expect(Buffer.from(String(queued[0]?.data), 'base64').toString()).toBe('early')
    expect(queued[0]?.binary).toBe(false)
    await answering
  })

  it('delivers host frames to the guest and closes on stream.close', async () => {
    const host = await connectHost()
    if (host === undefined) throw new Error('host did not attach')
    const answering = host.room.fetch(new Request('https://relay.invalid/api/remote.mux', { headers: { upgrade: 'websocket' } }))
    await tick()
    const guest = pair?.client as FakeSocket
    const open = host.inbound().find(frame => frame.type === 'stream.open')
    host.send({ type: 'stream.opened', id: open?.id })
    host.send({ type: 'stream.data', id: open?.id, data: b64('reply'), binary: false })
    await tick()
    const delivered = guest.received.at(-1) as Uint8Array
    expect(Buffer.from(delivered).toString()).toBe('reply')
    host.send({ type: 'stream.close', id: open?.id, code: 1000 })
    await tick()
    expect(guest.readyState).toBe(3)
    await answering
  })

  it('closes the guest stream when the host reports a failure', async () => {
    const host = await connectHost()
    if (host === undefined) throw new Error('host did not attach')
    const answering = host.room.fetch(new Request('https://relay.invalid/api/remote.mux', { headers: { upgrade: 'websocket' } }))
    await tick()
    const guest = pair?.client as FakeSocket
    const open = host.inbound().find(frame => frame.type === 'stream.open')
    host.send({ type: 'stream.failed', id: open?.id, status: 502, reason: 'upstream failed' })
    await tick()
    expect(guest.readyState).toBe(3)
    await answering
  })

  it('refuses guest traffic while no host is attached', async () => {
    const room = new Room({}, env)
    const answer = await room.fetch(new Request('https://relay.invalid/'))
    expect(answer.status).toBe(503)
  })
})
