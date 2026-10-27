import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { Gateway } from '../../src/gateway.ts'
import { RoomRegistry } from '../../src/room-state.ts'
import type { Cidr } from '../../src/net.ts'

interface Seen { host?: string; cookie?: string; origin?: string; path?: string }

let upstream: Server
let gateway: Gateway
let registry: RoomRegistry
let port = 0
let upstreamPort = 0
const seen: Seen = {}

const limits = {
  invitationTtlMs: 60_000, pendingTtlMs: 60_000,
  sessionIdleTtlMs: 60_000, sessionMaxTtlMs: 600_000,
  maxPending: 4, maxMembers: 4,
}

beforeEach(async () => {
  seen.host = undefined; seen.cookie = undefined; seen.origin = undefined; seen.path = undefined
  upstream = createServer((req, res) => {
    seen.host = req.headers.host; seen.cookie = req.headers.cookie; seen.origin = req.headers.origin; seen.path = req.url
    if (!(req.headers.cookie ?? '').includes('dsh-auth=fake')) {
      res.writeHead(401, { 'content-type': 'text/plain' }); res.end('unauthorized'); return
    }
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'dsh-auth=leak; Path=/' })
      res.end('<html><body>dsh</body></html>'); return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ method: req.method, url: req.url }))
  })
  const sockets = new WebSocketServer({ noServer: true })
  upstream.on('upgrade', (req, socket, head) => {
    seen.host = req.headers.host; seen.cookie = req.headers.cookie; seen.path = req.url
    if (!(req.headers.cookie ?? '').includes('dsh-auth=fake')) { socket.destroy(); return }
    sockets.handleUpgrade(req, socket, head, ws => {
      ws.on('message', (data, binary) => ws.send(data, { binary }))
    })
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()))
  upstreamPort = (upstream.address() as AddressInfo).port

  registry = new RoomRegistry(limits)
  gateway = new Gateway({
    registry,
    upstream: { host: '127.0.0.1', port: upstreamPort, cookie: async () => 'dsh-auth=fake' },
    policy: {
      authorities: () => [`127.0.0.1:${port}`],
      origins: () => [`http://127.0.0.1:${port}`],
      peers: () => [],
    },
  })
  const listener = await gateway.listen('127.0.0.1', 0)
  port = listener.port
  registry.open(listener)
})

afterEach(async () => {
  await gateway.close()
  await new Promise<void>(resolve => upstream.close(() => resolve()))
})

interface Answer { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers }, (res: IncomingMessage) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk as Buffer))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

