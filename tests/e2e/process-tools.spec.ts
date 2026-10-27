import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool, type ToolExecutionInput, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { startRelay } from '../../relay/src/server.ts'
import { registerRemoteProcessTools } from '../../src/guest/process-tools.ts'
import { registerRemoteTools } from '../../src/guest/tools.ts'
import { RemoteRoomManager } from '../../src/room-service.ts'
import { FileRoomBackend } from '../../src/host/backend.ts'
import { AuditError, BoundedMemoryAuditStore, type AuditInput } from '../../src/host/audit-store.ts'
import { Config, type Config as RoomConfig } from '../../src/config.ts'
import { object, type Json, type RoomMode } from '../../src/protocol.ts'

const require = createRequire(import.meta.url)
const toolsRequire = createRequire(require.resolve('@deepseek-ai/dsh-tools'))
const policyRequire = createRequire(require.resolve('@deepseek-ai/dsh-sandbox-policy'))
const { SystemPrompt } = await import(toolsRequire.resolve('@deepseek-ai/dsh-system-prompt'))
const { SessionProjectionRegistry } = await import(policyRequire.resolve('@deepseek-ai/dsh-session-projection'))
const { SessionStore } = await import(policyRequire.resolve('@deepseek-ai/dsh-session'))
const { AgentRegistry } = await import(toolsRequire.resolve('@deepseek-ai/dsh-agent'))
const { createScope } = await import(toolsRequire.resolve('@deepseek-ai/dsh-scope'))

type Caller = NonNullable<ToolExecutionInput['agent']>
class RegistryCaller implements Caller {
  readonly id: Caller['id']
  readonly options = {}
  readonly status = 'idle' as const
  ctx!: Context
  readonly inbox: Caller['inbox']
  private maintenance?: Promise<unknown>
  private controller?: AbortController
  constructor(readonly session: ReturnType<Context['sessions']['create']>) {
    this.id = session.id
    const queues: Record<'next-turn' | 'next-step', Parameters<Caller['send']>[0][]> = { 'next-turn': [], 'next-step': [] }
    const splice: Caller['inbox']['splice'] = (target, start, deleteCount, inserted) => {
      const index = start < 0 ? Math.max(0, queues[target].length + start) : Math.min(start, queues[target].length)
      const removed = queues[target].splice(index, deleteCount, ...inserted)
      session.append('agent/inbox/spliced', { target, start: index, removedCount: removed.length, inserted })
      return removed
    }
    this.inbox = {
      get nextTurn() { return queues['next-turn'] }, get nextStep() { return queues['next-step'] }, splice,
      clear() { splice('next-step', 0, queues['next-step'].length, []); splice('next-turn', 0, queues['next-turn'].length, []) },
      append(target, message) { splice(target, queues[target].length, 0, [message]) },
      prepend(target, message) { splice(target, 0, 0, [message]) },
      replace(id, message) {
        for (const target of ['next-turn', 'next-step'] as const) { const index = queues[target].findIndex(item => item.id === id); if (index >= 0) { splice(target, index, 1, [message]); return true } }
        return false
      },
      remove(id) {
        for (const target of ['next-turn', 'next-step'] as const) { const index = queues[target].findIndex(item => item.id === id); if (index >= 0) { splice(target, index, 1, []); return true } }
        return false
      },
    }
  }
  cancel(_cause: Parameters<Caller['cancel']>[0], options?: Parameters<Caller['cancel']>[1]) { this.controller?.abort(); if (!options?.keepInbox) this.inbox.clear() }
  async whenIdle() { await this.maintenance }
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.maintenance) throw new Error('Maintenance already active')
    this.controller = new AbortController()
    const work = task(this.controller.signal).finally(() => { this.maintenance = undefined; this.controller = undefined })
    this.maintenance = work
    return work
  }
  send(message: Parameters<Caller['send']>[0], target: Parameters<Caller['send']>[1], wakeup: boolean) {
    if (wakeup) throw new Error('This registry caller is a tool-only driver, not a model loop')
    this.inbox.append(target, message)
  }
  followup(message: Parameters<Caller['followup']>[0]) { this.send(message, 'next-turn', true) }
  steer(message: Parameters<Caller['steer']>[0]) { this.send(message, 'next-step', true) }
  inject(message: Parameters<Caller['inject']>[0]) { this.send(message, 'next-step', false) }
}
// Real journal with an explicit fault/barrier hook. Process, manager, relay and
// registry remain actual; this exercises uncertain side effects at persistence.
class ProcessTestAudit extends BoundedMemoryAuditStore {
  onSuccess?: (entry: AuditInput) => Promise<void>
  override async append(entry: AuditInput, signal?: AbortSignal) {
    const stored = await super.append(entry, signal)
    if (entry.status === 'success') await this.onSuccess?.(entry)
    return stored
  }
}
function value(result: ToolExecutionResult) {
  expect(result.isError, JSON.stringify(result)).toBe(false)
  if (result.isError) throw new Error(result.error.message)
  const resultValue = object(result.value)
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
  expect(Buffer.byteLength(JSON.stringify(result.value))).toBeLessThanOrEqual(65536)
  return resultValue
}
function data(result: ToolExecutionResult) { return object(value(result).data) }
function code(result: ToolExecutionResult) {
  expect(result.isError, JSON.stringify(result)).toBe(true)
  return result.isError ? result.error.info?.code : undefined
}
interface Page { chunks: { text: string; from: number; to: number; stream: string }[]; nextCursor: number; latestCursor: number; gap: boolean; outputClosed: boolean; status: { state: string; exitCode: number | null } }

