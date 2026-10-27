/** The private sharing listener: guest ingress, pairing pages, and forwarding to loopback DSH. */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { forwardRequest, forwardUpgrade, type Upstream } from './proxy.ts'
import { RoomError, RoomRegistry, type Listener } from './room-state.ts'
import { inAnyCidr, normalizeAddress, type Cidr } from './net.ts'

export const SESSION_COOKIE = 'dsh_room'

export interface GatewayPolicy {
  /** Authorities this listener answers for, e.g. `127.0.0.1:19443`. */
  authorities(): string[]
  /** Origins allowed to make browser requests, e.g. `http://127.0.0.1:19443`. */
  origins(): string[]
  /** Direct peers allowed to connect at all; empty means "every peer the socket already admits". */
  peers(): readonly Cidr[]
  tls?(): { cert: string; key: string } | undefined
  /** Present a per-process token the relay connector stamps on tunneled requests. */
  relayPeer?(): string | undefined
}

/** A browser reaching the gateway through an SSH local forward keeps a loopback host and changes only the port. */
function isLoopbackHostname(name: string): boolean {
  if (name === 'localhost' || name === '[::1]') return true
  const parts = name.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

function hostnameOf(authority: string): string {
  return authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.slice(0, authority.lastIndexOf(':'))
}

export interface GatewayOptions {
  registry: RoomRegistry
  upstream: Upstream
  policy: GatewayPolicy
  log?: (line: string) => void
}

const HOSTNAME = /^[a-z0-9.-]+$/i

/** Parse a Host header into a bare authority, rejecting malformed or ambiguous forms. */
export function normalizedHost(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const text = value.trim().toLowerCase()
  if (text === '' || text.length > 255) return undefined
  const bracketed = /^\[([0-9a-f:.]+)](?::(\d{1,5}))?$/.exec(text)
  if (bracketed !== null) {
    const port = bracketed[2] ?? '80'
    return `[${bracketed[1]}]:${port}`
  }
  const match = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(text)
  if (match === null) return undefined
  const name = match[1] ?? ''
  if (!HOSTNAME.test(name)) return undefined
  return `${name}:${match[2] ?? '80'}`
}

const cookies = (header: string | undefined): Map<string, string> => {
  const values = new Map<string, string>()
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    values.set(part.slice(0, index).trim(), part.slice(index + 1).trim())
  }
  return values
}

export class Gateway {
  private server: Server | undefined
  private bound: Listener | undefined
  private readonly sockets = new Set<Duplex>()
  /** Upgraded sockets per member, so revocation can end a live stream instead of only future requests. */
  private readonly memberSockets = new Map<string, Set<Duplex>>()

  constructor(private readonly options: GatewayOptions) {}

  get listener(): Listener | undefined { return this.bound }

  private track(memberId: string, socket: Duplex): void {
    let owned = this.memberSockets.get(memberId)
    if (owned === undefined) { owned = new Set(); this.memberSockets.set(memberId, owned) }
    owned.add(socket)
    const drop = (): void => {
      const set = this.memberSockets.get(memberId)
      set?.delete(socket)
      if (set?.size === 0) this.memberSockets.delete(memberId)
    }
    socket.once('close', drop)
    socket.once('error', drop)
  }

  /** End every stream this member still holds. Called on kick. */
  revokeMember(memberId: string): void {
    const owned = this.memberSockets.get(memberId)
    if (owned === undefined) return
    this.memberSockets.delete(memberId)
    for (const socket of owned) { try { socket.destroy() } catch { /* already gone */ } }
  }

  /** Drop streams whose member expired by idle or absolute TTL. */
  sweepMembers(isActive: (memberId: string) => boolean): void {
    for (const memberId of [...this.memberSockets.keys()]) {
      if (isActive(memberId)) continue
      this.revokeMember(memberId)
    }
  }

  private get registry(): RoomRegistry { return this.options.registry }

