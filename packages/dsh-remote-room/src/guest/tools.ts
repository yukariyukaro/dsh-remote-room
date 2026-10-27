import type { Context } from '@deepseek-ai/cordis'
import { FsError, type FsErrorCode } from '@deepseek-ai/dsh-fs'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { RemoteRoomManager } from '../room-service.ts'
import { integer, json, object, RoomError, text, type Json } from '../protocol.ts'

// Caps apply to the canonical value too, not merely its native text projection.
const OUTPUT_BYTES = 64 * 1024
const INPUT_BYTES = 1024 * 1024
const MAX_OBSERVATIONS = 512
const FS_CODES = new Set<string>(['FS_NOT_FOUND', 'FS_NOT_DIRECTORY', 'FS_NOT_TEXT', 'FS_NOT_REGULAR_FILE', 'FS_TOO_LARGE', 'FS_PERMISSION_DENIED', 'FS_SANDBOX_DENIED', 'FS_IO_ERROR', 'FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_AMBIGUOUS_EDIT', 'FS_EDIT_NOT_FOUND', 'FS_ABORTED'])
const identity = {
  roomId: { type: 'string', required: true, description: 'Room ID from remote_rooms; never a local workspace identifier.' },
  epoch: { type: 'string', required: true, description: 'Exact authorization epoch from remote_rooms for this room.' },
  path: { type: 'string', required: true, description: 'Absolute path on the room host, using the host path dialect, not a local path or URI.' },
} as const
const page = {
  offset: { type: 'integer', description: '1-based starting line or entry; default 1.' },
  count: { type: 'integer', description: 'Number of lines or entries, 1–500; default 200. A page exceeding 64 KiB fails; request fewer items.' },
} as const
const output = {
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      source: { type: 'string', const: 'remote-room', required: true },
      roomId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
      epoch: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
      path: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
      data: { type: 'json', required: true },
    },
  },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

interface Coordinates { roomId: string; epoch: string; path: string }
function coordinates(input: Coordinates): Coordinates {
  const roomId = text(input.roomId, 'room ID', 128)
  const epoch = text(input.epoch, 'authorization epoch', 128)
  const requested = text(input.path, 'host path')
  // Never resolve relative paths through this machine's cwd. Drive-relative and
  // root-relative Windows paths are not absolute host coordinates.
  const absolute = requested.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(requested) || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(requested)
  if (!roomId || !epoch || !absolute || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(requested)) throw new RoomError('INVALID_INPUT', 'Use a room ID, epoch and absolute host filesystem path')
  return { roomId, epoch, path: requested }
}
function bounded(value: Json): Json {
  if (Buffer.byteLength(JSON.stringify(value)) > OUTPUT_BYTES) throw new FsError('Remote result exceeds 64 KiB; request a smaller count. A single oversized line cannot be returned.', 'FS_TOO_LARGE')
  return value
}
function envelope(at: Coordinates | null, data: Json) {
  return bounded({ source: 'remote-room', roomId: at?.roomId ?? null, epoch: at?.epoch ?? null, path: at?.path ?? null, data }) as {
    source: 'remote-room'; roomId: string | null; epoch: string | null; path: string | null; data: Json
  }
}
function nonempty(value: unknown, label: string, max = 4096): string {
  const result = text(value, label, max)
  if (!result) throw new RoomError('INVALID_INPUT', `${label} must not be empty`)
  return result
}
function content(value: string): string {
  if (Buffer.byteLength(value) > INPUT_BYTES) throw new FsError('Remote tool input exceeds 1 MiB', 'FS_TOO_LARGE')
  return value
}
function pagination(input: { offset?: number; count?: number }) {
  return { offset: input.offset === undefined ? 1 : integer(input.offset, 'offset', 1, Number.MAX_SAFE_INTEGER), count: input.count === undefined ? 200 : integer(input.count, 'count', 1, 500) }
}
function info(value: Json): { version: string; type: string } | null {
  if (value === null) return null
  const record = object(value)
  return { version: nonempty(record.version, 'file version'), type: text(record.type, 'file type', 32) }
}
/** ToolRuntime retains structured failure codes only for HarnessError instances. */
function remoteError(error: unknown): never {
  if (error instanceof HarnessError) throw error
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    if (FS_CODES.has(error.code)) throw new FsError(error.message, error.code as FsErrorCode)
    const converted = new HarnessError(error.message, error.code)
    converted.name = error.name
    throw converted
  }
  throw error
}