// ToolRuntime.execute, Cordis scoped caller/session + AgentRegistry, authenticated
// relay/RPC, both real managers, FileRoomBackend and actual LocalSubprocessRuntime.
// No definition.execute calls, fake registry, mock manager or mock subprocess.
// The custom idle driver owns a live Session/scope; no LLM/API key is needed.
describe('remote process tools / real registry and two-end Host subprocess', () => {
  let directory: string
  let root: string
  let hostCtx: Context
  let guestCtx: Context
  let callerScope: ReturnType<typeof createScope>
  let caller: Caller
  let host: RemoteRoomManager
  let guest: RemoteRoomManager
  let audit: ProcessTestAudit
  let relay: Awaited<ReturnType<typeof startRelay>>
  let roomId: string
  let epoch: string
  let disposeTools: () => void
  let withProvider = true
  const call = (name: string, args: unknown, overrides: Partial<ToolExecutionInput> = {}) => guestCtx.tools.execute({
    callId: randomUUID() as ToolExecutionInput['callId'], name, arguments: args, agent: caller, signal: new AbortController().signal, ...overrides,
  })
  const at = () => ({ roomId, epoch })
  const start = async (script: string, extra: Record<string, Json> = {}) => {
    const result = value(await call('remote_exec', { ...at(), argv: [process.execPath, '-e', script], ...extra }))
    expect(result).toMatchObject({ source: 'remote-room', ...at(), data: { kind: 'exec', access: 'full-host-and-network', cursor: 0 } })
    expect(result.handle).toBe(object(result.data).handle)
    return result.handle as string
  }
  const read = async (handle: string, after = 0, maxBytes = 49152, name = 'remote_process') => data(await call(name, { ...at(), handle, action: 'read', after, maxBytes })) as unknown as Page
  async function collect(handle: string, name = 'remote_process', maxBytes = 49152) {
    let cursor = 0
    let output = ''
    let last!: Page
    await vi.waitFor(async () => {
      last = await read(handle, cursor, maxBytes, name)
      expect(last.gap).toBe(false)
      for (const chunk of last.chunks) {
        expect(chunk.from).toBe(cursor)
        expect(chunk.to - chunk.from).toBe(Buffer.byteLength(chunk.text))
        cursor = chunk.to; output += chunk.text
      }
      expect(last.nextCursor).toBe(cursor)
      expect(last.outputClosed && cursor === last.latestCursor).toBe(true)
    }, { timeout: 10000, interval: 30 })
    return { output, last }
  }
  async function connect(mode: RoomMode = 'danger-full-access') {
    const created = await host.create({ relay: relay.url, root, name: 'test', mode })
    roomId = created.room.id
    await vi.waitFor(() => expect(host.state().rooms.find(room => room.id === roomId)?.phase).toBe('authenticating'))
    await guest.join(created.invitation)
    await vi.waitFor(() => expect(host.state().rooms.find(room => room.id === roomId)?.phase).toBe('pending'))
    await host.approve(roomId)
    await vi.waitFor(() => expect(guest.state().rooms.find(room => room.id === roomId)?.phase).toBe('authorized'))
    epoch = guest.state().rooms.find(room => room.id === roomId)!.epoch
  }
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'dsh-process-tools-'))
    root = path.join(directory, 'host'); await mkdir(root)
    hostCtx = new Context()
    await hostCtx.plugin(SessionProjectionRegistry)
    await hostCtx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: directory })
    await hostCtx.plugin(SandboxedFileSystem, { cwd: root })
    await hostCtx.plugin(LocalSubprocessRuntime)
    guestCtx = new Context()
    await guestCtx.plugin(SystemPrompt)
    await guestCtx.plugin(ToolRuntime)
    await guestCtx.plugin(SessionProjectionRegistry)
    await guestCtx.plugin(SessionStore)
    await guestCtx.plugin(AgentRegistry)
    await guestCtx.plugin({
      inject: ['tools', 'agents', 'sessions'],
      async apply(ctx: Context) {
        const session = ctx.sessions.create(undefined, { meta: { cwd: directory } })
        // A custom non-model driver is a supported AgentRegistry consumer. Its
        // live Session and createScope identity are real, not an { id } stand-in.
        const driver = new RegistryCaller(session)
        caller = driver
        callerScope = createScope(ctx, caller)
        driver.ctx = callerScope.ctx
        await callerScope.ctx.agents.register(caller)
        expect(ctx.agents.get(caller.id)).toBe(caller)
      },
    })
    relay = await startRelay({ host: '127.0.0.1', port: 0 })
    const config = Config({ relayUrl: relay.url }) as RoomConfig
    audit = new ProcessTestAudit()
    withProvider = true
    host = new RemoteRoomManager(config, () => new FileRoomBackend(hostCtx.fs, audit, config, withProvider ? hostCtx.subprocess : undefined))
    guest = new RemoteRoomManager(config, () => { throw new Error('Guest cannot instantiate Host authority') })
    // Registration belongs to the injected caller scope, not the root registry.
    disposeTools = registerRemoteProcessTools(callerScope.ctx, guest)
    registerRemoteTools(callerScope.ctx, guest)
    await connect()
  })
  afterEach(async () => {
    disposeTools?.()
    await guest?.dispose(); await host?.dispose()
    await callerScope?.dispose()
    await guestCtx?.fiber.dispose(); await hostCtx?.fiber.dispose()
    await audit?.close(); await relay?.close()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('publishes three distinct exact schemas without replacing local exec or authority controls', async () => {
    const local = defineTool({ name: 'exec', description: 'Local sentinel', parameters: {}, output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] }, async execute() { return 'LOCAL_ONLY' } })
    callerScope.ctx.tools.register(local)
    expect((await call('exec', {})).isError).toBe(false)
    expect(guestCtx.tools.get('exec', caller)).toBe(local)
    expect(data(await call('remote_rooms', {}))).toMatchObject({ rooms: [expect.objectContaining({ roomId, epoch, mode: 'danger-full-access' })] })
    for (const name of ['remote_exec', 'remote_process', 'remote_pty']) {
      const schema = guestCtx.tools.schemas(caller).find(tool => tool.name === name)!
      expect(schema.parameters).toMatchObject({ required: expect.arrayContaining(['roomId', 'epoch']) })
      expect(guestCtx.tools.get(name)).toBeUndefined()
    }
    for (const name of ['remote_create', 'remote_join', 'remote_approve']) expect(code(await call(name, {}))).toBe('UNKNOWN_TOOL')
    disposeTools(); disposeTools()
    expect(code(await call('remote_exec', { ...at(), argv: ['node'] }))).toBe('UNKNOWN_TOOL')
    expect(guestCtx.tools.get('exec', caller)).toBe(local)
  })

  it('starts a real Host argv process and reads Unicode cursors, stderr and exit facts', async () => {
    const handle = await start("require('node:fs').writeFileSync('marker.txt',process.env.DSH_REMOTE_TEST); process.stdout.write('世界🙂\\n'); process.stderr.write('ERR\\n')", { env: { DSH_REMOTE_TEST: 'HOST_MARKER' } })
    const { output, last } = await collect(handle)
    expect(output).toContain('世界🙂\n'); expect(output).toContain('ERR\n')
    expect(output).not.toContain('\ufffd')
    expect(last.status).toMatchObject({ state: 'exited', exitCode: 0 })
    expect(await readFile(path.join(root, 'marker.txt'), 'utf8')).toBe('HOST_MARKER')
    const entries = (await audit.query({ limit: 200 })).entries
    expect(entries.some(entry => entry.operation === 'exec.start' && entry.status === 'success')).toBe(true)
  })

  it('writes real stdin exactly once, supports end and kills a separate live exec', async () => {
    const handle = await start("process.stdin.setEncoding('utf8'); process.stdin.on('data',d=>process.stdout.write('IN:'+d)); process.stdin.on('end',()=>process.exit(0))")
    expect(data(await call('remote_process', { ...at(), handle, action: 'write', data: 'once🙂', end: true }))).toEqual({ acceptedBytes: Buffer.byteLength('once🙂'), ended: true })
    expect((await collect(handle)).output).toBe('IN:once🙂')
    const live = await start('setInterval(()=>{},1000)')
    expect(data(await call('remote_process', { ...at(), handle: live, action: 'kill' }))).toEqual({ killed: true })
    expect((await collect(live)).last.outputClosed).toBe(true)
    expect((await audit.query({ limit: 200 })).entries.filter(entry => entry.operation === 'exec.write' && entry.status === 'attempt')).toHaveLength(1)
  })

  it('denies both lower room modes and explicit stale/missing targets without local fallback', async () => {
    for (const mode of ['read-only', 'workspace-write'] as const) {
      await host.revoke(roomId); await connect(mode)
      for (const [name, args] of [['remote_exec', { argv: [process.execPath, '-e', 'process.exit(0)'] }], ['remote_pty', { action: 'start', argv: [process.execPath] }], ['remote_process', { action: 'read', handle: 'not-a-handle' }]] as const) {
        expect(code(await call(name, { ...at(), ...args }))).toBe('PROCESS_DENIED')
      }
    }
    expect(code(await call('remote_exec', { ...at(), epoch: 'stale', argv: ['node'] }))).toBe('NOT_AUTHORIZED')
    expect(code(await call('remote_exec', { epoch, argv: ['node'] }))).toBe('INVALID_ARGS')
    expect(code(await call('remote_exec', { ...at(), roomId: 'nonexistent', argv: ['node'] }))).toBe('ROOM_NOT_FOUND')
    expect((await audit.query({ limit: 200 })).entries.some(entry => entry.operation === 'exec.start' && entry.status === 'success')).toBe(false)
  })

  it('rejects action-inapplicable fields, invalid bounds and wrong-kind handles', async () => {
    const handle = await start('setInterval(()=>{},1000)')
    expect(code(await call('remote_pty', { ...at(), action: 'read', handle }))).toBe('HANDLE_NOT_FOUND')
    for (const args of [{ action: 'read', maxBytes: 49153 }, { action: 'read', after: -1 }, { action: 'kill', data: 'bad' }, { action: 'write', data: '🙂'.repeat(13000) }]) {
      expect(code(await call('remote_process', { ...at(), handle, ...args }))).toBe('INVALID_INPUT')
    }
    expect(code(await call('remote_pty', { ...at(), action: 'resize', handle, rows: 24 }))).toBe('INVALID_INPUT')
    expect(code(await call('remote_exec', { ...at(), argv: [process.execPath], policy: { mode: 'danger-full-access' } }))).toBe('INVALID_INPUT')
    await call('remote_process', { ...at(), handle, action: 'kill' })
  })

  it('rejects oversized escaped JSON rather than silently losing bytes, then rereads same cursor', async () => {
    const handle = await start("process.stdout.write('\\u0001'.repeat(30000)); setTimeout(()=>{},150)")
    await vi.waitFor(async () => expect((await read(handle, 0, 1024)).latestCursor).toBe(30000), { timeout: 10000, interval: 30 })
    const oversized = await call('remote_process', { ...at(), handle, action: 'read' })
    expect(code(oversized)).toBe('RESULT_TOO_LARGE')
    expect(oversized).not.toHaveProperty('value')
    expect(oversized.isError && oversized.error.message).toContain('SAME after cursor')
    const { output, last } = await collect(handle, 'remote_process', 1024)
    expect(output).toBe('\u0001'.repeat(30000))
    expect(last.nextCursor).toBe(30000)
  })

  it('uses a real PTY or reports explicit capability unavailable; never substitutes exec', async () => {
    const result = await call('remote_pty', { ...at(), action: 'start', argv: [process.execPath, '-e', "console.log('TTY:'+process.stdout.isTTY); process.stdin.on('data',d=>{console.log('GOT:'+d);}); setInterval(()=>{},1000)"], cols: 80, rows: 24 })
    if (result.isError) {
      expect(code(result)).toBe('CAPABILITY_UNAVAILABLE')
      console.info('PTY evidence: actual Host provider returned CAPABILITY_UNAVAILABLE; no pipe fallback was attempted')
      expect((await audit.query({ limit: 200 })).entries.filter(entry => entry.operation === 'exec.start')).toHaveLength(0)
      return
    }
    console.info('PTY evidence: actual Host provider allocated a terminal; verifying isTTY, write, resize and kill')
    const handle = value(result).handle as string
    expect(data(await call('remote_pty', { ...at(), action: 'resize', handle, cols: 100, rows: 32 }))).toEqual({ resized: true })
    expect(data(await call('remote_pty', { ...at(), action: 'write', handle, data: 'PTY_INPUT\r' }))).toMatchObject({ acceptedBytes: 10 })
    await vi.waitFor(async () => expect((await read(handle, 0, 49152, 'remote_pty')).chunks.map(chunk => chunk.text).join('')).toContain('TTY:true'), { timeout: 10000, interval: 30 })
    expect(data(await call('remote_pty', { ...at(), action: 'kill', handle }))).toEqual({ killed: true })
    expect((await collect(handle, 'remote_pty')).output).toContain('TTY:true')
    expect((await audit.query({ limit: 200 })).entries.filter(entry => entry.operation === 'exec.start')).toHaveLength(0)
  })

  it('retains OUTCOME_UNKNOWN after a real spawn and failed success journal without replay', async () => {
    audit.onSuccess = async entry => {
      if (entry.operation === 'exec.start') throw new AuditError('Injected journal outage after actual allocation')
    }
    const result = await call('remote_exec', { ...at(), argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'] })
    expect(code(result)).toBe('OUTCOME_UNKNOWN')
    expect(result.isError && result.error.message).toContain('Inspect')
    expect(result.isError && result.error.message).toContain('Do not replay')
    audit.onSuccess = undefined
    const entries = (await audit.query({ limit: 200 })).entries
    expect(entries.filter(entry => entry.operation === 'exec.start' && entry.status === 'attempt')).toHaveLength(1)
    expect(entries.some(entry => entry.operation === 'exec.start' && entry.code === 'OUTCOME_UNKNOWN')).toBe(true)
  })

  it('retains RESULT_UNKNOWN on cancelled acknowledged stdin; never replays that write', async () => {
    const handle = await start("process.stdin.on('data',d=>require('node:fs').appendFileSync('stdin-proof.txt',d)); setInterval(()=>{},1000)")
    let submitted!: () => void
    let release!: () => void
    const committed = new Promise<void>(resolve => { submitted = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    audit.onSuccess = async entry => {
      if (entry.operation === 'exec.write') { submitted(); await barrier }
    }
    const controller = new AbortController()
    const pending = call('remote_process', { ...at(), handle, action: 'write', data: 'ONCE' }, { signal: controller.signal })
    await committed
    controller.abort(); release()
    const result = await pending
    expect(code(result)).toBe('RESULT_UNKNOWN')
    expect(result.isError && result.error.message).toContain('Inspect')
    expect(result.isError && result.error.message).toContain('resend stdin')
    audit.onSuccess = undefined
    await vi.waitFor(async () => expect((await audit.query({ limit: 200 })).entries.filter(entry => entry.operation === 'exec.write' && entry.status === 'attempt')).toHaveLength(1))
  })

  it('preserves CAPABILITY_UNAVAILABLE when this real Host backend has no subprocess service', async () => {
    await host.revoke(roomId); withProvider = false; await connect()
    expect(code(await call('remote_exec', { ...at(), argv: [process.execPath] }))).toBe('CAPABILITY_UNAVAILABLE')
    expect(code(await call('remote_pty', { ...at(), action: 'start', argv: [process.execPath] }))).toBe('CAPABILITY_UNAVAILABLE')
  })
})
