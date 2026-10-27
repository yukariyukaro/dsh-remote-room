/**
 * Verifies a deployed public relay over its real wss endpoint. Skipped unless a
 * relay address and creation token are available, because the deployment belongs
 * to whoever operates the relay. Both names work: RR_PUBLIC_RELAY/RR_RELAY_TOKEN
 * for the test run, DSH_REMOTE_ROOM_RELAY/DSH_REMOTE_ROOM_RELAY_TOKEN for the
 * plugin itself, and a local `.env` is loaded when present.
 */
import { describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Config } from '../../src/config.ts'
import { RemoteRoomManager, type HostRoomBackend } from '../../src/room-service.ts'
import { resolveShare } from '../../src/share.ts'
import { DEFAULT_SETTINGS, type ShareSettings } from '../../src/host/settings.ts'
import { validateRelay } from '../../src/invite.ts'
import { RoomError, type Json } from '../../src/protocol.ts'

// A checked-out repository may carry a local .env; the test never writes one.
try { process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url))) } catch { /* .env is optional */ }

const relay = process.env.RR_PUBLIC_RELAY ?? process.env.DSH_REMOTE_ROOM_RELAY ?? ''
const token = process.env.RR_RELAY_TOKEN ?? process.env.DSH_REMOTE_ROOM_RELAY_TOKEN ?? ''
const config = Config({})

function settings(): { current(): ShareSettings; update(patch: Partial<Omit<ShareSettings, 'version'>>): Promise<ShareSettings> } {
  let value: ShareSettings = { ...DEFAULT_SETTINGS, scope: 'public', relayUrl: relay, relayCreateToken: token }
  return {
    current: () => ({ ...value }),
    update: async patch => { value = { ...value, ...patch }; return { ...value } },
  }
}

function backend(): HostRoomBackend {
  return {
    async authorize() {},
    async invoke(method: string): Promise<Json> {
      if (method === 'fs.readText') return { text: 'PUBLIC_RELAY_OK' }
      throw new RoomError('METHOD_NOT_FOUND', 'Unsupported remote operation')
    },
    async revoke() {},
  }
}

describe.skipIf(relay === '' || token === '')('deployed public relay', () => {
  it('pairs both ends over wss, authenticates, and authorizes one call', async () => {
    expect(validateRelay(relay)).toBe(relay)
    const root = await mkdtemp(path.join(os.tmpdir(), 'rr-public-'))
    const host = new RemoteRoomManager(config, () => backend())
    const guest = new RemoteRoomManager(config, () => { throw new Error('A guest never owns host authority') })
    try {
      const target = await resolveShare({ root, scope: 'public', relay }, {
        settings: settings(),
        relays: { endpoint: async () => { throw new Error('A public share must not start a local relay') } },
        config,
        stat: async () => ({ isDirectory: () => true }),
      })
      expect(target.relay).toBe(relay)
      expect(target.createToken).toBe(token)

      const created = await host.create(target)
      await vi.waitFor(() => expect(host.state().rooms[0]?.phase).toBe('authenticating'), { timeout: 20_000, interval: 100 })
      await guest.join(created.invitation)
      let epoch = ''
      await vi.waitFor(() => {
        const room = guest.state().rooms[0]
        expect(room?.phase).toBe('pending')
        epoch = room?.epoch ?? ''
      }, { timeout: 20_000, interval: 100 })
      // The host sees the same guest as pending only after its own ready handshake settles.
      await vi.waitFor(() => expect(host.state().rooms[0]?.phase).toBe('pending'), { timeout: 20_000, interval: 100 })
      await host.approve(created.room.id)
      await vi.waitFor(() => expect(guest.state().rooms[0]?.phase).toBe('authorized'), { timeout: 20_000, interval: 100 })
      await expect(guest.invoke(created.room.id, epoch, 'fs.readText', { path: 'a.txt' })).resolves.toEqual({ text: 'PUBLIC_RELAY_OK' })
    } finally {
      await host.dispose().catch(() => {})
      await guest.dispose().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
