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

function waitFor(manager: RemoteRoomManager, id: string, phase: RoomSnapshot['phase']): Promise<RoomSnapshot> {
  return new Promise((resolve, reject) => {
    let stop: () => void = () => {}
    let settled = false
    const timer = setTimeout(() => { stop(); reject(new Error(`Room did not reach ${phase}: ${JSON.stringify(manager.state())}`)) }, 8000)
    const changed = (state: RoomState) => {
      const room = state.rooms.find(room => room.id === id)
      if (room?.phase === 'failed') { settled = true; clearTimeout(timer); stop(); reject(new Error(room.error)) ; return }
      if (room?.phase === phase) { settled = true; clearTimeout(timer); stop(); resolve(room) }
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

async function setup(guestConfig = Config({})) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-room-rejoin-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'shared-root')
  await mkdir(root)
  const relay = await startRelay({ host: '127.0.0.1', port: 0 })
  cleanup.push(() => relay.close())
  const host = new RemoteRoomManager(Config({}), () => backend())
  const guest = new RemoteRoomManager(guestConfig, () => { throw new Error('A guest never owns host authority') })
  cleanup.push(() => guest.dispose(), () => host.dispose())
  return { root, host, guest, relay }
}

describe('joining the same invitation again', () => {
  it('replaces the previous guest attempt instead of locking the invitation', async () => {
    const { root, host, guest, relay } = await setup()
    const created = await host.create({ relay: relay.url, root, name: 'rejoin', mode: 'read-only' })
    await guest.join(created.invitation)
    await waitFor(guest, created.room.id, 'pending')

    // The second join is a new attempt at the same room: it must be accepted and it must own the entry.
    const replaced = await guest.join(created.invitation)
    expect(replaced).toMatchObject({ id: created.room.id, role: 'guest', phase: 'connecting' })
    const entries = guest.state().rooms.filter(room => room.id === created.room.id)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.error).not.toBe('Replaced by a new join attempt')
  })

  it('does not count the replaced room against the room budget', async () => {
    const { root, host, guest, relay } = await setup(Config({ maxRooms: 1 }))
    const created = await host.create({ relay: relay.url, root, name: 'budget', mode: 'read-only' })
    await guest.join(created.invitation)
    await waitFor(guest, created.room.id, 'pending')
    // A plain reserve() would report LIMIT_EXCEEDED here; the entry being superseded must not.
    await expect(guest.join(created.invitation)).resolves.toMatchObject({ id: created.room.id, role: 'guest' })
  })

  it('still refuses to join a room this instance hosts', async () => {
    const { root, host, relay } = await setup()
    const created = await host.create({ relay: relay.url, root, name: 'own', mode: 'read-only' })
    await expect(host.join(created.invitation)).rejects.toMatchObject({ code: 'ALREADY_HOST' })
    expect(host.state().rooms).toHaveLength(1)
  })
})
