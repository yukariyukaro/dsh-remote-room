import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Config } from '../../src/config.ts'
import { RemoteRoomManager, type HostRoomBackend } from '../../src/room-service.ts'
import { RelayHost } from '../../src/host/relay-host.ts'
import { resolveShare } from '../../src/share.ts'
import { DEFAULT_SETTINGS, type ShareSettings } from '../../src/host/settings.ts'
import { RoomError, type Json, type RoomState } from '../../src/protocol.ts'
import { startRelay } from '../../relay/src/server.js'

const config = Config({})
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function inMemorySettings(initial: Partial<ShareSettings> = {}) {
  let value: ShareSettings = { ...DEFAULT_SETTINGS, ...initial }
  return {
    current: () => ({ ...value }),
    update: async (patch: Partial<Omit<ShareSettings, 'version'>>) => { value = { ...value, ...patch }; return { ...value } },
  }
}

/** Only the methods this acceptance path calls; the real backend owns the full whitelist. */
function sharedBackend(): HostRoomBackend {
  return {
    async authorize() {},
    async invoke(method: string): Promise<Json> {
      if (method === 'fs.list') return [{ name: 'a.txt', type: 'file', target: { targetKey: 'a', displayPath: 'a.txt' } }]
      if (method === 'fs.readText') return { text: 'SHARED_FROM_HOST' }
      throw new RoomError('METHOD_NOT_FOUND', 'Unsupported remote operation')
    },
    async revoke() {},
  }
}

async function waitFor(manager: RemoteRoomManager, id: string, phase: string): Promise<RoomState['rooms'][number]> {
  let found: RoomState['rooms'][number] | undefined
  await vi.waitFor(() => {
    found = manager.state().rooms.find(room => room.id === id)
    expect(found?.phase, JSON.stringify(manager.state())).toBe(phase)
  }, { timeout: 10_000, interval: 30 })
  return found!
}

describe('one-click share pipeline over a real relay and TLS channel', () => {
  it('derives relay and room name from the directory, then authorizes nothing until the host approves', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rr-share-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const relays = new RelayHost(async () => ({ startRelay }))
    const host = new RemoteRoomManager(config, () => sharedBackend())
    const guest = new RemoteRoomManager(config, () => { throw new Error('A guest never owns host authority') })
    cleanups.push(() => guest.dispose(), () => host.dispose(), () => relays.dispose())

    const target = await resolveShare({ root }, { settings: inMemorySettings(), relays, config })
    expect(target.relay).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
    expect(target.createToken).toBeTruthy()

    const created = await host.create(target)
    expect(created.room).toMatchObject({ name: path.basename(root), mode: 'workspace-write', relayKind: 'local', root })
    await waitFor(host, created.room.id, 'authenticating')
    await guest.join(created.invitation)
    const waiting = await waitFor(guest, created.room.id, 'pending')
    expect(waiting).toMatchObject({ name: path.basename(root), root, mode: 'workspace-write' })
    await expect(guest.invoke(waiting.id, waiting.epoch, 'fs.readText', { path: 'a.txt' })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })

    await host.approve(waiting.id)
    const authorized = await waitFor(guest, created.room.id, 'authorized')
    expect(await guest.invoke(authorized.id, authorized.epoch, 'fs.list', { path: '.' })).toEqual([
      { name: 'a.txt', type: 'file', target: { targetKey: 'a', displayPath: 'a.txt' } },
    ])
    expect(await guest.invoke(authorized.id, authorized.epoch, 'fs.readText', { path: 'a.txt' })).toEqual({ text: 'SHARED_FROM_HOST' })
  })

  it('reuses the remembered directory and reach for the next share', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'rr-share-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const settings = inMemorySettings()
    const relays = new RelayHost(async () => ({ startRelay }))
    cleanups.push(() => relays.dispose())
    const first = await resolveShare({ root }, { settings, relays, config })
    const second = await resolveShare({}, { settings, relays, config })
    expect(second).toMatchObject({ root: first.root, name: first.name, scope: first.scope, relay: first.relay })
    expect(settings.current().lastRoot).toBe(first.root)
  })
})
