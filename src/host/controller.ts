import type { RemoteRoomManager, CreateInput } from '../room-service.ts'
import type { ShareInput } from '../share.ts'
import type { ShareSettings } from './settings.ts'
import { PROCESS_METHODS } from './processes.ts'
import { integer, json, object, RoomError, text, type Json } from '../protocol.ts'
import { shareScope } from './settings.ts'

interface Connection {
  readonly browserPeer: { readonly id: string }
  admit(request: Request): { rejection: number } | { peer: { id: string; principal: { kind: string } } }
  readonly fetch: { register(route: { path: string; methods: ('POST' | 'GET')[]; requestBody: 'buffered' | 'streaming'; fetch(request: Request): Promise<Response> }): () => Promise<void> }
}

/** Local sharing preferences as the owner UI sees them; the relay secret never crosses this seam. */
export interface ShareBridge {
  create(input: ShareInput): Promise<CreateInput>
  settings(): ShareSettings
  update(patch: Record<string, unknown>): Promise<ShareSettings>
}

/** Same-process UI bridge; this API is never exposed through the guest room channel. */
export class RoomController {
  private readonly sinks = new Set<() => void>()
  private readonly disposers: (() => Promise<void>)[] = []
  constructor(
    private readonly manager: RemoteRoomManager,
    private readonly connection: Connection,
    private readonly maxRequestBytes: number,
    private readonly share: ShareBridge,
  ) {}

  mount(): void {
    this.disposers.push(this.connection.fetch.register({ path: '/api/remote-room', methods: ['POST'], requestBody: 'streaming', fetch: request => this.handle(request) }))
    // requestBody describes the incoming GET, not the streaming response. GET must have no body.
    this.disposers.push(this.connection.fetch.register({ path: '/api/remote-room/events', methods: ['GET'], requestBody: 'buffered', fetch: async request => this.events(request) }))
  }
  async dispose(): Promise<void> {
    for (const close of [...this.sinks]) close()
    await Promise.all(this.disposers.splice(0).map(dispose => dispose()))
  }
  private browserOnly(request: Request): void {
    const admitted = this.connection.admit(request)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner' || admitted.peer.id !== this.connection.browserPeer.id) throw new RoomError('FORBIDDEN', 'This operation requires the local owner browser')
  }
  async handle(request: Request): Promise<Response> {
    try {
      this.browserOnly(request)
      if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) throw new RoomError('INVALID_INPUT', 'Expected application/json')
      const body = await readBody(request, this.maxRequestBytes)
      const input = object(json(JSON.parse(body)))
      const action = text(input.action, 'action', 64)
      let value: Json
      if (action === 'state') value = json(this.manager.state())
      else if (action === 'create') value = json(await this.manager.create(await this.share.create(input)))
      else if (action === 'settings') value = json(redact(this.share.settings()))
      else if (action === 'settings.update') value = json(redact(await this.share.update(patchOf(input))))
      else if (action === 'join') value = json(await this.manager.join(text(input.invitation, 'invitation', 8192)))
      else {
        const id = text(input.id, 'room id', 128)
        if (action === 'approve') value = json(await this.manager.approve(id))
        else if (action === 'revoke') value = json(await this.manager.revoke(id))
        else if (action === 'close') value = json(await this.manager.close(id))
        else {
          const room = this.manager.state().rooms.find(room => room.id === id)
          const epoch = input.epoch === undefined && action === 'audit' ? room?.epoch ?? '' : text(input.epoch, 'connection epoch', 128)
          if (action === 'process') {
            const method = text(input.method, 'process operation', 64)
            if (!(PROCESS_METHODS as readonly string[]).includes(method)) throw new RoomError('METHOD_NOT_FOUND', 'Unsupported remote process operation')
            value = await this.manager.invoke(id, epoch, method, json(input.args), request.signal)
          } else if (action === 'audit') {
            const page = object(await this.manager.invoke(id, epoch, 'audit.query', {}, request.signal))
            value = json(page.entries)
          } else {
            const path = text(input.path, 'remote path')
            switch (action) {
              case 'list': value = await this.manager.invoke(id, epoch, 'fs.list', { path }, request.signal); break
              case 'readText': value = await this.manager.invoke(id, epoch, 'fs.readText', { path }, request.signal); break
              case 'readBytes': value = await this.manager.invoke(id, epoch, 'fs.readBytes', { path }, request.signal); break
              default: throw new RoomError('METHOD_NOT_FOUND', 'Unknown local UI operation')
            }
          }
        }
      }
      return Response.json({ ok: true, value }, { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'REQUEST_FAILED'
      return Response.json({ ok: false, error: { code, message: error instanceof Error ? error.message : 'Room operation failed' } }, { status: code === 'FORBIDDEN' ? 403 : 200, headers: { 'Cache-Control': 'no-store' } })
    }
  }
  private events(request: Request): Response {
    try { this.browserOnly(request) } catch { return new Response('Local owner browser required', { status: 403 }) }
    let cleanup: (endStream?: boolean) => void = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        let ended = false
        let unwatch: () => void = () => {}
        const close = (endStream = true) => {
          if (ended) return
          ended = true
          unwatch()
          request.signal.removeEventListener('abort', abort)
          this.sinks.delete(close)
          if (endStream) controller.close()
        }
        const abort = () => close()
        cleanup = close
        this.sinks.add(close)
        request.signal.addEventListener('abort', abort, { once: true })
        unwatch = this.manager.subscribe(state => {
          if (ended) return
          if ((controller.desiredSize ?? 0) <= 0) { close(); return }
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(state)}\n\n`))
        })
        if (request.signal.aborted) close()
      },
      cancel: () => { cleanup(false) },
    }, { highWaterMark: 4 })
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', 'X-Accel-Buffering': 'no' } })
  }
}
async function readBody(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get('content-length')
  if (declared !== null) integer(Number(declared), 'request size', 0, maxBytes)
  const reader = request.body?.getReader()
  if (!reader) throw new RoomError('INVALID_INPUT', 'Request body is required')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      request.signal.throwIfAborted()
      const item = await reader.read()
      if (item.done) break
      bytes += item.value.byteLength
      if (bytes > maxBytes) throw new RoomError('LIMIT_EXCEEDED', 'Request body too large')
      chunks.push(item.value)
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } finally { await reader.cancel(); reader.releaseLock() }
}

/** The owner browser learns whether a relay secret exists, never the secret itself. */
function redact(settings: ShareSettings): Json {
  return {
    version: settings.version,
    scope: settings.scope,
    relayUrl: settings.relayUrl,
    lastRoot: settings.lastRoot,
    relayCreateToken: '',
    hasRelayCreateToken: settings.relayCreateToken !== '',
  }
}

/** Only known preference fields cross the bridge, and every value is validated before storage. */
function patchOf(input: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (input.scope !== undefined) patch.scope = shareScope(input.scope)
  if (input.relayUrl !== undefined) patch.relayUrl = text(input.relayUrl, 'relay address', 2048)
  if (input.relayCreateToken !== undefined) patch.relayCreateToken = text(input.relayCreateToken, 'relay token', 512)
  if (input.lastRoot !== undefined) patch.lastRoot = text(input.lastRoot, 'shared directory', 4096)
  if (Object.keys(patch).length === 0) throw new RoomError('INVALID_INPUT', 'No sharing preference was provided')
  return patch
}
