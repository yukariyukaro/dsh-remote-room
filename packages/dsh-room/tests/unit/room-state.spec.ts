import { describe, expect, it } from 'vitest'
import { RoomRegistry } from '../../src/room-state.ts'

const limits = {
  invitationTtlMs: 60_000, pendingTtlMs: 60_000,
  sessionIdleTtlMs: 60_000, sessionMaxTtlMs: 600_000,
  maxPending: 2, maxMembers: 2,
}

function opened(): { registry: RoomRegistry; clock: { now: number } } {
  const clock = { now: 1_000_000 }
  const registry = new RoomRegistry(limits, () => clock.now)
  registry.open({ host: '127.0.0.1', port: 19_443, secure: false })
  return { registry, clock }
}

describe('room registry', () => {
  it('refuses invitations while closed', () => {
    const registry = new RoomRegistry(limits)
    expect(() => registry.invite()).toThrowError(/No room is open/)
    expect(registry.authenticate('anything')).toBeUndefined()
  })

  it('consumes an invitation exactly once', () => {
    const { registry } = opened()
    const { token } = registry.invite()
    registry.request(token, '192.168.1.9', 'guest')
    expect(() => registry.request(token, '192.168.1.9', 'guest')).toThrowError(/no longer valid/)
  })

  it('rejects an expired invitation', () => {
    const { registry, clock } = opened()
    const { token } = registry.invite()
    clock.now += 60_001
    expect(() => registry.request(token, '192.168.1.9', '')).toThrowError(/no longer valid/)
  })

  it('issues a session token only after approval, and only once', () => {
    const { registry } = opened()
    const { token } = registry.invite()
    const { requestId, pollSecret } = registry.request(token, '192.168.1.9', 'guest')
    expect(registry.poll(requestId, pollSecret).phase).toBe('pending')
    registry.approve(requestId)
    const approved = registry.poll(requestId, pollSecret)
    expect(approved.phase).toBe('approved')
    expect(typeof approved.ticket).toBe('string')
    // The ticket is single use and redeems into the session token.
    const session = registry.redeem(approved.ticket ?? '')
    expect(typeof session).toBe('string')
    expect(registry.authenticate(session ?? '')).toBeDefined()
    expect(registry.redeem(approved.ticket ?? '')).toBeUndefined()
    // The waiting page can no longer mint a second token for the same request.
    expect(() => registry.poll(requestId, pollSecret)).toThrowError(/Unknown or expired/)
  })

  it('refuses a poll secret that does not match', () => {
    const { registry } = opened()
    const { token } = registry.invite()
    const { requestId } = registry.request(token, '192.168.1.9', '')
    expect(() => registry.poll(requestId, 'wrong-secret')).toThrowError(/Unknown or expired/)
  })

  it('revokes a kicked member immediately', () => {
    const { registry } = opened()
    const { token } = registry.invite()
    const { requestId, pollSecret } = registry.request(token, '192.168.1.9', '')
    const member = registry.approve(requestId)
    const session = registry.redeem(registry.poll(requestId, pollSecret).ticket ?? '') ?? ''
    expect(registry.authenticate(session)).toBeDefined()
    registry.kick(member.id)
    expect(registry.authenticate(session)).toBeUndefined()
  })

  it('expires idle sessions', () => {
    const { registry, clock } = opened()
    const { token } = registry.invite()
    const { requestId, pollSecret } = registry.request(token, '192.168.1.9', '')
    registry.approve(requestId)
    const session = registry.redeem(registry.poll(requestId, pollSecret).ticket ?? '') ?? ''
    clock.now += 60_001
    expect(registry.authenticate(session)).toBeUndefined()
  })

  it('bounds pending requests and members', () => {
    const { registry } = opened()
    const first = registry.invite()
    const a = registry.request(first.token, '192.168.1.1', '')
    registry.invite()
    const second = registry.invite()
    const b = registry.request(second.token, '192.168.1.2', '')
    registry.invite()
    const third = registry.invite()
    expect(() => registry.request(third.token, '192.168.1.3', '')).toThrowError(/Too many requests/)
    registry.approve(a.requestId)
    registry.approve(b.requestId)
    registry.invite()
    const fourth = registry.invite()
    const c = registry.request(fourth.token, '192.168.1.4', '')
    expect(() => registry.approve(c.requestId)).toThrowError(/Member limit/)
  })
})