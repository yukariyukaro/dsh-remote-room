import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { RemoteRoomManager } from '../room-service.ts'
import { integer, json, object, RoomError, text, type Json } from '../protocol.ts'

const OUTPUT_BYTES = 64 * 1024
const PAGE_BYTES = 48 * 1024
const identity = {
  roomId: { type: 'string', required: true, description: 'Explicit room ID from remote_rooms. Never a local workspace or an implicit current room.' },
  epoch: { type: 'string', required: true, description: 'Exact authorization epoch for this room from remote_rooms.' },
} as const
const start = {
  argv: { type: 'array', items: { type: 'string' }, description: 'Executable and arguments on the Host, 1–128 items, at most 64 KiB encoded. No implicit shell; explicitly name a shell when needed.' },
  cwd: { type: 'string', description: 'Host working directory; omitted defaults to the approved Host root. This is not a security sandbox.' },
  env: { type: 'object', additionalProperties: true, description: 'Host environment overrides: string values, at most 128 names and 16 KiB encoded. Do not include secrets in tool arguments.' },
} as const
const handle = { type: 'string', description: 'Opaque handle returned by this kind of remote start in this exact room and epoch.' } as const
const read = {
  after: { type: 'integer', description: 'UTF-8 byte cursor from nextCursor; default 0. Keep the same cursor when retrying an oversized read; gaps indicate evicted output.' },
  maxBytes: { type: 'integer', description: 'Output bytes per read, 4–49152; default 49152. JSON escaping/metadata can exceed the 64 KiB reply cap: request fewer bytes with the same after cursor.' },
} as const
const output = {
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      source: { type: 'string', const: 'remote-room', required: true },
      roomId: { type: 'string', required: true },
      epoch: { type: 'string', required: true },
      handle: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
      data: { type: 'json', required: true },
    },
  },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const
interface Target { roomId: string; epoch: string }
function nonempty(value: unknown, name: string, max = 128): string {
  const result = text(value, name, max)
  if (!result) throw new RoomError('INVALID_INPUT', `${name} must not be empty`)
  return result
}
function target(input: Target): Target {
  return { roomId: nonempty(input.roomId, 'room ID'), epoch: nonempty(input.epoch, 'authorization epoch') }
}
function fields(input: unknown, allowed: readonly string[]): void {
  if (Object.keys(object(input)).some(key => !['roomId', 'epoch', ...allowed].includes(key))) throw new RoomError('INVALID_INPUT', 'Unknown or inapplicable process argument; no guest-selected process policy is accepted')
}
function startArgs(input: { argv?: string[]; cwd?: string; env?: Record<string, Json> }): Record<string, Json> {
  if (!input.argv || input.argv.length < 1 || input.argv.length > 128) throw new RoomError('INVALID_INPUT', 'argv must contain 1–128 strings')
  const argv = input.argv.map(arg => text(arg, 'process argument', 32 * 1024))
  nonempty(argv[0], 'executable', 32 * 1024)
  if (Buffer.byteLength(JSON.stringify(argv)) > 64 * 1024) throw new RoomError('INVALID_INPUT', 'argv exceeds 64 KiB')
  const args: Record<string, Json> = { argv }
  if (input.cwd !== undefined) args.cwd = nonempty(input.cwd, 'Host working directory', 4096)
  if (input.env !== undefined) {
    const env = object(input.env)
    if (Object.keys(env).length > 128) throw new RoomError('INVALID_INPUT', 'Too many environment overrides')
    const values: Record<string, Json> = Object.create(null)
    for (const [key, value] of Object.entries(env)) {
      if (!/^[a-z_][a-z0-9_]*$/iu.test(key) || key.length > 128) throw new RoomError('INVALID_INPUT', 'Invalid environment name')
      values[key] = text(value, 'environment value', 16 * 1024)
    }
    if (Buffer.byteLength(JSON.stringify(values)) > 16 * 1024) throw new RoomError('INVALID_INPUT', 'Environment overrides exceed 16 KiB')
    args.env = values
  }
  return args
}
function readArgs(input: { after?: number; maxBytes?: number }) {
  return { after: integer(input.after ?? 0, 'output cursor', 0, Number.MAX_SAFE_INTEGER), maxBytes: integer(input.maxBytes ?? PAGE_BYTES, 'output page bytes', 4, PAGE_BYTES) }
}
function stdin(value: unknown): string {
  const data = text(value, 'stdin data', PAGE_BYTES)
  if (Buffer.byteLength(data) > PAGE_BYTES) throw new RoomError('INVALID_INPUT', 'stdin data exceeds 48 KiB UTF-8; do not replay previously submitted data')
  return data
}
function envelope(at: Target, handle: string | null, data: Json) {
  const result = { source: 'remote-room' as const, ...at, handle, data }
  if (Buffer.byteLength(JSON.stringify(result)) > OUTPUT_BYTES) throw new RoomError('RESULT_TOO_LARGE', 'Remote process reply exceeds 64 KiB encoded JSON. Nothing was silently truncated. Read again with the SAME after cursor and a smaller maxBytes; preserve reported gaps.')
  return result
}
function remoteError(error: unknown): never {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    const unknown = error.code === 'OUTCOME_UNKNOWN' || error.code === 'RESULT_UNKNOWN'
    const message = unknown ? `${error.message} Inspect the remote room/process state before any retry. Do not replay a start or resend stdin: side effects may already have occurred.` : error.message
    const converted = new HarnessError(message, error.code)
    converted.name = error.name
    throw converted
  }
  throw error
}

