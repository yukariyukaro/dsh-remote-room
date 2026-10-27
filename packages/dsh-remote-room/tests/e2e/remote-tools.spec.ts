import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool, type ToolExecutionInput, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { startRelay } from '../../relay/src/server.ts'
import { registerRemoteTools } from '../../src/guest/tools.ts'
import { RemoteRoomManager } from '../../src/room-service.ts'
import { FileRoomBackend } from '../../src/host/backend.ts'
import { BoundedMemoryAuditStore } from '../../src/host/audit-store.ts'
import { Config, type Config as RoomConfig } from '../../src/config.ts'
import { object } from '../../src/protocol.ts'

try { process.loadEnvFile(new URL('../../.env', import.meta.url)) } catch { /* .env is optional */ }
const publicRelay = process.env.RR_PUBLIC_RELAY ?? process.env.DSH_REMOTE_ROOM_RELAY ?? ''
const publicToken = process.env.RR_RELAY_TOKEN ?? process.env.DSH_REMOTE_ROOM_RELAY_TOKEN ?? ''
// A public relay is a network round trip; the fixture is a local socket.
const WAIT = publicRelay === '' ? 5_000 : 30_000

const require = createRequire(import.meta.url)
const toolsRequire = createRequire(require.resolve('@deepseek-ai/dsh-tools'))
const policyRequire = createRequire(require.resolve('@deepseek-ai/dsh-sandbox-policy'))
const { SystemPrompt } = await import(toolsRequire.resolve('@deepseek-ai/dsh-system-prompt'))
const { SessionProjectionRegistry } = await import(policyRequire.resolve('@deepseek-ai/dsh-session-projection'))

function value(result: ToolExecutionResult): Record<string, unknown> {
  expect(result.isError, JSON.stringify(result)).toBe(false)
  if (result.isError) throw new Error(result.error.message)
  return object(result.value)
}
function data(result: ToolExecutionResult) { return object(value(result).data) }
function code(result: ToolExecutionResult) {
  expect(result.isError, JSON.stringify(result)).toBe(true)
  return result.isError ? result.error.info?.code : undefined
}

