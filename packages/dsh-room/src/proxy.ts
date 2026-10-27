/** HTTP and WebSocket forwarding to the loopback DSH listener. Every header decision lives here. */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'

export interface Upstream {
  readonly host: string
  readonly port: number
  /** The loopback listener's scheme; an HTTPS DSH deployment needs an HTTPS replay. */
  readonly secure?: boolean
  /** Cookie minted by the local DSH listener for its own authority. Never logged or forwarded back. */
  readonly cookie: () => Promise<string>
  /** Drop a rejected cookie so the next request exchanges a fresh one. */
  readonly invalidate?: () => void
}

/** Host header text for an upstream address, bracketing an IPv6 literal. */
export function hostHeader(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
}

/** Hop-by-hop headers a proxy must never copy end to end. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/** Guest headers that are meaningless or unsafe once the request is re-authorized upstream. */
const GUEST_HEADERS = new Set([
  'cookie', 'origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest',
  'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions',
  // Encoding is negotiated once, at the outer edge: a relayed body must not arrive pre-encoded
  // with a header the edge may rewrite.
  'accept-encoding',
])

export function sanitizeRequestHeaders(headers: IncomingMessage['headers'], cookie: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  const named = new Set((headers.connection ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean))
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower) || GUEST_HEADERS.has(lower) || named.has(lower)) continue
    if (lower.startsWith('x-forwarded-') || lower === 'forwarded' || lower === 'x-real-ip') continue
    out[name] = value
  }
  out.cookie = cookie
  // Ask the loopback listener for an unencoded body; the edge re-encodes for the guest.
  out['accept-encoding'] = 'identity'
  return out
}

export function sanitizeResponseHeaders(headers: NodeJS.Dict<string | string[]>, upstreamAuthority: string, requestPath = '/'): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    // The upstream cookie is bound to the loopback authority; leaking it to a guest is both useless and unsafe.
    if (lower === 'set-cookie' || lower === 'content-encoding' || HOP_BY_HOP.has(lower) || lower.startsWith('access-control-')) continue
    if (lower === 'location' && typeof value === 'string') {
      try {
        // Resolve against the request's own directory so a relative redirect keeps its depth.
        const base = new URL(requestPath.startsWith('/') ? requestPath : `/${requestPath}`, upstreamAuthority)
        const location = new URL(value, base)
        out.location = location.origin === new URL(upstreamAuthority).origin ? `${location.pathname}${location.search}${location.hash}` : value
      } catch { continue }
      continue
    }
    out[lower] = value
  }
  return out
}

export async function forwardRequest(req: IncomingMessage, res: ServerResponse, upstream: Upstream): Promise<void> {
  const cookie = await upstream.cookie()
  const headers = sanitizeRequestHeaders(req.headers, cookie)
  const authorityHost = hostHeader(upstream.host, upstream.port)
  headers.host = authorityHost
  const scheme = upstream.secure === true ? 'https' : 'http'
  const authority = `${scheme}://${authorityHost}`
  const url = req.url ?? '/'
  const send = upstream.secure === true ? httpsRequest : httpRequest
  await new Promise<void>((resolve, reject) => {
    const outgoing = send({
      host: upstream.host, port: upstream.port, method: req.method, path: url, headers, agent: false,
      ...(upstream.secure === true ? { rejectUnauthorized: false } : {}),
    }, incoming => {
      // A rejected cookie is retried by the next request, never by replaying this one.
      if (incoming.statusCode === 401) upstream.invalidate?.()
      res.writeHead(incoming.statusCode ?? 502, sanitizeResponseHeaders(incoming.headers, authority, url))
      incoming.pipe(res)
      incoming.on('end', resolve)
      incoming.on('error', reject)
    })
    outgoing.on('error', reject)
    req.pipe(outgoing)
    res.on('close', () => { if (!res.writableEnded) outgoing.destroy() })
  }).catch(error => {
    if (res.headersSent) { res.destroy(); return }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(`upstream unavailable: ${error instanceof Error ? error.message : 'unknown error'}\n`)
  })
}

export interface UpgradeTarget { host: string; port: number; cookie: string }

const server = new WebSocketServer({ noServer: true, perMessageDeflate: false })
/** Frames larger than this are refused rather than buffered without bound. */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024

/**
 * Relay one authenticated WebSocket upgrade. Both ends are real WebSocket peers, so
 * extensions, fragmentation and close handshakes stay well-formed on both sides.
 */
export async function forwardUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, target: UpgradeTarget): Promise<void> {
  const protocols = (req.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim()).filter(Boolean)
  await new Promise<void>(resolve => {
    server.handleUpgrade(req, socket as never, head, client => {
      const url = `ws://${target.host}:${target.port}${req.url ?? '/'}`
      let upstream: WebSocket
      try {
        upstream = new WebSocket(url, protocols, {
          headers: { host: `${target.host}:${target.port}`, cookie: target.cookie },
          perMessageDeflate: false,
          maxPayload: MAX_BUFFERED_BYTES,
        })
      } catch {
        // The guest already owns an upgraded socket; fail it as a WebSocket, never as raw HTTP.
        client.close(1011, 'upstream unavailable')
        resolve()
        return
      }
      const closeBoth = (code: number, reason: string): void => {
        try { client.close(code, reason) } catch { client.terminate() }
        try { upstream.close(code, reason) } catch { upstream.terminate() }
        resolve()
      }
      // A guest may speak before the loopback carrier is ready; buffer a bounded prefix instead of dropping it.
      const pending: { data: unknown; binary: boolean }[] = []
      let pendingBytes = 0
      const flush = (): void => {
        for (const item of pending.splice(0)) upstream.send(item.data as Buffer, { binary: item.binary })
        pendingBytes = 0
      }
      upstream.on('open', flush)
      client.on('message', (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) {
          if (upstream.bufferedAmount > MAX_BUFFERED_BYTES) { closeBoth(1013, 'backpressure'); return }
          upstream.send(data, { binary: isBinary })
          return
        }
        if (upstream.readyState !== WebSocket.CONNECTING) return
        const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data))
        if (pendingBytes + size > 1024 * 1024) { closeBoth(1013, 'too much early data'); return }
        pending.push({ data, binary: isBinary })
        pendingBytes += size
      })
      upstream.on('message', (data, isBinary) => {
        if (client.readyState !== WebSocket.OPEN) return
        if (client.bufferedAmount > MAX_BUFFERED_BYTES) { closeBoth(1013, 'backpressure'); return }
        client.send(data, { binary: isBinary })
      })
      upstream.on('close', (code, reason) => closeBoth(code === 1005 ? 1000 : code, reason.toString() || 'upstream closed'))
      upstream.on('error', () => closeBoth(1011, 'upstream failed'))
      client.on('close', () => { try { upstream.close(1000, 'guest closed') } catch { upstream.terminate() } resolve() })
      client.on('error', () => { try { upstream.terminate() } catch { /* already gone */ } resolve() })
    })
  })
}
