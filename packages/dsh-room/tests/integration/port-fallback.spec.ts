import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RoomRegistry } from '../../src/room-state.ts'
import { RoomService } from '../../src/service.ts'
import type { Config } from '../../src/config.ts'

const limits = { invitationTtlMs: 60_000, pendingTtlMs: 60_000, sessionIdleTtlMs: 60_000, sessionMaxTtlMs: 600_000, maxPending: 4, maxMembers: 4 }
const config = (port: number): Config => ({
  listenHost: '127.0.0.1', listenPort: port,
  invitationTtlMs: 60_000, pendingTtlMs: 60_000,
  sessionIdleTtlMs: 60_000, sessionMaxTtlMs: 600_000,
  maxPending: 4, maxMembers: 4,
  allowedCidrs: [], authorityAliases: [],
  tlsCertFile: '', tlsKeyFile: '',
  relayEnabled: false, relayUrl: '', relayRoom: '', relaySecret: '', relayPublicAuthority: '', relayPublicUrl: '',
})

let blocker: net.Server | undefined

beforeEach(async () => {
  blocker = net.createServer(socket => socket.destroy())
  await new Promise<void>(resolve => blocker?.listen(0, '127.0.0.1', () => resolve()))
})

afterEach(async () => {
  await new Promise<void>(resolve => (blocker ? blocker.close(() => resolve()) : resolve()))
  blocker = undefined
})

const build = (port: number): RoomService => {
  const registry = new RoomRegistry(limits)
  return new RoomService(registry, config(port), () => ({
    host: '127.0.0.1', port: 1, secure: false, origin: 'http://127.0.0.1:1',
    authenticatedUrl: () => 'http://127.0.0.1:1/',
  }), () => {})
}

describe('port selection', () => {
  it('takes another port when the configured one is busy', async () => {
    const busy = (blocker?.address() as AddressInfo).port
    const service = build(busy)
    const snapshot = await service.open()
    expect(snapshot.phase).toBe('open')
    expect(service.current?.port).not.toBe(busy)
    expect(service.info).toContain('已被占用')
    await service.dispose()
  })

  it('uses the configured port when it is free', async () => {
    const probe = net.createServer()
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', () => resolve()))
    const free = (probe.address() as AddressInfo).port
    await new Promise<void>(resolve => probe.close(() => resolve()))
    const service = build(free)
    const snapshot = await service.open()
    expect(snapshot.phase).toBe('open')
    expect(service.current?.port).toBe(free)
    await service.dispose()
  })
})
