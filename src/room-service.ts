import { randomBytes, randomUUID } from 'node:crypto'
import type { TLSSocket } from 'node:tls'
import path from 'node:path'
import type { Config } from './config.ts'
import { createInvitation, parseInvitation, type Invitation } from './invite.ts'
import { authenticateChannel } from './security/tls-channel.ts'
import { RpcPeer, defaultRpcLimits } from './wire/rpc.ts'
import { connectRelay } from './wire/websocket.ts'
import { json, object, roomMode, RoomError, text, integer, type Json, type RoomSnapshot, type RoomState, type RoomMode } from './protocol.ts'

export interface OperationContext {
  roomId: string
  peerId: string
  epoch: string
  requestId: string
  signal: AbortSignal
}
export interface RoomGrant {
  roomId: string
  peerId: string
  epoch: string
  root: string
  mode: RoomMode
  expiresAt: number
}
export interface HostRoomBackend {
  authorize(grant: RoomGrant, signal: AbortSignal): Promise<void>
  invoke(method: string, args: Json, context: OperationContext): Promise<Json>
  revoke(reason: string): Promise<void>
}
export type BackendFactory = (roomId: string) => HostRoomBackend
interface Room {
  snapshot: RoomSnapshot
  invitation: Invitation
  controller: AbortController
  rpc?: RpcPeer
  backend?: HostRoomBackend
  peerId?: string
  task?: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  heartbeat?: ReturnType<typeof setInterval>
  heartbeatBusy?: boolean
  approving?: boolean
  closing?: Promise<void>
}

/** Owns every room connection, authorization epoch and resource. UI visibility is not a lifetime. */
export class RemoteRoomManager {
  private readonly rooms = new Map<string, Room>()
  private revision = 0
  private readonly followers = new Set<(value: RoomState) => void>()
  private disposed = false
  private creating = 0
  constructor(private readonly config: Config, private readonly createBackend: BackendFactory) {}

  state(): RoomState { return { revision: this.revision, rooms: [...this.rooms.values()].map(room => ({ ...room.snapshot })) } }
  subscribe(listener: (value: RoomState) => void): () => void {
    this.followers.add(listener)
    listener(this.state())
    return () => { this.followers.delete(listener) }
  }

  async create(input: { relay: string; root: string; mode: RoomMode }): Promise<{ room: RoomSnapshot; invitation: string }> {
    this.reserve()
    const root = text(input.root, 'shared root')
    if (!path.isAbsolute(root)) throw new RoomError('INVALID_ROOT', 'Choose an absolute shared directory')
    const mode = roomMode(input.mode)
    this.creating++
    let generated: Awaited<ReturnType<typeof createInvitation>>
    try { generated = await createInvitation(input.relay || this.config.relayUrl) }
    finally { this.creating-- }
    if (this.disposed) throw new RoomError('DISPOSED', 'Remote room plugin was stopped while generating an invitation')
    const { invitation, url } = generated
    const snapshot: RoomSnapshot = { id: invitation.roomId, role: 'host', phase: 'connecting', epoch: randomUUID(), root, mode }
    const room: Room = { snapshot, invitation, controller: new AbortController(), backend: this.createBackend(snapshot.id) }
    this.rooms.set(snapshot.id, room)
    this.start(room)
    return { room: { ...snapshot }, invitation: url }
  }

  async join(invite: string): Promise<RoomSnapshot> {
    this.reserve()
    const invitation = parseInvitation(invite)
    if (this.rooms.has(invitation.roomId)) throw new RoomError('ALREADY_JOINED', 'This instance already owns that room')
    const snapshot: RoomSnapshot = { id: invitation.roomId, role: 'guest', phase: 'connecting', epoch: '' }
    const room: Room = { snapshot, invitation, controller: new AbortController() }
    this.rooms.set(snapshot.id, room)
    this.start(room)
    return { ...snapshot }
  }

