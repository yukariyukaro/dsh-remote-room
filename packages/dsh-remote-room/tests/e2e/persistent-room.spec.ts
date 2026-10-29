import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startRelay } from '../../relay/src/server.ts'
import { Config } from '../../src/config.ts'
import { RemoteRoomManager, type HostRoomBackend } from '../../src/room-service.ts'
import { type Json, type RoomSnapshot, type RoomState } from '../../src/protocol.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release() })

/** Room lifetime is a product decision, so tests may shrink the attempt window below the schema minimum. */
function config(over: Partial<Config> = {}): Config {
  return { ...Config({}), attemptTtlMs: 2_000, grantTtlMs: 60_000, rpcTimeoutMs: 3_000, ...over }
}

function waitFor(manager: RemoteRoomManager, id: string, phases: RoomSnapshot['phase'][], timeoutMs = 10_000): Promise<RoomSnapshot> {
  return new Promise((resolve, reject) => {
    let stop: () => void = () => {}
    let settled = false
    const timer = setTimeout(() => { stop(); reject(new Error(`Room did not reach ${phases.join('/')}: ${JSON.stringify(manager.state())}`)) }, timeoutMs)
    const changed = (state: RoomState) => {
      const room = state.rooms.find(room => room.id === id)
      if (!room) return
      if (room.phase === 'failed' && !phases.includes('failed')) { settled = true; clearTimeout(timer); stop(); reject(new Error(room.error ?? 'Room failed')); return }
      if (phases.includes(room.phase)) { settled = true; clearTimeout(timer); stop(); resolve(room) }
    }
    stop = manager.subscribe(changed)
    if (settled) stop()
  })
}

function backend(): HostRoomBackend {
  return {
    async authorize() {},
    async invoke(): Promise<Json> { return null },
    async revoke() {},
  }
}

function manager(settings: Config, host = false): RemoteRoomManager {
  const value = new RemoteRoomManager(settings, host ? () => backend() : () => { throw new Error('A guest never owns host authority') })
  cleanup.push(() => value.dispose())
  return value
}

async function setup(over: Partial<Config> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-room-persistent-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'shared-root')
  await mkdir(root)
  const relay = await startRelay({ host: '127.0.0.1', port: 0 })
  cleanup.push(() => relay.close())
  const settings = config(over)
  return { root, relay, settings, host: manager(settings, true) }
}

describe('an invitation lives as long as its room', () => {
  it('stays joinable long after a guest attempt would have expired', async () => {
    const { root, relay, settings, host } = await setup()
    const guest = manager(settings)
    const created = await host.create({ relay: relay.url, root, name: 'persist', mode: 'read-only' })
    await waitFor(host, created.room.id, ['authenticating'])
    // Longer than attemptTtlMs: the old design destroyed the share here.
    await new Promise(resolve => setTimeout(resolve, 2_500))
    expect(host.state().rooms.find(room => room.id === created.room.id)?.phase).toBe('authenticating')

    await guest.join(created.invitation)
    await waitFor(host, created.room.id, ['pending'])
    await host.approve(created.room.id)
    await waitFor(guest, created.room.id, ['authorized'])
  })

  it('survives a guest disappearing and admits the next attempt', async () => {
    const { root, relay, settings, host } = await setup()
    const first = manager(settings)
    const second = manager(settings)
    const created = await host.create({ relay: relay.url, root, name: 'resilient', mode: 'read-only' })
    await waitFor(host, created.room.id, ['authenticating'])
    await first.join(created.invitation)
    await waitFor(host, created.room.id, ['pending'])
    await host.approve(created.room.id)
    await waitFor(first, created.room.id, ['authorized'])

    await first.dispose()
    // The host is not destroyed with its guest: it re-establishes the reservation.
    await waitFor(host, created.room.id, ['connecting', 'authenticating'], 15_000)
    await second.join(created.invitation)
    await waitFor(host, created.room.id, ['pending'])
    await host.approve(created.room.id)
    await waitFor(second, created.room.id, ['authorized'])
  })

  it('dies with the room the host closed', async () => {
    const { root, relay, settings, host } = await setup()
    const guest = manager(settings)
    const created = await host.create({ relay: relay.url, root, name: 'closed', mode: 'read-only' })
    await waitFor(host, created.room.id, ['authenticating'])
    await host.close(created.room.id)
    await waitFor(host, created.room.id, ['closed'])

    await guest.join(created.invitation)
    await waitFor(guest, created.room.id, ['failed'], 15_000)
    expect(host.state().rooms.find(room => room.id === created.room.id)?.phase).toBe('closed')
  })

  it('returns an expired grant to waiting instead of ending the share', async () => {
    const { root, relay, settings, host } = await setup({ grantTtlMs: 1_200 })
    const guest = manager(settings)
    const created = await host.create({ relay: relay.url, root, name: 'grant', mode: 'read-only' })
    await waitFor(host, created.room.id, ['authenticating'])
    await guest.join(created.invitation)
    await waitFor(host, created.room.id, ['pending'])
    await host.approve(created.room.id)
    await waitFor(guest, created.room.id, ['authorized'])

    // Guest access expires; the share, and its invitation, do not.
    await waitFor(host, created.room.id, ['connecting', 'authenticating'], 15_000)
    await waitFor(guest, created.room.id, ['closed', 'failed'], 15_000)
    await guest.join(created.invitation)
    await waitFor(host, created.room.id, ['pending'])
    await host.approve(created.room.id)
    await waitFor(guest, created.room.id, ['authorized'])
  })
})
