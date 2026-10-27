#!/usr/bin/env node
/**
 * Standalone relay for DSH Room. Run it on any machine with a public port; the Host dials out to it,
 * so the Host never needs an inbound port. Protocol v1 must match src/relay-protocol.ts.
 *
 *   RELAY_SECRET=... RELAY_ROOM=my-room PORT=8443 node relay/server.mjs
 *   optional: RELAY_CERT / RELAY_KEY for native TLS
 */
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'

const PROTOCOL = 1
const CHUNK = 64 * 1024

const port = Number(process.env.PORT ?? 8443)
const secret = process.env.RELAY_SECRET ?? ''
const room = process.env.RELAY_ROOM ?? 'room'
const certFile = process.env.RELAY_CERT ?? ''
const keyFile = process.env.RELAY_KEY ?? ''
if (secret.length < 16) {
  console.error('relay: RELAY_SECRET must be at least 16 characters')
  process.exit(1)
}

const hostSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false })
const guestSockets = new WebSocketServer({ noServer: true, perMessageDeflate: false })
let host = null

const log = line => console.log(`[${new Date().toISOString()}] ${line}`)
const send = frame => { if (host?.readyState === WebSocket.OPEN) host.send(JSON.stringify(frame)) }

const hopByHop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
const cleanHeaders = headers => {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (value === undefined || hopByHop.has(lower)) continue
    out[lower] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return out
}

const pendingRequests = new Map()
const pendingStreams = new Map()

const server = certFile !== '' && keyFile !== ''
  ? createHttpsServer({ cert: readFileSync(certFile), key: readFileSync(keyFile), minVersion: 'TLSv1.2' }, onRequest)
  : createHttpServer(onRequest)

function onRequest(req, res) {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, host: host?.readyState === WebSocket.OPEN, protocol: PROTOCOL }))
    return
  }
  if (host?.readyState !== WebSocket.OPEN) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('no host is attached\n')
    return
  }
  const id = randomUUID()
  pendingRequests.set(id, { res, started: false })
  send({ type: 'request', id, method: req.method ?? 'GET', path: req.url ?? '/', headers: cleanHeaders(req.headers), peer: req.socket.remoteAddress })
  req.on('data', chunk => send({ type: 'request.body', id, data: chunk.toString('base64'), binary: true }))
  req.on('end', () => send({ type: 'request.end', id }))
  req.on('error', () => { send({ type: 'request.end', id }) })
  res.on('close', () => pendingRequests.delete(id))
}

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url ?? '/', 'http://relay.invalid').pathname
  if (path === '/tunnel') {
    const auth = req.headers.authorization ?? ''
    if (auth !== `Bearer ${secret}`) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    hostSockets.handleUpgrade(req, socket, head, ws => {
      if (host !== null) { try { host.close(1000, 'replaced') } catch { host.terminate() } }
      host = ws
      log('host attached')
      ws.on('message', data => onHostFrame(data.toString()))
      ws.on('close', () => { if (host === ws) host = null; log('host detached') })
      ws.on('error', () => { if (host === ws) host = null })
      ws.send(JSON.stringify({ type: 'ready', room, protocol: PROTOCOL }))
    })
    return
  }
  if (host?.readyState !== WebSocket.OPEN) { socket.destroy(); return }
  const id = randomUUID()
  if (process.env.RELAY_DEBUG) log(`guest upgrade ${path} id=${id.slice(0, 8)}`)
  pendingStreams.set(id, { req, socket, head })
  send({ type: 'stream.open', id, path: req.url ?? '/', headers: cleanHeaders(req.headers), peer: req.socket.remoteAddress })
  socket.on('error', () => { pendingStreams.delete(id); send({ type: 'stream.close', id }) })
})

function onHostFrame(raw) {
  let frame
  try { frame = JSON.parse(raw) } catch { return }
  if (frame?.type === 'hello' && frame.protocol !== PROTOCOL) {
    log(`protocol mismatch: host ${frame.protocol}, relay ${PROTOCOL}`)
    host?.close(1002, 'protocol mismatch')
    return
  }
  if (frame?.type === 'response') {
    const pending = pendingRequests.get(frame.id)
    if (!pending || pending.started) return
    pending.started = true
    pending.res.writeHead(frame.status, frame.headers)
    return
  }
  if (frame?.type === 'response.body') {
    const pending = pendingRequests.get(frame.id)
    if (pending && !pending.res.writableEnded) pending.res.write(Buffer.from(frame.data, 'base64'))
    return
  }
  if (frame?.type === 'response.end') {
    const pending = pendingRequests.get(frame.id)
    pendingRequests.delete(frame.id)
    if (pending && !pending.res.writableEnded) pending.res.end()
    return
  }
  if (frame?.type === 'stream.opened') {
    const pending = pendingStreams.get(frame.id)
    pendingStreams.delete(frame.id)
    if (!pending) return
    guestSockets.handleUpgrade(pending.req, pending.socket, pending.head, ws => {
      streams.set(frame.id, ws)
      ws.on('message', (data, binary) => {
        send({ type: 'stream.data', id: frame.id, data: Buffer.from(data).toString('base64'), binary })
      })
      ws.on('close', (code, reason) => { streams.delete(frame.id); send({ type: 'stream.close', id: frame.id, code, reason: reason.toString() }) })
      ws.on('error', () => { streams.delete(frame.id); send({ type: 'stream.close', id: frame.id }) })
    })
    return
  }
  if (frame?.type === 'stream.failed') {
    const pending = pendingStreams.get(frame.id)
    pendingStreams.delete(frame.id)
    if (!pending) return
    pending.socket.write(`HTTP/1.1 ${frame.status ?? 502} Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    pending.socket.destroy()
    return
  }
  if (frame?.type === 'stream.data') {
    const ws = streams.get(frame.id)
    if (ws?.readyState === WebSocket.OPEN) ws.send(Buffer.from(frame.data, 'base64'), { binary: frame.binary !== false })
    return
  }
  if (frame?.type === 'stream.close') {
    const ws = streams.get(frame.id)
    streams.delete(frame.id)
    if (ws) { try { ws.close(1000, 'relay closed') } catch { ws.terminate() } }
  }
}

const streams = new Map()

server.listen(port, process.env.HOST ?? '0.0.0.0', () => {
  const actual = server.address()?.port ?? port
  log(`relay listening on :${actual} room=${room} tls=${certFile !== ''} protocol=${PROTOCOL}`)
  console.log(`RELAY_PORT=${actual}`)
})