  /** Local user control only. This method is never in the guest wire method table. */
  async approve(id: string): Promise<RoomSnapshot> {
    const room = this.get(id)
    const snapshot = room.snapshot
    if (snapshot.role !== 'host' || snapshot.phase !== 'pending' || !room.backend || !room.peerId || !room.rpc || !snapshot.root || !snapshot.mode) throw new RoomError('INVALID_STATE', 'Only an authenticated waiting guest can be approved')
    if (room.approving) throw new RoomError('BUSY', 'Authorization is already in progress')
    room.approving = true
    try {
    const expiresAt = Date.now() + this.config.grantTtlMs
    await room.backend.authorize({ roomId: id, peerId: room.peerId, epoch: snapshot.epoch, root: snapshot.root, mode: snapshot.mode, expiresAt }, room.controller.signal)
    if (room.controller.signal.aborted || snapshot.phase !== 'pending') { await room.backend.revoke('Connection ended during authorization'); throw new RoomError('DISCONNECTED', 'Connection ended during authorization') }
    this.update(room, { phase: 'authorized', expiresAt })
    clearTimeout(room.timer)
    room.timer = setTimeout(() => { void this.end(room, 'closed', 'Authorization expired').catch(() => {}) }, this.config.grantTtlMs)
    room.timer.unref()
    try { await room.rpc.call('control.grant', json({ id, epoch: snapshot.epoch, root: snapshot.root, mode: snapshot.mode, expiresAt }), { signal: room.controller.signal }) }
    catch (error) { await this.end(room, 'failed', 'Guest did not acknowledge authorization'); throw error }
    return { ...room.snapshot }
    } catch (error) {
      await this.end(room, 'failed', 'Room authorization failed').catch(() => {})
      throw error
    } finally { room.approving = false }
  }

  async revoke(id: string): Promise<RoomSnapshot> { const room = this.get(id); await this.end(room, 'closed', 'Access revoked'); return { ...room.snapshot } }
  async close(id: string): Promise<RoomSnapshot> { const room = this.get(id); await this.end(room, 'closed', 'Room closed'); return { ...room.snapshot } }

  async invoke(id: string, epoch: string, method: string, args: Json, signal?: AbortSignal): Promise<Json> {
    const room = this.get(id)
    if (room.snapshot.epoch !== epoch || room.snapshot.phase !== 'authorized') throw new RoomError('NOT_AUTHORIZED', 'The original room authorization is no longer active')
    const combined = signal ? AbortSignal.any([signal, room.controller.signal]) : room.controller.signal
    if (room.snapshot.role === 'guest') {
      if (!room.rpc) throw new RoomError('DISCONNECTED', 'Remote room is disconnected')
      return room.rpc.call(method, args, { signal: combined })
    }
    if (!room.backend || !room.peerId) throw new RoomError('NOT_AUTHORIZED', 'Room is not authorized')
    return room.backend.invoke(method, args, { roomId: id, peerId: room.peerId, epoch, requestId: randomUUID(), signal: combined })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const ended = await Promise.allSettled([...this.rooms.values()].map(room => this.end(room, 'closed', 'Plugin unloaded')))
    await Promise.allSettled([...this.rooms.values()].map(room => room.task))
    this.followers.clear()
    const failures = ended.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Some remote room resources could not confirm cleanup')
  }