// Actual end-to-end boundary: ToolRuntime.execute -> guest manager -> authenticated
// TLS/RPC over real WebSocket relay -> host manager -> FileRoomBackend -> real
// Cordis sandbox policy/local filesystem. No mock manager/registry/filesystem.
describe('remote tools / real registry and two-end remote file capability', () => {
  let directory: string
  let root: string
  let local: string
  let hostCtx: Context
  let guestCtx: Context
  let host: RemoteRoomManager
  let guest: RemoteRoomManager
  let backend: FileRoomBackend
  let audit: BoundedMemoryAuditStore
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined
  let relayUrl = ''
  let disposeTools: () => void
  let roomId: string
  let epoch: string
  let input: { roomId: string; epoch: string; path: string }
  const call = (name: string, args: unknown, overrides: Partial<ToolExecutionInput> = {}) => guestCtx.tools.execute({
    callId: randomUUID() as ToolExecutionInput['callId'], name, arguments: args, signal: new AbortController().signal, ...overrides,
  })
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'dsh-remote-tools-'))
    root = path.join(directory, 'host')
    local = path.join(directory, 'guest-local')
    await mkdir(root); await mkdir(local)
    await writeFile(path.join(root, 'same.txt'), 'HOST 世界🙂\nsecond\nthird')
    await writeFile(path.join(local, 'same.txt'), 'LOCAL SENTINEL')
    hostCtx = new Context()
    await hostCtx.plugin(SessionProjectionRegistry)
    await hostCtx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: directory })
    await hostCtx.plugin(SandboxedFileSystem, { cwd: root })
    guestCtx = new Context()
    await guestCtx.plugin(SystemPrompt)
    await guestCtx.plugin(ToolRuntime)
    await guestCtx.plugin(SessionProjectionRegistry)
    await guestCtx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: local })
    await guestCtx.plugin(SandboxedFileSystem, { cwd: local })
    // Default: a loopback fixture. With RR_PUBLIC_RELAY set, the same suite runs over the
    // deployed public relay, so real writes cross Cloudflare instead of the local socket.
    relay = publicRelay === '' ? await startRelay({ host: '127.0.0.1', port: 0 }) : undefined
    relayUrl = publicRelay !== '' ? publicRelay : relay!.url
    const config = Config({ relayUrl, maxFileBytes: 8 * 1024 * 1024 }) as RoomConfig
    audit = new BoundedMemoryAuditStore()
    host = new RemoteRoomManager(config, () => {
      backend = new FileRoomBackend(hostCtx.fs, audit, config)
      return backend
    })
    guest = new RemoteRoomManager(config, () => { throw new Error('Guest must never instantiate host authority') })
    disposeTools = registerRemoteTools(guestCtx, guest)
    const created = await host.create({ relay: relayUrl, ...(publicToken === '' ? {} : { createToken: publicToken }), root, name: 'test', mode: 'workspace-write' })
    roomId = created.room.id
    await vi.waitFor(() => expect(host.state().rooms[0]?.phase, JSON.stringify(host.state())).toBe('authenticating'), { timeout: WAIT })
    await guest.join(created.invitation)
    await vi.waitFor(() => expect(host.state().rooms[0]?.phase).toBe('pending'), { timeout: WAIT })
    await host.approve(roomId)
    await vi.waitFor(() => expect(guest.state().rooms[0]?.phase).toBe('authorized'), { timeout: WAIT })
    epoch = guest.state().rooms[0]!.epoch
    input = { roomId, epoch, path: path.join(root, 'same.txt') }
  })
  afterEach(async () => {
    disposeTools?.()
    await guest?.dispose(); await host?.dispose()
    await audit?.close()
    await guestCtx?.fiber.dispose(); await hostCtx?.fiber.dispose()
    await relay?.close()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('discovers only room metadata and keeps local names/provider unchanged in the same registry', async () => {
    const fs = guestCtx.fs
    const localRead = defineTool({ name: 'read', description: 'Local test file read', parameters: {}, output: { schema: { type: 'string' }, render: (_args, result) => [{ type: 'text', text: result }] }, async execute() { return readFile(path.join(local, 'same.txt'), 'utf8') } })
    guestCtx.tools.register(localRead)
    const rooms = value(await call('remote_rooms', {}))
    expect(rooms).toMatchObject({ source: 'remote-room', roomId: null, epoch: null, path: null, data: { rooms: [{ roomId, epoch, root, mode: 'workspace-write', role: 'guest' }] } })
    expect(JSON.stringify(rooms)).not.toMatch(/secret|invitation|hostToken|peerId/u)
    expect(data(await call('remote_read', input))).toMatchObject({ text: 'HOST 世界🙂\nsecond\nthird', complete: true })
    const localResult = await call('read', {})
    expect(localResult.isError ? null : localResult.value).toBe('LOCAL SENTINEL')
    expect(guestCtx.fs instanceof SandboxedFileSystem).toBe(true)
    expect(guestCtx.fs.processPath(await guestCtx.fs.resolve('same.txt'))).toBe(fs.processPath(await fs.resolve('same.txt')))
    expect(await guestCtx.fs.readText(await guestCtx.fs.resolve('same.txt'))).toBe('LOCAL SENTINEL')
    expect(guestCtx.tools.get('read')).toBe(localRead)
    expect(guestCtx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('remote_')).sort()).toEqual(['remote_edit', 'remote_list', 'remote_read', 'remote_rooms', 'remote_write'])
    for (const name of ['remote_approve', 'remote_join', 'remote_create']) expect(code(await call(name, {}))).toBe('UNKNOWN_TOOL')
    disposeTools(); disposeTools()
    expect(guestCtx.tools.get('remote_read')).toBeUndefined()
    expect(guestCtx.tools.get('read')).toBe(localRead)
  })

  it('returns schema-valid canonical JSON and rendered bounded text, then guarded write/edit reach host storage', async () => {
    const read = await call('remote_read', input)
    const first = data(read)
    expect(read.content).toEqual([{ type: 'text', text: JSON.stringify(value(read)) }])
    expect(value(read)).toMatchObject({ source: 'remote-room', roomId, epoch, path: input.path })
    const write = data(await call('remote_write', { ...input, content: 'updated\nvalue', expected: { kind: 'replaceIfVersion', version: first.observedVersion } }))
    expect(write).toMatchObject({ operation: 'update', content: 'omitted', beforeBytes: Buffer.byteLength('HOST 世界🙂\nsecond\nthird'), afterBytes: 13 })
    expect(write).not.toHaveProperty('before')
    expect(write).not.toHaveProperty('after')
    const reread = data(await call('remote_read', input))
    const edited = data(await call('remote_edit', { ...input, oldString: 'updated', newString: 'EDITED', version: reread.observedVersion }))
    expect(edited.content).toBe('omitted')
    expect(await readFile(input.path, 'utf8')).toBe('EDITED\nvalue')
    expect(await readFile(path.join(local, 'same.txt'), 'utf8')).toBe('LOCAL SENTINEL')
    expect((await audit.query()).entries.some(entry => entry.operation === 'editText' && entry.status === 'success')).toBe(true)
  })

  it('requires explicit create intent or a stable remote_read version, never accepts list metadata as observation', async () => {
    const listed = data(await call('remote_list', { roomId, epoch, path: root }))
    expect(listed).toMatchObject({ totalEntries: 1, entries: [{ name: 'same.txt', path: input.path }] })
    expect(JSON.stringify(listed)).not.toContain('version')
    const hostVersion = object(await guest.invoke(roomId, epoch, 'fs.stat', { path: input.path })).version
    expect(code(await call('remote_write', { ...input, content: 'unsafe' }))).toBe('INVALID_ARGS')
    expect(code(await call('remote_write', { ...input, content: 'unsafe', expected: { kind: 'replaceIfVersion', version: hostVersion } }))).toBe('FS_NOT_OBSERVED')
    expect(code(await call('remote_edit', { ...input, oldString: 'HOST', newString: 'unsafe', version: hostVersion }))).toBe('FS_NOT_OBSERVED')
    const created = { ...input, path: path.join(root, 'new.txt') }
    expect(data(await call('remote_write', { ...created, content: 'created', expected: { kind: 'createIfAbsent' } }))).toMatchObject({ operation: 'create' })
    expect(code(await call('remote_write', { ...created, content: 'overwrite', expected: { kind: 'createIfAbsent' } }))).toBe('FS_NOT_OBSERVED')
    expect(await readFile(created.path, 'utf8')).toBe('created')
  })

  it('preserves remote FS_STALE_VERSION and denies room/epoch/path or agent observation substitution', async () => {
    const first = data(await call('remote_read', input))
    const expected = { kind: 'replaceIfVersion', version: first.observedVersion }
    const agent = { id: 'other-agent' } as NonNullable<ToolExecutionInput['agent']>
    expect(code(await call('remote_write', { ...input, content: 'bad', expected }, { agent }))).toBe('FS_NOT_OBSERVED')
    expect(code(await call('remote_write', { ...input, epoch: 'changed-epoch', content: 'bad', expected }))).toBe('FS_NOT_OBSERVED')
    expect(code(await call('remote_write', { ...input, path: path.join(root, 'new.txt'), content: 'bad', expected }))).toBe('FS_NOT_OBSERVED')
    await writeFile(input.path, 'external concurrent mutation')
    expect(code(await call('remote_write', { ...input, content: 'stale overwrite', expected }))).toBe('FS_STALE_VERSION')
    expect(await readFile(input.path, 'utf8')).toBe('external concurrent mutation')
  })

  it('rejects a real filesystem mutation between read and final stat instead of issuing observedVersion', async () => {
    const invoke = backend.invoke.bind(backend)
    const spy = vi.spyOn(backend, 'invoke').mockImplementation(async (method, args, operation) => {
      const result = await invoke(method, args, operation)
      if (method === 'fs.readText') await writeFile(input.path, 'changed during read')
      return result
    })
    const read = await call('remote_read', input)
    expect(code(read)).toBe('FS_STALE_VERSION')
    expect(read).not.toHaveProperty('value')
    spy.mockRestore()
    const version = object(await guest.invoke(roomId, epoch, 'fs.stat', { path: input.path })).version
    expect(code(await call('remote_edit', { ...input, oldString: 'changed', newString: 'bad', version }))).toBe('FS_NOT_OBSERVED')
  })

  it('paginates text/list explicitly, bounds canonical UTF-8 output, never dumps huge mutation bases', async () => {
    const read = data(await call('remote_read', { ...input, offset: 2, count: 1 }))
    expect(read).toMatchObject({ text: 'second', offset: 2, count: 1, totalLines: 3, complete: false })
    await writeFile(input.path, '🙂'.repeat(24_000))
    const huge = await call('remote_read', input)
    expect(code(huge)).toBe('FS_TOO_LARGE')
    expect(huge).not.toHaveProperty('value')
    expect(Buffer.byteLength(JSON.stringify(huge.content))).toBeLessThan(1024)
    const created = { ...input, path: path.join(root, 'large.txt') }
    const result = await call('remote_write', { ...created, content: 'A'.repeat(128 * 1024), expected: { kind: 'createIfAbsent' } })
    expect(data(result)).toMatchObject({ content: 'omitted', afterBytes: 128 * 1024 })
    expect(Buffer.byteLength(JSON.stringify(value(result)))).toBeLessThan(1024)
    const listing = data(await call('remote_list', { ...input, path: root, offset: 2, count: 1 }))
    expect(listing).toMatchObject({ count: 1, totalEntries: 2, complete: false })
    expect(code(await call('remote_read', { ...input, count: 501 }))).toBe('INVALID_INPUT')
  })

  it('preserves RESULT_UNKNOWN after cancellation of a committed mutation and never replays it', async () => {
    let committed!: () => void
    const ready = new Promise<void>(resolve => { committed = resolve })
    let calls = 0
    const invoke = backend.invoke.bind(backend)
    vi.spyOn(backend, 'invoke').mockImplementation(async (method, args, operation) => {
      const result = await invoke(method, args, operation)
      if (method === 'fs.writeText') {
        calls++
        committed()
        await new Promise<void>(resolve => {
          if (operation.signal.aborted) resolve()
          else operation.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      return result
    })
    const controller = new AbortController()
    const created = { ...input, path: path.join(root, 'unknown.txt') }
    const pending = call('remote_write', { ...created, content: 'COMMITTED', expected: { kind: 'createIfAbsent' } }, { signal: controller.signal })
    await ready
    controller.abort()
    const outcome = await pending
    expect(code(outcome)).toBe('RESULT_UNKNOWN')
    expect(outcome.isError && outcome.error.message).toContain('Do not replay')
    expect(calls).toBe(1)
    expect(await readFile(created.path, 'utf8')).toBe('COMMITTED')
  })

  it('lets the host enforce readonly permissions despite guest local full-access policy', async () => {
    await host.revoke(roomId)
    const created = await host.create({ relay: relayUrl, ...(publicToken === '' ? {} : { createToken: publicToken }), root, name: 'test', mode: 'read-only' })
    await vi.waitFor(() => expect(host.state().rooms.find(room => room.id === created.room.id)?.phase).toBe('authenticating'), { timeout: WAIT })
    await guest.join(created.invitation)
    await vi.waitFor(() => expect(host.state().rooms.find(room => room.id === created.room.id)?.phase).toBe('pending'), { timeout: WAIT })
    await host.approve(created.room.id)
    await vi.waitFor(() => expect(guest.state().rooms.find(room => room.id === created.room.id)?.phase).toBe('authorized'), { timeout: WAIT })
    const readonly = { ...input, roomId: created.room.id, epoch: created.room.epoch }
    const read = data(await call('remote_read', readonly))
    expect(code(await call('remote_write', { ...readonly, content: 'BAD', expected: { kind: 'replaceIfVersion', version: read.observedVersion } }))).toBe('FS_SANDBOX_DENIED')
    expect(await readFile(input.path, 'utf8')).toBe('HOST 世界🙂\nsecond\nthird')
  })

  it('rejects relative/URI host paths and honors revoked epochs', async () => {
    for (const requested of ['same.txt', 'C:same.txt', '\\same.txt', 'file:///tmp/file']) {
      const result = await call('remote_read', { ...input, path: requested })
      expect(result.isError).toBe(true)
    }
    expect(code(await call('remote_read', { ...input, path: path.join(local, 'same.txt') }))).toBe('FS_SANDBOX_DENIED')
    await host.revoke(roomId)
    await vi.waitFor(() => expect(guest.state().rooms[0]?.phase).not.toBe('authorized'), { timeout: WAIT })
    expect(code(await call('remote_read', input))).toBe('NOT_AUTHORIZED')
    expect(await readFile(path.join(local, 'same.txt'), 'utf8')).toBe('LOCAL SENTINEL')
  })
})
