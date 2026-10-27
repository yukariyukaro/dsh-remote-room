/** Owner-facing bridge. Mounted on the loopback DSH connection, never reachable through the gateway. */
import { RoomError, type RoomRegistry, type RoomSnapshot } from './room-state.ts'
import type { RoomService, ServiceHost } from './service.ts'
import type { Listener } from './room-state.ts'

export interface AdminValue {
  room: RoomSnapshot
  listener?: Listener
  error: string
  notice?: string
  invitationUrl?: string
  relay?: { enabled: boolean; authority: string }
}

const json = (value: unknown, status = 200): Response => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
const failure = (error: unknown): Response => {
  const code = error instanceof RoomError ? error.code : 'REQUEST_FAILED'
  const message = error instanceof Error ? error.message : 'Room operation failed'
  return json({ ok: false, error: { code, message } }, code === 'FORBIDDEN' ? 403 : 200)
}

/** Only the owner's own browser may drive the room; a guest session can never satisfy this. */
function requireOwner(host: ServiceHost, request: Request): void {
  const admitted = host.admit(request)
  if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner' || admitted.peer.id !== host.browserPeer.id) {
    throw new RoomError('FORBIDDEN', 'This operation requires the local owner browser')
  }
}

/** Read a small JSON object from the bridge request without relying on Request.json() over the node carrier. */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const stream = request.body
  if (stream === null) return {}
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      size += value.byteLength
      if (size > 65_536) throw new RoomError('PAYLOAD_TOO_LARGE', 'Request body too large')
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch { return {} }
}

export class RoomAdmin {
  private readonly disposers: (() => Promise<void> | void)[] = []
  private readonly sinks = new Set<() => void>()

  constructor(private readonly registry: RoomRegistry, private readonly service: RoomService) {}

  mount(host: ServiceHost): void {
    // Small JSON control messages: let the carrier buffer them so the handler reads an ordinary body.
    this.disposers.push(host.fetch.register({ path: '/api/room', methods: ['POST'], requestBody: 'buffered', fetch: request => this.handle(host, request) }))
    // requestBody describes the incoming GET, not the streaming response.
    this.disposers.push(host.fetch.register({ path: '/api/room/events', methods: ['GET'], requestBody: 'buffered', fetch: async request => this.events(host, request) }))
  }

  async dispose(): Promise<void> {
    for (const close of [...this.sinks]) close()
    await Promise.all(this.disposers.splice(0).map(async close => { await close() }))
  }

  private value(invitationUrl?: string): AdminValue {
    const base: AdminValue = { room: this.registry.snapshot(), error: this.service.error, notice: this.service.info, relay: this.service.relayState }
    const listener = this.service.current
    if (listener !== undefined) base.listener = listener
    if (invitationUrl !== undefined) base.invitationUrl = invitationUrl
    return base
  }

  private async handle(host: ServiceHost, request: Request): Promise<Response> {
    try {
      requireOwner(host, request)
      const body = await readJsonBody(request)
      const action = typeof body.action === 'string' ? body.action : ''
      switch (action) {
        case 'state': return json({ ok: true, value: this.value() })
        case 'listen': {
          await this.service.open()
          return json({ ok: true, value: this.value() })
        }
        case 'close': {
          await this.service.close()
          return json({ ok: true, value: this.value() })
        }
        case 'invite': {
          const invitation = this.service.invite()
          return json({ ok: true, value: this.value(invitation.url) })
        }
        case 'approve': {
          this.registry.approve(String(body.id ?? ''), typeof body.label === 'string' ? body.label : undefined)
          return json({ ok: true, value: this.value() })
        }
        case 'deny': {
          this.registry.deny(String(body.id ?? ''))
          return json({ ok: true, value: this.value() })
        }
        case 'kick': {
          this.service.kick(String(body.id ?? ''))
          return json({ ok: true, value: this.value() })
        }
        case 'relay.connect': {
          this.service.connectRelay(
            String(body.url ?? ''), String(body.room ?? ''), String(body.secret ?? ''),
            String(body.authority ?? ''), String(body.publicUrl ?? ''),
          )
          return json({ ok: true, value: this.value() })
        }
        case 'relay.disconnect': {
          this.service.disconnectRelay()
          return json({ ok: true, value: this.value() })
        }
        default: throw new RoomError('METHOD_NOT_FOUND', 'Unknown room operation')
      }
    } catch (error) {
      return failure(error)
    }
  }

  private events(host: ServiceHost, request: Request): Response {
    try { requireOwner(host, request) } catch { return new Response('Local owner browser required', { status: 403 }) }
    let cleanup = (): void => {}
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        let closed = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const encoder = new TextEncoder()
        const push = (): void => {
          if (closed) return
          if (timer !== undefined) return
          // Coalesce bursts: approvals and joins arrive in small groups.
          timer = setTimeout(() => {
            timer = undefined
            if (closed) return
            try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(this.value())}\n\n`)) } catch { closed = true }
          }, 50)
        }
        const unsubscribe = this.registry.subscribe(push)
        push()
        cleanup = (): void => {
          closed = true
          if (timer !== undefined) clearTimeout(timer)
          unsubscribe()
          this.sinks.delete(cleanup)
          try { controller.close() } catch { /* already closed */ }
        }
        this.sinks.add(cleanup)
        request.signal.addEventListener('abort', cleanup, { once: true })
      },
      cancel: () => { cleanup() },
    })
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' },
    })
  }
}