async function joinMember(): Promise<{ cookie: string; memberId: string }> {
  const { token } = registry.invite()
  const requested = await send('/join/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
  const body = JSON.parse(requested.body) as { requestId: string; pollSecret: string }
  registry.approve(body.requestId)
  const polled = await send('/join/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const approved = JSON.parse(polled.body) as { ticket?: string }
  // The session cookie is issued on the redirect that follows approval, not on the XHR.
  const entered = await send(`/join/enter?t=${encodeURIComponent(approved.ticket ?? '')}`)
  const raw = entered.headers['set-cookie']
  const cookie = (Array.isArray(raw) ? raw[0] : raw) ?? ''
  return { cookie: cookie.split(';', 1)[0] ?? '', memberId: registry.snapshot().members[0]?.id ?? '' }
}

async function join(): Promise<string> {
  return (await joinMember()).cookie
}

describe('guest ingress', () => {
  it('refuses an unauthenticated visitor', async () => {
    expect((await send('/')).status).toBe(401)
  })

  it('rejects a Host that is not this listener', async () => {
    expect((await send('/', { headers: { host: 'evil.example' } })).status).toBe(403)
  })

  it('rejects cross-site fetch metadata', async () => {
    expect((await send('/', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
  })

  it('rejects a write without Origin', async () => {
    const cookie = await join()
    expect((await send('/api/x', { method: 'POST', headers: { cookie }, body: '{}' })).status).toBe(403)
  })

  it('hides the owner bridge from guests', async () => {
    const cookie = await join()
    for (const path of ['/api/room', '/api/room/events', '/api/room/../room']) {
      expect((await send(path, { headers: { cookie } })).status, path).toBe(404)
    }
  })

  it('runs the invitation handshake and then proxies the UI', async () => {
    const cookie = await join()
    const answer = await send('/', { headers: { cookie } })
    expect(answer.status).toBe(200)
    expect(answer.body).toContain('dsh')
  })
})

describe('upstream boundary', () => {
  it('rewrites the authority and drops guest credentials and origin', async () => {
    const cookie = await join()
    await send('/x', { headers: { cookie, origin: `http://127.0.0.1:${port}`, referer: 'http://evil.example/' } })
    expect(seen.host).toBe(`127.0.0.1:${upstreamPort}`)
    expect(seen.cookie).toBe('dsh-auth=fake')
    expect(seen.origin).toBeUndefined()
  })

  it('never returns the upstream cookie', async () => {
    const cookie = await join()
    const answer = await send('/', { headers: { cookie } })
    expect(answer.headers['set-cookie']).toBeUndefined()
  })

  it('relays the DSH mux WebSocket', async () => {
    const cookie = await join()
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/remote.mux`, { headers: { cookie } })
    const reply = await new Promise<string>((resolve, reject) => {
      client.on('error', reject)
      client.on('open', () => client.send('{"type":"ping"}'))
      client.on('message', data => resolve(data.toString()))
    })
    expect(reply).toBe('{"type":"ping"}')
    expect(seen.cookie).toBe('dsh-auth=fake')
    client.close()
  })

  it('accepts the guest through an SSH local forward on another loopback port', async () => {
    const cookie = await join()
    // ssh -L 127.0.0.1:17443:127.0.0.1:<gateway> keeps the loopback host and only changes the port.
    const forwarded = await send('/', { headers: { cookie, host: '127.0.0.1:17443', origin: 'http://127.0.0.1:17443' } })
    expect(forwarded.status).toBe(200)
    expect(forwarded.body).toContain('dsh')
  })

  it('closes a live stream when the member is revoked', async () => {
    const { cookie, memberId } = await joinMember()
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/remote.mux`, { headers: { cookie } })
    await new Promise<void>((resolve, reject) => {
      client.on('open', () => resolve())
      client.on('error', reject)
    })
    expect(memberId).not.toBe('')
    gateway.revokeMember(memberId)
    const closed = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), 3000)
      client.on('close', () => { clearTimeout(timer); resolve(true) })
    })
    expect(closed).toBe(true)
  })

  it('refuses an unknown upgrade route', async () => {
    const cookie = await join()
    const client = new WebSocket(`ws://127.0.0.1:${port}/sidebar/ws/sidechat`, { headers: { cookie } })
    await new Promise<void>(resolve => {
      client.on('error', () => resolve())
      client.on('open', () => { client.close(); resolve() })
    })
    expect(client.readyState).not.toBe(WebSocket.OPEN)
  })
})

describe('peer allow list', () => {
  it('refuses a peer outside the configured ranges', async () => {
    const blocked: Cidr[] = [{ family: 4, bytes: new Uint8Array([10, 0, 0, 0]), prefix: 8 }]
    const strict = new Gateway({
      registry,
      upstream: { host: '127.0.0.1', port: upstreamPort, cookie: async () => 'dsh-auth=fake' },
      policy: { authorities: () => [`127.0.0.1:${port}`], origins: () => [`http://127.0.0.1:${port}`], peers: () => blocked },
    })
    const listener = await strict.listen('127.0.0.1', 0)
    const answer = await new Promise<number>(resolve => {
      const req = httpRequest({ host: '127.0.0.1', port: listener.port, path: '/' }, res => { res.resume(); resolve(res.statusCode ?? 0) })
      req.on('error', () => resolve(0))
      req.end()
    })
    expect(answer).toBe(403)
    await strict.close()
  })
})