  private reserve(): void {
    if (this.disposed) throw new RoomError('DISPOSED', 'Remote room plugin is stopped')
    const live = [...this.rooms.values()].filter(room => !['closed', 'failed'].includes(room.snapshot.phase))
    if (live.length + this.creating >= this.config.maxRooms) throw new RoomError('LIMIT_EXCEEDED', 'Close an existing room first')
    // Closed snapshots contain no secrets; keep only a small bounded history.
    for (const [id, room] of this.rooms) if (this.rooms.size >= this.config.maxRooms * 3 && ['closed', 'failed'].includes(room.snapshot.phase)) this.rooms.delete(id)
  }
  private get(id: string): Room {
    const room = this.rooms.get(text(id, 'room id', 128))
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'Room is not available in this DSH instance')
    return room
  }
  private update(room: Room, value: Partial<RoomSnapshot>): void {
    Object.assign(room.snapshot, value)
    this.revision++
    const state = this.state()
    for (const follower of [...this.followers]) { try { follower(state) } catch { this.followers.delete(follower) } }
  }
  private start(room: Room): void {
    this.update(room, {})
    room.timer = setTimeout(() => { void this.end(room, 'closed', 'Invitation expired').catch(() => {}) }, this.config.invitationTtlMs)
    room.timer.unref()
    room.task = this.connect(room).catch(async error => {
      if (!room.controller.signal.aborted) await this.end(room, 'failed', error instanceof Error ? error.message : 'Connection failed').catch(() => {})
    })
  }
  private async connect(room: Room): Promise<void> {
    const role = room.snapshot.role
    const transport = await connectRelay(room.invitation.relay, room.snapshot.id, role, {
      signal: room.controller.signal,
      ...(role === 'host' ? { hostToken: randomBytes(32).toString('base64url'), ...(this.config.relayCreateToken ? { createToken: this.config.relayCreateToken } : {}) } : {}),
      allowInsecureLoopback: true,
      connectTimeoutMs: Math.min(this.config.invitationTtlMs, 120_000),
    })
    this.update(room, { phase: 'authenticating' })
    const socket: TLSSocket = await authenticateChannel(transport, { role, roomId: room.snapshot.id, credential: room.invitation.credential, timeoutMs: this.config.invitationTtlMs, signal: room.controller.signal })
    if (room.controller.signal.aborted) { socket.destroy(); return }
    room.peerId = socket.exportKeyingMaterial(32, 'dsh-room-peer', Buffer.from(room.snapshot.id)).toString('hex')
    const rpc = new RpcPeer(socket, { ...defaultRpcLimits, timeoutMs: this.config.rpcTimeoutMs })
    room.rpc = rpc
    rpc.onClosed(error => { if (!room.controller.signal.aborted) void this.end(room, 'failed', error.message).catch(() => {}) })
    room.heartbeat = setInterval(() => {
      if (room.heartbeatBusy || room.controller.signal.aborted) return
      room.heartbeatBusy = true
      void rpc.call('control.ping', null, { signal: room.controller.signal, timeoutMs: Math.min(15_000, this.config.rpcTimeoutMs) })
        .catch(() => this.end(room, 'failed', 'Peer heartbeat lost'))
        .catch(() => {})
        .finally(() => { room.heartbeatBusy = false })
    }, 15_000)
    room.heartbeat.unref()
    if (role === 'host') {
      let greeted = false
      rpc.serve(async (method, args, signal) => {
        if (method === 'control.ping') return null
        if (method === 'control.hello') {
          if (greeted) throw new RoomError('INVALID_STATE', 'Peer already introduced')
          const input = object(args)
          if (input.protocol !== 2) throw new RoomError('VERSION_MISMATCH', 'Unsupported remote room protocol')
          greeted = true
          return json({ id: room.snapshot.id, epoch: room.snapshot.epoch, root: room.snapshot.root, mode: room.snapshot.mode })
        }
        if (method === 'control.ready') {
          if (!greeted || room.snapshot.phase !== 'authenticating') throw new RoomError('INVALID_STATE', 'Unexpected ready acknowledgement')
          this.update(room, { phase: 'pending' })
          return null
        }
        if (room.snapshot.phase !== 'authorized' || !room.backend || !room.peerId) throw new RoomError('NOT_AUTHORIZED', 'Wait for the host to approve this connection')
        // Backend owns a strict method whitelist. There is no bridge from this handler to local UI actions.
        return room.backend.invoke(method, args, { roomId: room.snapshot.id, peerId: room.peerId, epoch: room.snapshot.epoch, requestId: randomUUID(), signal: AbortSignal.any([signal, room.controller.signal]) })
      })
    } else {
      rpc.serve(async (method, args) => {
        if (method === 'control.ping') return null
        if (method !== 'control.grant') throw new RoomError('METHOD_NOT_FOUND', 'Host cannot invoke guest local capabilities')
        const input = object(args)
        if (input.id !== room.snapshot.id || input.epoch !== room.snapshot.epoch || room.snapshot.phase !== 'pending') throw new RoomError('INVALID_STATE', 'Unexpected authorization')
        const expiresAt = integer(input.expiresAt, 'expiry', Date.now() + 1, Date.now() + 86_400_000)
        this.update(room, { phase: 'authorized', root: text(input.root, 'shared root'), mode: roomMode(input.mode), expiresAt })
        clearTimeout(room.timer)
        room.timer = setTimeout(() => { void this.end(room, 'closed', 'Authorization expired').catch(() => {}) }, Math.max(1, expiresAt - Date.now()))
        room.timer.unref()
        return null
      })
      const hello = object(await rpc.call('control.hello', { protocol: 2 }, { signal: room.controller.signal }))
      if (hello.id !== room.snapshot.id) throw new RoomError('INVALID_STATE', 'Room identity mismatch')
      this.update(room, { phase: 'pending', epoch: text(hello.epoch, 'connection epoch', 128), root: text(hello.root, 'shared root'), mode: roomMode(hello.mode) })
      await rpc.call('control.ready', null, { signal: room.controller.signal })
    }
  }
  private end(room: Room, phase: 'closed' | 'failed', reason: string): Promise<void> {
    if (room.closing) return room.closing
    room.controller.abort(new RoomError('DISCONNECTED', reason))
    clearTimeout(room.timer)
    clearInterval(room.heartbeat)
    // Strings/native TLS contexts cannot be reliably zeroized; release our references, never persist them.
    room.invitation.credential = { certificate: '', privateKey: '' }
    room.rpc?.close(new RoomError('DISCONNECTED', reason))
    room.closing = (async () => {
      try { await room.backend?.revoke(reason) }
      catch (error) { this.update(room, { phase: 'failed', error: `Resource cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}` }); throw error }
      this.update(room, { phase, error: reason })
    })()
    return room.closing
  }
}