  async listen(host: string, port: number): Promise<Listener> {
    if (this.server !== undefined) throw new Error('gateway is already listening')
    const tls = this.options.policy.tls?.()
    const handler = (req: IncomingMessage, res: ServerResponse): void => { void this.handle(req, res) }
    this.server = tls === undefined
      ? createHttpServer(handler)
      : createHttpsServer({ cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2' }, handler)
    this.server.on('upgrade', (req, socket, head) => { void this.upgrade(req, socket, head) })
    this.server.on('connection', socket => {
      this.sockets.add(socket)
      socket.on('close', () => { this.sockets.delete(socket) })
    })
    this.server.headersTimeout = 20_000
    this.server.requestTimeout = 0
    try {
      await new Promise<void>((resolve, reject) => {
        this.server?.once('error', reject)
        this.server?.listen(port, host, () => {
          this.server?.removeListener('error', reject)
          resolve()
        })
      })
    } catch (error) {
      // A failed bind must not leave a half-open server behind: callers retry with another port.
      // Closing a listener that never started throws, and that must not mask the bind error.
      const failed = this.server
      this.server = undefined
      this.bound = undefined
      try { await new Promise<void>(resolve => { if (failed === undefined) { resolve(); return } failed.close(() => resolve()) }) } catch { /* not running */ }
      throw error
    }
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('gateway bound to an unexpected address')
    this.bound = { host: address.address, port: address.port, secure: tls !== undefined }
    return this.bound
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.bound = undefined
    if (server === undefined) return
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.memberSockets.clear()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  /** One ingress gate shared by HTTP and WebSocket. Returns a member id or a rejection. */
  private admit(req: IncomingMessage, method: string): { memberId?: string; rejection?: number; reason?: string } {
    const socketPeer = normalizeAddress(req.socket.remoteAddress ?? '')
    // Relay traffic arrives from the connector on loopback; the real guest address rides a header
    // that only the connector knows, so a guest cannot claim to be somebody else.
    const relayToken = this.options.policy.relayPeer?.()
    const relayed = typeof relayToken === 'string' && relayToken !== ''
      && req.headers['x-dsh-room-relay'] === relayToken
      && (socketPeer === '127.0.0.1' || socketPeer === '::1')
    const forwarded = relayed ? req.headers['x-dsh-room-peer'] : undefined
    const remote = normalizeAddress(typeof forwarded === 'string' && forwarded !== '' ? forwarded : socketPeer)
    const peers = this.options.policy.peers()
    // Relayed guests never touch this socket directly: the relay is the network perimeter there,
    // so a LAN-only CIDR list must not reject them as if they had connected to the loopback listener.
    if (!relayed && peers.length > 0 && !inAnyCidr(peers, remote)) return { rejection: 403, reason: 'peer' }
    const host = normalizedHost(req.headers.host)
    if (host === undefined || !this.hostAllowed(host)) return { rejection: 403, reason: 'host' }
    const site = req.headers['sec-fetch-site']
    if (typeof site === 'string' && site.toLowerCase() === 'cross-site') return { rejection: 403, reason: 'site' }
    const origin = req.headers.origin
    if (origin !== undefined) {
      if (!this.originAllowed(origin.toLowerCase())) return { rejection: 403, reason: 'origin' }
    } else if (method !== 'GET' && method !== 'HEAD') {
      // Browsers attach Origin to every non-simple request; a write without it is not a same-origin page.
      return { rejection: 403, reason: 'origin-missing' }
    }
    const token = cookies(req.headers.cookie).get(SESSION_COOKIE)
    if (token === undefined) return { rejection: 401, reason: 'session' }
    const member = this.registry.authenticate(token)
    if (member === undefined) return { rejection: 401, reason: 'session' }
    return { memberId: member.id }
  }

  /** Exact authorities, plus any loopback port: an SSH local forward keeps the hostname and changes the port. */
  private hostAllowed(authority: string): boolean {
    if (this.options.policy.authorities().includes(authority)) return true
    return isLoopbackHostname(hostnameOf(authority))
  }

  private originAllowed(origin: string): boolean {
    if (this.options.policy.origins().includes(origin)) return true
    try {
      const parsed = new URL(origin)
      // A relay changes the public scheme (https) while the local listener stays http;
      // the authority list is the real gate, so compare hosts rather than schemes here.
      return this.hostAllowed(parsed.host.toLowerCase()) || isLoopbackHostname(parsed.hostname)
    } catch { return false }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase()
    const url = new URL(req.url ?? '/', 'http://placeholder')
    const deny = (status: number): void => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(status === 401 ? 'unauthorized\n' : 'forbidden\n')
    }
    try {
      // Management endpoints exist only on the loopback DSH listener; a guest must never reach them.
      if (url.pathname === '/api/room' || url.pathname.startsWith('/api/room/')) return deny(404)
      if (url.pathname === '/join' || url.pathname.startsWith('/join/')) return await this.join(req, res, url, method)
      if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return }
      const admission = this.admit(req, method)
      if (admission.rejection !== undefined) return deny(admission.rejection)
      await forwardRequest(req, res, this.options.upstream)
    } catch (error) {
      this.options.log?.(`ingress failure: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end('request failed\n')
      } else res.destroy()
    }
  }

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const reject = (status: number): void => {
      socket.write(`HTTP/1.1 ${status} denied\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      socket.destroy()
    }
    try {
      const path = new URL(req.url ?? '/', 'http://placeholder').pathname
      if (path === '/api/room' || path.startsWith('/api/room/')) return reject(404)
      // Only the DSH gateway mux is forwarded; unknown upgrade routes fail closed.
      if (path !== '/api/remote.mux') return reject(404)
      const admission = this.admit(req, 'GET')
      if (admission.rejection !== undefined) return reject(admission.rejection)
      if (admission.memberId !== undefined) this.track(admission.memberId, socket)
      const listener = this.bound
      if (listener === undefined) return reject(503)
      try {
        const cookie = await this.options.upstream.cookie()
        await forwardUpgrade(req, socket, head, { host: this.options.upstream.host, port: this.options.upstream.port, cookie })
      } catch {
        // Past this point the socket may already speak WebSocket; never append an HTTP response to it.
        socket.destroy()
      }
    } catch {
      reject(500)
    }
  }

  private async join(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
    const send = (status: number, body: string, type: string, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...headers })
      res.end(body)
    }
    if (url.pathname === '/join' && (method === 'GET' || method === 'HEAD')) {
      const nonce = randomBytes(16).toString('base64')
      send(200, JOIN_PAGE(nonce), 'text/html; charset=utf-8', {
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'`,
      })
      return
    }
    // A top-level navigation can set the session cookie reliably, including through a relay.
    if (url.pathname === '/join/enter') {
      const ticket = url.searchParams.get('t') ?? ''
      const token = this.registry.redeem(ticket)
      if (token === undefined) return send(403, 'invitation handoff expired\n', 'text/plain; charset=utf-8')
      const secure = this.bound?.secure === true
      res.writeHead(303, {
        // Absolute: a relative target would resolve against /join/enter.
        location: '/',
        'set-cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`,
        'cache-control': 'no-store',
      })
      res.end()
      return
    }
    if (method !== 'POST') return send(405, 'method not allowed\n', 'text/plain; charset=utf-8')
    const body = await readJson(req)
    if (url.pathname === '/join/request') {
      try {
        const token = typeof body.token === 'string' ? body.token.trim() : ''
        if (token.length < 16 || token.length > 512) throw new RoomError('INVITATION_INVALID', 'This invitation is no longer valid')
        const remote = normalizeAddress(req.socket.remoteAddress ?? 'unknown')
        const label = typeof body.label === 'string' ? body.label.trim().slice(0, 48) : ''
        const result = this.registry.request(token, remote, label)
        this.options.log?.(`join request from ${remote}`)
        send(200, JSON.stringify({ ok: true, ...result }), 'application/json')
      } catch (error) {
        send(403, JSON.stringify({ ok: false, message: error instanceof Error ? error.message : 'Invitation rejected' }), 'application/json')
      }
      return
    }
    if (url.pathname === '/join/status') {
      try {
        const requestId = typeof body.requestId === 'string' ? body.requestId : ''
        const pollSecret = typeof body.pollSecret === 'string' ? body.pollSecret : ''
        const result = this.registry.poll(requestId, pollSecret)
        // The cookie is issued on the redirect that follows, never on an XHR response.
        send(200, JSON.stringify({ ok: true, phase: result.phase, ...(result.ticket === undefined ? {} : { ticket: result.ticket }) }), 'application/json')
      } catch {
        send(404, JSON.stringify({ ok: false, message: 'Unknown or expired join request' }), 'application/json')
      }
      return
    }
    send(404, 'not found\n', 'text/plain; charset=utf-8')
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 16_384) throw new RoomError('PAYLOAD_TOO_LARGE', 'Join payload too large')
    chunks.push(chunk as Buffer)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch { return {} }
}

