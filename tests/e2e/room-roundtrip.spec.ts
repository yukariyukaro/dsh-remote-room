import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startRelay } from '../../relay/src/server.ts'
import { Config } from '../../src/config.ts'
import { RemoteRoomManager } from '../../src/room-service.ts'
import { FileRoomBackend } from '../../src/host/backend.ts'
import { BoundedMemoryAuditStore } from '../../src/host/audit-store.ts'
import { object, type RoomSnapshot, type RoomState } from '../../src/protocol.ts'

const require = createRequire(import.meta.url)
const policyRequire = createRequire(require.resolve('@deepseek-ai/dsh-sandbox-policy'))
const { SessionProjectionRegistry } = await import(policyRequire.resolve('@deepseek-ai/dsh-session-projection'))
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release() })

function waitFor(manager: RemoteRoomManager, id: string, phase: RoomSnapshot['phase']): Promise<RoomSnapshot> {
  return new Promise((resolve, reject) => {
    let stop: () => void = () => {}
    let settled = false
    const timer = setTimeout(() => { stop(); reject(new Error(`Room did not reach ${phase}: ${JSON.stringify(manager.state())}`)) }, 8000)
    const changed = (state: RoomState) => {
      const room = state.rooms.find(room => room.id === id)
      if (room?.phase === 'failed') { settled = true; clearTimeout(timer); stop(); reject(new Error(room.error)); return }
      if (room?.phase === phase) { settled = true; clearTimeout(timer); stop(); resolve(room) }
    }
    stop = manager.subscribe(changed)
    if (settled) stop()
  })
}
async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-room-roundtrip-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'host-root')
  await mkdir(root)
  await writeFile(path.join(root, 'remote.txt'), 'HOST_SENTINEL\n你好🙂\n')
  const outside = path.join(directory, 'secret.txt')
  await writeFile(outside, 'OUTSIDE_SENTINEL')
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: directory })
  await ctx.plugin(SandboxedFileSystem, { cwd: directory })
  cleanup.push(() => ctx.fiber.dispose())
  const audit = new BoundedMemoryAuditStore()
  cleanup.push(() => audit.close())
  const relay = await startRelay({ host: '127.0.0.1', port: 0 })
  cleanup.push(() => relay.close())
  const config = Config({ invitationTtlMs: 30_000, grantTtlMs: 30_000, rpcTimeoutMs: 3000 })
  const host = new RemoteRoomManager(config, () => new FileRoomBackend(ctx.fs, audit, config))
  const guest = new RemoteRoomManager(config, () => { throw new Error('Guest must not allocate host capabilities') })
  cleanup.push(() => guest.dispose(), () => host.dispose())
  return { root, outside, host, guest, relay, audit }
}

describe('two real room endpoints over a WebSocket relay / TLS PSK / RPC / DSH fs', () => {
  it('requires one host grant, reads/writes only on host, keeps roots fenced and revokes without fallback', async () => {
    const { root, outside, host, guest, relay, audit } = await setup()
    const created = await host.create({ relay: relay.url, root, mode: 'workspace-write' })
    await waitFor(host, created.room.id, 'authenticating')
    await guest.join(created.invitation)
    await waitFor(host, created.room.id, 'pending')
    const waiting = await waitFor(guest, created.room.id, 'pending')
    await expect(guest.invoke(waiting.id, waiting.epoch, 'fs.readText', { path: 'remote.txt' })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    await host.approve(waiting.id)
    const connected = await waitFor(guest, waiting.id, 'authorized')
    expect(connected.epoch).toBe(created.room.epoch)
    expect(await guest.invoke(connected.id, connected.epoch, 'fs.readText', { path: 'remote.txt' })).toEqual({ text: 'HOST_SENTINEL\n你好🙂\n' })
    await expect(guest.invoke(connected.id, connected.epoch, 'fs.readText', { path: outside, mode: 'danger-full-access' })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(guest.invoke(connected.id, connected.epoch, 'approve', {})).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' })
    const written = object(await guest.invoke(connected.id, connected.epoch, 'fs.writeText', { path: 'new.txt', content: 'REMOTE_WRITE', expected: { kind: 'createIfAbsent' } }))
    expect(written.operation).toBe('create')
    expect(await readFile(path.join(root, 'new.txt'), 'utf8')).toBe('REMOTE_WRITE')
    const page = await audit.query({ roomId: connected.id, limit: 200 })
    expect(page.entries.some(entry => entry.status === 'granted')).toBe(true)
    expect(page.entries.some(entry => entry.operation === 'writeText' && entry.status === 'success')).toBe(true)
    await host.revoke(connected.id)
    await expect(guest.invoke(connected.id, connected.epoch, 'fs.writeText', { path: 'new.txt', content: 'REPLAY' })).rejects.toBeInstanceOf(Error)
    expect(await readFile(path.join(root, 'new.txt'), 'utf8')).toBe('REMOTE_WRITE')
    expect(await readFile(outside, 'utf8')).toBe('OUTSIDE_SENTINEL')
  })

  it('keeps simultaneous room roots and connection identities separate', async () => {
    const { root, host, guest, relay } = await setup()
    const second = path.join(path.dirname(root), 'second-root'); await mkdir(second)
    await writeFile(path.join(second, 'remote.txt'), 'SECOND_HOST')
    const first = await host.create({ relay: relay.url, root, mode: 'read-only' })
    const other = await host.create({ relay: relay.url, root: second, mode: 'read-only' })
    await Promise.all([waitFor(host, first.room.id, 'authenticating'), waitFor(host, other.room.id, 'authenticating')])
    await guest.join(first.invitation); await guest.join(other.invitation)
    await Promise.all([waitFor(host, first.room.id, 'pending'), waitFor(host, other.room.id, 'pending')])
    await host.approve(first.room.id); await host.approve(other.room.id)
    const a = await waitFor(guest, first.room.id, 'authorized')
    const b = await waitFor(guest, other.room.id, 'authorized')
    expect(await guest.invoke(a.id, a.epoch, 'fs.readText', { path: 'remote.txt' })).toMatchObject({ text: 'HOST_SENTINEL\n你好🙂\n' })
    expect(await guest.invoke(b.id, b.epoch, 'fs.readText', { path: 'remote.txt' })).toMatchObject({ text: 'SECOND_HOST' })
    await expect(guest.invoke(a.id, b.epoch, 'fs.readText', { path: 'remote.txt' })).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    await expect(guest.invoke(a.id, a.epoch, 'fs.writeText', { path: 'remote.txt', content: 'BAD' })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })
})