/** Adds distinct remote tools only. The returned disposer owns every registration. */
export function registerRemoteTools(ctx: Context, manager: RemoteRoomManager): () => void {
  const disposers: (() => void)[] = []
  const observations = new Map<string, string>()
  // Observations cannot leak across agents/sessions, rooms, epochs or host paths.
  const key = (at: Coordinates, exec: ToolRunContext) => JSON.stringify([exec.agent?.id ?? null, at.roomId, at.epoch, at.path])
  const remember = (id: string, version: string) => {
    observations.delete(id)
    observations.set(id, version)
    while (observations.size > MAX_OBSERVATIONS) observations.delete(observations.keys().next().value!)
  }
  const requireObservation = (at: Coordinates, exec: ToolRunContext, version: string) => {
    nonempty(version, 'version from remote_read')
    if (observations.get(key(at, exec)) !== version) throw new FsError('Read this exact remote path in this agent and epoch with remote_read before replacing or editing it; use its observedVersion', 'FS_NOT_OBSERVED')
  }
  const invoke = async (at: Coordinates, method: string, args: Json, exec: ToolRunContext): Promise<Json> => {
    try { return await manager.invoke(at.roomId, at.epoch, method, args, exec.signal) }
    catch (error) { return remoteError(error) }
  }
  const register = (definition: ToolDefinition) => {
    disposers.push(ctx.tools.register({
      ...definition,
      async execute(args, exec) {
        try { return await definition.execute(args, exec) }
        catch (error) { return remoteError(error) }
      },
    }))
  }
  try {
    register(defineTool({
      name: 'remote_rooms',
      description: 'Discover remote-room IDs, authorization epochs, host roots and permission modes. Read-only discovery; room creation, joining and approval are user actions. Local file tools stay local.',
      parameters: {}, output,
      isConcurrencySafe: () => true,
      async execute() {
        const state = manager.state()
        return envelope(null, json({ revision: state.revision, rooms: state.rooms.map(room => ({ roomId: room.id, epoch: room.epoch, role: room.role, phase: room.phase, root: room.root ?? null, mode: room.mode ?? null, expiresAt: room.expiresAt ?? null })) }))
      },
    }))
    register(defineTool({
      name: 'remote_read',
      description: 'Read a bounded page of UTF-8 text from a remote host. Returns text, line range, totalLines, complete and observedVersion. Only a stable read grants the version needed for remote replacement/editing.',
      parameters: { ...identity, ...page }, output,
      async execute(args, exec) {
        const at = coordinates(args)
        const { offset, count } = pagination(args)
        const id = key(at, exec)
        observations.delete(id)
        const before = info(await invoke(at, 'fs.stat', { path: at.path }, exec))
        const result = object(await invoke(at, 'fs.readText', { path: at.path }, exec))
        if (typeof result.text !== 'string') throw new RoomError('INVALID_REMOTE_RESULT', 'Host did not return text')
        const after = info(await invoke(at, 'fs.stat', { path: at.path }, exec))
        if (!before || !after || before.type !== 'file' || after.type !== 'file' || before.version !== after.version) throw new FsError('Remote file changed while reading; reread before editing', 'FS_STALE_VERSION')
        const lines = result.text.split('\n')
        const selected = lines.slice(offset - 1, offset - 1 + count)
        const value = envelope(at, { text: selected.join('\n'), offset, count: selected.length, totalLines: lines.length, complete: offset === 1 && selected.length === lines.length, observedVersion: after.version })
        if (!exec.signal.aborted) remember(id, after.version)
        return value
      },
    }))
    register(defineTool({
      name: 'remote_list',
      description: 'List a bounded page of remote directory entries with host paths and types. Does not read file contents or grant a write observation.',
      parameters: { ...identity, ...page }, output,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const at = coordinates(args)
        const { offset, count } = pagination(args)
        const entries = await invoke(at, 'fs.list', { path: at.path }, exec)
        if (!Array.isArray(entries)) throw new RoomError('INVALID_REMOTE_RESULT', 'Host did not return directory entries')
        const selected = entries.slice(offset - 1, offset - 1 + count).map(entry => {
          const item = object(entry)
          const target = object(item.target)
          return { name: text(item.name, 'entry name'), type: text(item.type, 'entry type', 32), path: text(target.displayPath, 'host entry path'), ...(typeof item.size === 'number' ? { size: item.size } : {}) }
        })
        return envelope(at, { entries: selected, offset, count: selected.length, totalEntries: entries.length, complete: offset === 1 && selected.length === entries.length })
      },
    }))
    register(defineTool({
      name: 'remote_write',
      description: 'Create or replace a remote UTF-8 file with an explicit freshness guard. Returns mutation metadata, not file contents. Unknown results must be inspected before retrying.',
      parameters: {
        ...identity,
        content: { type: 'string', required: true, description: 'Full replacement text; at most 1 MiB UTF-8.' },
        expected: { required: true, description: 'Explicitly create only if absent, or replace using observedVersion returned by remote_read of this exact path and epoch in this agent.', oneOf: [
          { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'createIfAbsent', required: true } } },
          { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'replaceIfVersion', required: true }, version: { type: 'string', required: true } } },
        ] },
      }, output,
      async execute(args, exec) {
        const at = coordinates(args)
        content(args.content)
        if (args.expected.kind === 'replaceIfVersion') requireObservation(at, exec, args.expected.version)
        observations.delete(key(at, exec))
        const result = object(await invoke(at, 'fs.writeText', { path: at.path, content: args.content, expected: args.expected }, exec))
        return envelope(at, mutationSummary(result))
      },
    }))
    register(defineTool({
      name: 'remote_edit',
      description: 'Apply literal replacement to a remote UTF-8 file guarded by a prior stable remote_read. Returns mutation metadata; reread before another edit. Unknown results must not be blindly replayed.',
      parameters: {
        ...identity,
        oldString: { type: 'string', required: true, description: 'Nonempty literal text to replace; at most 1 MiB UTF-8.' },
        newString: { type: 'string', required: true, description: 'Replacement text; empty deletes the match. At most 1 MiB UTF-8.' },
        replaceAll: { type: 'boolean', description: 'Replace all matches; default false requires exactly one match.' },
        version: { type: 'string', required: true, description: 'observedVersion from remote_read of this exact room, epoch and path in this agent.' },
      }, output,
      async execute(args, exec) {
        const at = coordinates(args)
        nonempty(args.oldString, 'oldString', INPUT_BYTES)
        content(args.oldString + args.newString)
        requireObservation(at, exec, args.version)
        observations.delete(key(at, exec))
        const result = object(await invoke(at, 'fs.editText', { path: at.path, oldString: args.oldString, newString: args.newString, replaceAll: args.replaceAll ?? false, version: args.version }, exec))
        return envelope(at, mutationSummary(result))
      },
    }))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    observations.clear()
    for (const dispose of disposers.reverse()) dispose()
  }
}

function mutationSummary(result: Record<string, unknown>): Json {
  // Atomic outcomes can contain multi-MiB before/after. Do not expose them in
  // canonical JSON, model text or metadata, even when the host allows that size.
  return {
    version: nonempty(result.version, 'mutation version'),
    ...(result.operation === 'create' || result.operation === 'update' ? { operation: result.operation } : {}),
    beforeBytes: typeof result.before === 'string' ? Buffer.byteLength(result.before) : null,
    afterBytes: typeof result.after === 'string' ? Buffer.byteLength(result.after) : null,
    content: 'omitted',
  }
}
