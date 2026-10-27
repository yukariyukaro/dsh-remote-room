/** Room lifetime, invitations, pending approvals and member sessions. Pure state: no sockets, no disk. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export type RoomPhase = 'closed' | 'open'
export type JoinPhase = 'pending' | 'approved' | 'denied' | 'expired'

export interface Listener { readonly host: string; readonly port: number; readonly secure: boolean }

export interface PendingView {
  id: string
  address: string
  label: string
  phase: JoinPhase
  requestedAt: number
}

export interface MemberView {
  id: string
  address: string
  label: string
  joinedAt: number
  lastSeenAt: number
}

export interface RoomSnapshot {
  phase: RoomPhase
  roomId: string
  epoch: string
  openedAt: number
  listener?: Listener
  invitation?: { expiresAt: number }
  pending: PendingView[]
  members: MemberView[]
}

interface Invitation { hash: string; expiresAt: number; used: boolean }
interface Pending { id: string; pollHash: string; address: string; label: string; phase: JoinPhase; requestedAt: number; sessionId?: string }
interface Member { id: string; tokenHash: string; address: string; label: string; joinedAt: number; lastSeenAt: number; expiresAt: number; revoked: boolean }

export interface RoomLimits {
  invitationTtlMs: number
  sessionIdleTtlMs: number
  sessionMaxTtlMs: number
  pendingTtlMs: number
  maxPending: number
  maxMembers: number
}

export class RoomError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'RoomError' }
}

const digest = (value: string): string => createHash('sha256').update(value).digest('base64url')
const secret = (bytes = 32): string => randomBytes(bytes).toString('base64url')

/** Constant-time comparison of two secrets through their digests. */
function sameSecret(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(digest(value), 'utf8')
  const wanted = Buffer.from(expectedHash, 'utf8')
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

export class RoomRegistry {
  private phase: RoomPhase = 'closed'
  private roomId = ''
  private epoch = ''
  private openedAt = 0
  private listener: Listener | undefined
  private invitation: Invitation | undefined
  private readonly pending = new Map<string, Pending>()
  private readonly members = new Map<string, Member>()
  /** One-time handoff tickets: the waiting page exchanges one for a cookie on a top-level navigation. */
  private readonly tickets = new Map<string, { token: string; expiresAt: number }>()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly limits: RoomLimits, private readonly now: () => number = Date.now) {}

  /** Observe room changes; the UI bridge forwards these to event streams. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener()
  }

  get listenerInfo(): Listener | undefined { return this.listener }

  open(listener: Listener): RoomSnapshot {
    if (this.phase === 'open') throw new RoomError('ROOM_ALREADY_OPEN', 'A room is already open')
    this.phase = 'open'
    this.roomId = randomBytes(8).toString('hex')
    this.epoch = randomBytes(12).toString('base64url')
    this.openedAt = this.now()
    this.listener = listener
    this.invitation = undefined
    this.pending.clear()
    this.members.clear()
    this.changed()
    return this.snapshot()
  }

  close(): RoomSnapshot {
    this.phase = 'closed'
    this.listener = undefined
    this.invitation = undefined
    this.pending.clear()
    this.members.clear()
    this.tickets.clear()
    this.changed()
    return this.snapshot()
  }

  /** Mint a fresh single-use invitation, replacing the previous one. The raw token never leaves this call. */
  invite(): { token: string; expiresAt: number } {
    this.requireOpen()
    const token = secret(32)
    const expiresAt = this.now() + this.limits.invitationTtlMs
    this.invitation = { hash: digest(token), expiresAt, used: false }
    this.changed()
    return { token, expiresAt }
  }

  /** Present an invitation: consumes it and opens one pending request bound to a polling secret. */
  request(token: string, address: string, label: string): { requestId: string; pollSecret: string } {
    this.requireOpen()
    this.prune()
    const invitation = this.invitation
    if (invitation === undefined || invitation.used || invitation.expiresAt <= this.now()) throw new RoomError('INVITATION_INVALID', 'This invitation is no longer valid')
    if (!sameSecret(token, invitation.hash)) throw new RoomError('INVITATION_INVALID', 'This invitation is no longer valid')
    const waiting = [...this.pending.values()].filter(value => value.phase === 'pending').length
    if (waiting >= this.limits.maxPending) throw new RoomError('ROOM_BUSY', 'Too many requests are waiting for approval')
    invitation.used = true
    const pollSecret = secret(32)
    const pending: Pending = { id: randomBytes(9).toString('base64url'), pollHash: digest(pollSecret), address, label, phase: 'pending', requestedAt: this.now() }
    this.pending.set(pending.id, pending)
    this.changed()
    return { requestId: pending.id, pollSecret }
  }

  /** Resolve a waiting page: returns approved credentials exactly once per approved request. */
  poll(requestId: string, pollSecret: string): { phase: JoinPhase; ticket?: string } {
    this.prune()
    const pending = this.pending.get(requestId)
    if (pending === undefined || !sameSecret(pollSecret, pending.pollHash)) throw new RoomError('REQUEST_UNKNOWN', 'Unknown or expired join request')
    if (pending.phase === 'pending') return { phase: 'pending' }
    if (pending.phase !== 'approved') return { phase: pending.phase }
    const member = pending.sessionId === undefined ? undefined : this.members.get(pending.sessionId)
    if (member === undefined) return { phase: 'expired' }
    const token = secret(32)
    member.tokenHash = digest(token)
    member.lastSeenAt = this.now()
    pending.phase = 'approved'
    // The waiting page owns this session now; later polls cannot mint another token.
    this.pending.delete(requestId)
    const ticket = secret(24)
    this.tickets.set(ticket, { token, expiresAt: this.now() + 60_000 })
    this.changed()
    return { phase: 'approved', ticket }
  }

  approve(requestId: string, label?: string): MemberView {
    this.requireOpen()
    // Revoked or expired members must not keep occupying a slot.
    this.prune()
    const pending = this.pending.get(requestId)
    if (pending === undefined) throw new RoomError('REQUEST_UNKNOWN', 'Unknown or expired join request')
    if (pending.phase !== 'pending') throw new RoomError('REQUEST_SETTLED', 'This request was already settled')
    if (this.members.size >= this.limits.maxMembers) throw new RoomError('ROOM_BUSY', 'Member limit reached')
    const now = this.now()
    const member: Member = {
      id: randomBytes(9).toString('base64url'),
      tokenHash: digest(secret(32)),
      address: pending.address,
      label: label?.trim() || pending.label,
      joinedAt: now,
      lastSeenAt: now,
      expiresAt: now + this.limits.sessionMaxTtlMs,
      revoked: false,
    }
    this.members.set(member.id, member)
    pending.phase = 'approved'
    pending.sessionId = member.id
    this.changed()
    return this.view(member)
  }

  deny(requestId: string): void {
    const pending = this.pending.get(requestId)
    if (pending === undefined) throw new RoomError('REQUEST_UNKNOWN', 'Unknown or expired join request')
    pending.phase = 'denied'
    this.changed()
  }

  /** Validate a member session cookie. Failure is a plain undefined, never a distinct error. */
  authenticate(token: string): MemberView | undefined {
    if (this.phase !== 'open') return undefined
    for (const member of this.members.values()) {
      if (member.revoked) continue
      if (!sameSecret(token, member.tokenHash)) continue
      const now = this.now()
      if (member.expiresAt <= now || now - member.lastSeenAt > this.limits.sessionIdleTtlMs) {
        member.revoked = true
        this.changed()
        return undefined
      }
      member.lastSeenAt = now
      return this.view(member)
    }
    return undefined
  }

  /** Exchange a handoff ticket for the session token. Single use: the entry is removed on read. */
  redeem(ticket: string): string | undefined {
    const entry = this.tickets.get(ticket)
    if (entry === undefined) return undefined
    this.tickets.delete(ticket)
    if (entry.expiresAt <= this.now()) return undefined
    return entry.token
  }

  kick(memberId: string): void {
    const member = this.members.get(memberId)
    if (member === undefined) throw new RoomError('MEMBER_UNKNOWN', 'Unknown member')
    member.revoked = true
    this.changed()
  }

  isRevoked(memberId: string): boolean {
    const member = this.members.get(memberId)
    return member === undefined || member.revoked
  }

  /** A live member: present, not revoked, inside both the idle and absolute limits. */
  isMemberActive(memberId: string): boolean {
    const member = this.members.get(memberId)
    if (member === undefined || member.revoked) return false
    const now = this.now()
    return member.expiresAt > now && now - member.lastSeenAt <= this.limits.sessionIdleTtlMs
  }

  snapshot(): RoomSnapshot {
    this.prune()
    const snapshot: RoomSnapshot = {
      phase: this.phase,
      roomId: this.roomId,
      epoch: this.epoch,
      openedAt: this.openedAt,
      pending: [...this.pending.values()].filter(value => value.phase === 'pending').map(value => ({ ...this.pendingView(value) })),
      members: [...this.members.values()].filter(value => !value.revoked).map(value => this.view(value)),
    }
    if (this.listener !== undefined) snapshot.listener = { ...this.listener }
    if (this.invitation !== undefined && !this.invitation.used && this.invitation.expiresAt > this.now()) snapshot.invitation = { expiresAt: this.invitation.expiresAt }
    return snapshot
  }

  private requireOpen(): void {
    if (this.phase !== 'open') throw new RoomError('ROOM_CLOSED', 'No room is open')
  }

  private view(member: Member): MemberView {
    return { id: member.id, address: member.address, label: member.label, joinedAt: member.joinedAt, lastSeenAt: member.lastSeenAt }
  }

  private pendingView(pending: Pending): PendingView {
    return { id: pending.id, address: pending.address, label: pending.label, phase: pending.phase, requestedAt: pending.requestedAt }
  }

  private prune(): void {
    const now = this.now()
    for (const [id, pending] of this.pending) {
      if (pending.phase === 'pending' && now - pending.requestedAt > this.limits.pendingTtlMs) {
        // Denied requests stay visible briefly so the waiting page learns the outcome.
        pending.phase = 'expired'
      }
      if (pending.phase !== 'pending' && now - pending.requestedAt > this.limits.pendingTtlMs) this.pending.delete(id)
    }
    for (const [id, member] of this.members) {
      if (member.revoked || member.expiresAt <= now || now - member.lastSeenAt > this.limits.sessionIdleTtlMs) this.members.delete(id)
    }
    for (const [id, entry] of this.tickets) {
      if (entry.expiresAt <= now) this.tickets.delete(id)
    }
  }
}
