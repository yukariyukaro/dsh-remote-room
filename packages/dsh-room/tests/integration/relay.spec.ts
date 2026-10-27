import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { Gateway } from '../../src/gateway.ts'
import { RoomRegistry } from '../../src/room-state.ts'
import { RelayClient } from '../../src/relay-client.ts'

const SECRET = 'test-relay-secret-1234567890'
let relayPort = 0
let upstream: Server
let gateway: Gateway
let registry: RoomRegistry
let client: RelayClient
let gatewayPort = 0

const limits = { invitationTtlMs: 60_000, pendingTtlMs: 60_000, sessionIdleTtlMs: 60_000, sessionMaxTtlMs: 600_000, maxPending: 4, maxMembers: 4 }

async function startRelay(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ['relay/server.mjs'], {
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1', RELAY_SECRET: SECRET, RELAY_ROOM: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('relay did not start')), 15_000)
    child.stdout.on('data', chunk => {
      buffer += chunk.toString()
      const match = /RELAY_PORT=(\d+)/.exec(buffer)
      if (match) { clearTimeout(timer); resolve(Number(match[1])) }
    })
    child.stderr.on('data', chunk => { buffer += chunk.toString() })
    relayChild = child
  })
}
let relayChild: ChildProcess

beforeEach(async () => {
  upstream = createServer((req, res) => {
    if ((req.headers.cookie ?? '').includes('dsh-auth=fake')) {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'dsh-auth=leak; Path=/' })
      res.end('<html><body>dsh-relay</body></html>')
      return
    }
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('unauthorized')
  })
  const wss = new WebSocketServer({ noServer: true })
  upstream.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => ws.on('message', (data, binary) => ws.send(data, { binary })))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()))
  const upstreamPort = (upstream.address() as AddressInfo).port

  relayPort = await startRelay()

  registry = new RoomRegistry(limits)
  gateway = new Gateway({
    registry,
    upstream: { host: '127.0.0.1', port: upstreamPort, cookie: async () => 'dsh-auth=fake' },
    policy: {
      authorities: () => [`127.0.0.1:${gatewayPort}`, `127.0.0.1:${relayPort}`],
      origins: () => [`http://127.0.0.1:${gatewayPort}`, `http://127.0.0.1:${relayPort}`],
      peers: () => [],
      relayPeer: () => 'test-relay-token',
    },
  })
  const listener = await gateway.listen('127.0.0.1', 0)
  gatewayPort = listener.port
  registry.open(listener)
  client = new RelayClient({
    url: `ws://127.0.0.1:${relayPort}/tunnel`,
    room: 'test',
    secret: SECRET,
    relayToken: 'test-relay-token',
    gateway: () => ({ host: '127.0.0.1', port: gatewayPort }),
  })
  client.start()
  await waitFor(() => client.connected)
})

afterEach(async () => {
  client?.stop()
  await gateway.close()
  await new Promise<void>(resolve => upstream.close(() => resolve()))
  relayChild?.kill()
  if (client) await new Promise(resolve => setTimeout(resolve, 50))
})

async function waitFor(predicate: () => boolean, timeout = 10_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('condition not reached')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

async function guestSession(): Promise<string> {
  const { token } = registry.invite()
  const requested = await (await fetch(`http://127.0.0.1:${relayPort}/join/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })).json() as { requestId: string; pollSecret: string }
  registry.approve(requested.requestId)
  const polled = await fetch(`http://127.0.0.1:${relayPort}/join/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requested) })
  const approved = await polled.json() as { ticket?: string }
  const entered = await fetch(`http://127.0.0.1:${relayPort}/join/enter?t=${encodeURIComponent(approved.ticket ?? '')}`, { redirect: 'manual' })
  return (entered.headers.getSetCookie?.()[0] ?? '').split(';')[0] ?? ''
}

describe('relay tunnel', () => {
  it('serves the joining flow through the relay', async () => {
    const cookie = await guestSession()
    expect(cookie.startsWith('dsh_room=')).toBe(true)
  })

  it('proxies the UI through the relay', async () => {
    const cookie = await guestSession()
    const answer = await fetch(`http://127.0.0.1:${relayPort}/`, { headers: { cookie } })
    const body = await answer.text()
    expect(answer.status).toBe(200)
    expect(body).toContain('dsh-relay')
    expect(answer.headers.getSetCookie?.() ?? []).toHaveLength(0)
  })

  it('refuses guests without a session', async () => {
    expect((await fetch(`http://127.0.0.1:${relayPort}/`)).status).toBe(401)
  })

  it('relays the mux WebSocket', async () => {
    const cookie = await guestSession()
    const socket = new WebSocket(`ws://127.0.0.1:${relayPort}/api/remote.mux`, { headers: { cookie } })
    const reply = await new Promise<string>((resolve, reject) => {
      socket.on('error', reject)
      socket.on('open', () => socket.send('relay-ping'))
      socket.on('message', data => resolve(data.toString()))
    })
    expect(reply).toBe('relay-ping')
    socket.close()
  })

  it('rejects a host without the relay secret', async () => {
    const wrong = new WebSocket(`ws://127.0.0.1:${relayPort}/tunnel?room=test`, { headers: { authorization: 'Bearer nope-nope-nope-nope' } })
    const outcome = await new Promise<string>(resolve => {
      wrong.on('open', () => resolve('open'))
      wrong.on('error', () => resolve('error'))
      wrong.on('unexpected-response', (_request, response) => resolve(`status:${response.statusCode}`))
    })
    expect(outcome).not.toBe('open')
    wrong.terminate()
  })
})