/** Pairing page. It reads the invitation from the fragment, so the secret never reaches a request log. */
const JOIN_PAGE = (nonce: string): string => `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Room</title>
<style>body{font:15px/1.6 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#101418;color:#e6edf3}
main{max-width:26rem;padding:2rem}code{background:#1c232b;padding:.15rem .35rem;border-radius:.3rem}
input{width:100%;margin:.4rem 0 .6rem;padding:.5rem .6rem;border-radius:.4rem;border:1px solid #2b333d;background:#161b22;color:inherit;font:inherit}
button{width:100%;padding:.55rem;border:0;border-radius:.4rem;background:#2f6feb;color:#fff;font:inherit;cursor:pointer}
p{color:#9fb0c0}</style></head>
<body><main><h1>DSH Room</h1><p id="s">正在连接房主…</p>
<input id="n" placeholder="你的名字（会显示给房主）" maxlength="48" autocomplete="off">
<button id="g">申请加入</button></main>
<script nonce="${nonce}">
const s = document.getElementById('s')
const token = location.hash.slice(1)
history.replaceState(null, '', '/join')
if (!token) { s.textContent = '缺少邀请信息，请重新从房主处获取链接。' }
else {
  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json())
  const field = document.getElementById('n')
  const go = document.getElementById('g')
  const start = () => {
  const label = (field && field.value || '').trim()
  if (go) go.disabled = true
  post('/join/request', { token, label }).then(async result => {
    if (!result.ok) { s.textContent = result.message || '邀请无效。'; return }
    s.textContent = '已发送申请，等待房主批准…'
    if (field) field.disabled = true
    for (;;) {
      await new Promise(r => setTimeout(r, 1000))
      let state
      try { state = await post('/join/status', { requestId: result.requestId, pollSecret: result.pollSecret }) } catch { continue }
      if (!state.ok) { s.textContent = state.message || '申请已失效。'; return }
      if (state.phase === 'approved') {
        s.textContent = '已批准，正在进入…'
        if (state.ticket) { location.replace('/join/enter?t=' + encodeURIComponent(state.ticket)); return }
        s.textContent = '批准信息无效，请让房主重新生成邀请。'
        return
      }
      if (state.phase === 'denied') { s.textContent = '房主拒绝了这次申请。'; return }
      if (state.phase === 'expired') { s.textContent = '申请已过期，请让房主重新生成邀请。'; return }
    }
  }).catch(() => { s.textContent = '无法连接房主，请确认仍在同一网络。' })
  }
  if (go) go.addEventListener('click', start)
  s.textContent = '填写名字后点下方按钮申请。'
}
</script></body></html>
`