/** Distinct remote-only tools. Registrations and the aggregate disposer belong to ctx. */
export function registerRemoteProcessTools(ctx: Context, manager: RemoteRoomManager): () => void {
  const disposers: (() => void)[] = []
  const invoke = async (at: Target, method: string, args: Json, exec: ToolRunContext) => {
    // One call only: starts and stdin must never be automatically replayed.
    return manager.invoke(at.roomId, at.epoch, method, args, exec.signal)
  }
  const register = (definition: ToolDefinition) => disposers.push(ctx.tools.register({
    ...definition,
    async execute(args, exec) {
      try { return await definition.execute(args, exec) }
      catch (error) { return remoteError(error) }
    },
  }))
  const dispose = () => { for (const stop of disposers.splice(0).reverse()) stop() }
  try {
    register(defineTool({
      name: 'remote_exec',
      description: 'Start an argv process on an explicitly authorized remote Host; returns a handle for remote_process. Requires danger-full-access room permission: the Host account’s whole machine and network, NOT a cwd sandbox. Discover rooms with remote_rooms; users alone create/join/approve. Never runs locally. Unknown start outcomes must be inspected, not replayed.',
      parameters: { ...identity, ...start, argv: { ...start.argv, required: true } }, output,
      async execute(args, exec) {
        fields(args, ['argv', 'cwd', 'env'])
        const at = target(args)
        const result = object(await invoke(at, 'exec.start', startArgs(args), exec))
        return envelope(at, nonempty(result.handle, 'Host process handle'), json(result))
      },
    }))
    register(defineTool({
      name: 'remote_process',
      description: 'Read output/status, write stdin or kill an exec handle on its explicit remote Host. All actions require full-host-and-network room authorization. Read returns chunks, byte cursors, gaps, outputClosed and exit facts; poll until outputClosed and nextCursor equals latestCursor. Writes may be partial on failure: never automatically resend stdin; inspect unknown outcomes before retry.',
      parameters: {
        ...identity, handle: { ...handle, required: true },
        action: { type: 'string', enum: ['read', 'write', 'kill'], required: true }, ...read,
        data: { type: 'string', description: 'Required for write; at most 48 KiB UTF-8. Empty string is allowed, including with end:true.' },
        end: { type: 'boolean', description: 'Write only: close exec stdin after data; default false.' },
      }, output,
      async execute(args, exec) {
        fields(args, args.action === 'read' ? ['handle', 'action', 'after', 'maxBytes'] : args.action === 'write' ? ['handle', 'action', 'data', 'end'] : ['handle', 'action'])
        const at = target(args)
        const id = nonempty(args.handle, 'process handle')
        const input: Record<string, Json> = args.action === 'read' ? { handle: id, ...readArgs(args) } : args.action === 'write' ? { handle: id, data: stdin(args.data), end: args.end ?? false } : { handle: id }
        return envelope(at, id, await invoke(at, `exec.${args.action}`, input, exec))
      },
    }))
    register(defineTool({
      name: 'remote_pty',
      description: 'Start or operate a real remote Host PTY (interactive terminal), requiring full Host machine/network authorization. Never falls back to local execution or pipes; unavailable PTY providers return CAPABILITY_UNAVAILABLE. Read returns terminal chunks, cursors, gaps and exit facts. Unknown starts/writes must be inspected before retry; never resend stdin automatically.',
      parameters: {
        ...identity, action: { type: 'string', enum: ['start', 'read', 'write', 'resize', 'kill'], required: true },
        handle, ...start, ...read,
        cols: { type: 'integer', description: 'Start/resize columns, 2–500; start default 80. Required for resize.' },
        rows: { type: 'integer', description: 'Start/resize rows, 1–200; start default 24. Required for resize.' },
        data: { type: 'string', description: 'Required for write; at most 48 KiB UTF-8. PTY input is terminal input, not exec stdin; no end flag.' },
      }, output,
      async execute(args, exec) {
        const allowed = args.action === 'start' ? ['argv', 'cwd', 'env', 'cols', 'rows'] : args.action === 'read' ? ['handle', 'after', 'maxBytes'] : args.action === 'write' ? ['handle', 'data'] : args.action === 'resize' ? ['handle', 'cols', 'rows'] : ['handle']
        fields(args, ['action', ...allowed])
        const at = target(args)
        let id: string | null = null
        let input: Record<string, Json>
        if (args.action === 'start') input = { ...startArgs(args), cols: integer(args.cols ?? 80, 'columns', 2, 500), rows: integer(args.rows ?? 24, 'rows', 1, 200) }
        else {
          id = nonempty(args.handle, 'PTY handle')
          input = args.action === 'read' ? { handle: id, ...readArgs(args) } : args.action === 'write' ? { handle: id, data: stdin(args.data) } : args.action === 'resize' ? { handle: id, cols: integer(args.cols, 'columns', 2, 500), rows: integer(args.rows, 'rows', 1, 200) } : { handle: id }
        }
        const result = await invoke(at, `pty.${args.action}`, input, exec)
        if (args.action === 'start') id = nonempty(object(result).handle, 'Host PTY handle')
        return envelope(at, id, result)
      },
    }))
  } catch (error) { dispose(); throw error }
  return ctx.effect(() => dispose, 'remote process tools')
}
