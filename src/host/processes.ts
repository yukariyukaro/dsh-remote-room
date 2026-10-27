import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Readable } from 'node:stream';
import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type { SubprocessRuntime, SubprocessHandle, SubprocessTerminalHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess';
import type { OperationContext, RoomGrant } from '../room-service.ts';
import { integer, json, object, RoomError, text, type Json } from '../protocol.ts';
import { GrantAccess } from './access.ts';
import type { AuditInput, AuditStore } from './audit-store.ts';

export const PROCESS_METHODS = ['exec.start', 'exec.read', 'exec.write', 'exec.kill', 'pty.start', 'pty.read', 'pty.write', 'pty.resize', 'pty.kill'] as const;
export interface ProcessLimits {
  readonly maxConcurrent?: number;
  readonly ringBytes?: number;
  readonly chunkBytes?: number;
  readonly maxExecMs?: number;
  readonly ptyIdleMs?: number;
  readonly operationMs?: number;
  readonly cleanupMs?: number;
  readonly maxHandles?: number;
}
type Kind = 'exec' | 'pty';
type Stream = 'stdout' | 'stderr' | 'terminal';
interface Chunk { owner: Resource; stream: Stream; from: number; data: Buffer }
interface Resource {
  id: string;
  kind: Kind;
  owner: Pick<OperationContext, 'roomId' | 'peerId' | 'epoch'>;
  controller: AbortController;
  handle?: SubprocessHandle;
  terminal?: SubprocessTerminalHandle;
  allocating?: Promise<SubprocessTerminalHandle>;
  streams: { stream: Readable; decoder: StringDecoder; name: Stream; ended: boolean; data: (data: Buffer | string) => void; end: () => void; error: () => void }[];
  cursor: number;
  oldest: number;
  status: 'starting' | 'running' | 'exited' | 'error';
  outcome?: SubprocessOutcome;
  reason?: string;
  outputClosed: boolean;
  quiescent: boolean;
  writing: boolean;
  timer?: ReturnType<typeof setTimeout>;
  drainTimer?: ReturnType<typeof setTimeout>;
  stopping?: Promise<void>;
}
const failure = (code: string, message = `Remote process operation failed (${code})`) => new RoomError(code, message);
function codeOf(error: unknown): string {
  // Never propagate provider messages, argv, environment, output, or stack traces across the wire/journal.
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  return ['INVALID_INPUT', 'LIMIT_EXCEEDED', 'NOT_AUTHORIZED', 'PROCESS_DENIED', 'HANDLE_NOT_FOUND', 'CAPABILITY_UNAVAILABLE',
    'OPERATION_CANCELLED', 'OPERATION_TIMEOUT', 'PROCESS_BUSY', 'PROCESS_CLOSED', 'CLEANUP_UNKNOWN', 'OUTCOME_UNKNOWN', 'HOST_AUDIT_UNAVAILABLE',
    'FS_SANDBOX_DENIED', 'FS_ABORTED'].includes(code) ? code : 'PROCESS_FAILED';
}
function cap(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError('Invalid Host process limit');
  return value;
}
/** Await provider work without allowing a broken provider, held pipe, or guest stdin to hang an RPC. */
function bounded<T>(work: Promise<T>, signal: AbortSignal, cancelCode = 'OPERATION_CANCELLED'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(failure(cancelCode)); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}
function boundary(buffer: Buffer, from: number): number {
  while (from < buffer.length && (buffer[from]! & 0xc0) === 0x80) from++;
  return from;
}

/**
 * Host-owned remote execution. Only a trusted manager may call authorize. Full access means the
 * Host account's WHOLE machine and network rights, NOT a cwd sandbox or an OS elevation. Lower
 * room modes categorically deny ALL processes, even allegedly read-only commands. No raw process
 * implementation, shell fallback, local executable lookup, or guest-selected policy exists here.
 *
 * Output cursors count the continuous UTF-8 encoding of each resource's decoded output (stdout and
 * stderr interleaved in arrival order); invalid byte sequences become U+FFFD. Each stream has its
 * own streaming decoder. A room-wide lossy ring is <=256 KiB, replies/chunks <=64 KiB. Gaps and
 * outputClosed are explicit. Finished handles are bounded and may expire by eviction.
 */
export class RoomProcesses {
  private readonly grants: GrantAccess;
  private readonly limits: Required<ProcessLimits>;
  private grant?: Readonly<RoomGrant>;
  private lifecycle?: AbortController;
  private detachRoom?: () => void;
  private expiry?: ReturnType<typeof setTimeout>;
  private readonly resources = new Map<string, Resource>();
  private readonly chunks: Chunk[] = [];
  private ringSize = 0;
  private readonly starts = new Set<string>();
  private closing?: Promise<void>;

  constructor(private readonly subprocess: SubprocessRuntime, private readonly fs: FileSystem, private readonly audit: AuditStore, limits: ProcessLimits = {}) {
    this.grants = new GrantAccess(fs);
    this.limits = { maxConcurrent: cap(limits.maxConcurrent ?? 2, 2), ringBytes: cap(limits.ringBytes ?? 256 * 1024, 256 * 1024),
      chunkBytes: cap(limits.chunkBytes ?? 64 * 1024, 64 * 1024), maxExecMs: cap(limits.maxExecMs ?? 300_000, 300_000),
      ptyIdleMs: cap(limits.ptyIdleMs ?? 60_000, 60_000), operationMs: cap(limits.operationMs ?? 10_000, 20_000),
      cleanupMs: cap(limits.cleanupMs ?? 3000, 10_000), maxHandles: cap(limits.maxHandles ?? 16, 64) };
    if (this.limits.chunkBytes < 4 || this.limits.ringBytes < 4 || this.limits.maxHandles < this.limits.maxConcurrent) throw new TypeError('Invalid Host process limits');
  }

  async authorize(grant: RoomGrant, signal: AbortSignal): Promise<void> {
    if (this.grant || this.closing) throw failure('NOT_AUTHORIZED');
    await this.grants.approve({ ...grant, methods: ['resolve', 'stat'] }, signal);
    signal.throwIfAborted();
    this.grant = Object.freeze({ ...grant });
    this.lifecycle = new AbortController();
    const abort = () => { void this.revoke('ROOM_CLOSED').catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    this.detachRoom = () => signal.removeEventListener('abort', abort);
    this.expiry = setTimeout(() => { void this.revoke('GRANT_EXPIRED').catch(() => {}); }, Math.max(1, grant.expiresAt - Date.now()));
    this.expiry.unref();
    if (signal.aborted) { await this.revoke('ROOM_CLOSED'); throw failure('NOT_AUTHORIZED'); }
  }

  async invoke(method: string, input: Json, call: OperationContext): Promise<Json> {
    if (!(PROCESS_METHODS as readonly string[]).includes(method)) throw failure('METHOD_NOT_FOUND', 'This remote process capability is not enabled');
    let changed = false;
    let start: Resource | undefined;
    let mutation: Resource | undefined;
    const timeout = AbortSignal.timeout(this.limits.operationMs);
    const signal = AbortSignal.any([call.signal, timeout]);
    const check = () => {
      const grant = this.grant;
      if (!grant || !this.lifecycle || this.lifecycle.signal.aborted || grant.expiresAt <= Date.now() ||
        call.roomId !== grant.roomId || call.peerId !== grant.peerId || call.epoch !== grant.epoch) throw failure('NOT_AUTHORIZED');
      if (grant.mode !== 'danger-full-access') throw failure('PROCESS_DENIED', 'All process execution requires explicit full machine and network access');
      if (signal.aborted) throw failure(timeout.aborted ? 'OPERATION_TIMEOUT' : 'OPERATION_CANCELLED');
      this.grants.lease({ ...call, signal }, 'resolve').check();
    };
    const journal = (status: AuditInput['status'], code?: string) => this.audit.append({ roomId: call.roomId, peerId: call.peerId,
      epoch: call.epoch, requestId: call.requestId, operation: method, status, ...(code ? { code } : {}) });
    try {
      // Even denials are journalled, but never guest paths/argv/env or unrecognized policy fields.
      await bounded(journal('attempt'), signal);
      check();
      const args = object(input);
      const [kind, action] = method.split('.') as [Kind, string];
      const allowed = action === 'start' ? (kind === 'pty' ? ['argv', 'cwd', 'env', 'rows', 'cols'] : ['argv', 'cwd', 'env']) :
        action === 'read' ? ['handle', 'after', 'maxBytes'] : action === 'write' ? ['handle', 'data', 'end'] : action === 'resize' ? ['handle', 'rows', 'cols'] : ['handle'];
      if (Object.keys(args).some(key => !allowed.includes(key))) throw failure('INVALID_INPUT', 'Guest process policy and unknown fields are not accepted');
      let result: unknown;
      if (action === 'start') {
        if (this.starts.has(call.requestId)) throw failure('OUTCOME_UNKNOWN', 'A process start request cannot be replayed');
        if (this.starts.size >= 1024) throw failure('LIMIT_EXCEEDED');
        this.starts.add(call.requestId);
        const argv = this.argv(args.argv);
        const env = this.env(args.env);
        const cwd = args.cwd === undefined ? '.' : text(args.cwd, 'working directory');
        const cols = kind === 'pty' ? integer(args.cols ?? 80, 'terminal columns', 2, 500) : 80;
        const rows = kind === 'pty' ? integer(args.rows ?? 24, 'terminal rows', 1, 200) : 24;
        if ([...this.resources.values()].filter(state => !state.quiescent).length >= this.limits.maxConcurrent) throw failure('LIMIT_EXCEEDED');
        this.evict();
        const state: Resource = { id: randomUUID(), kind, owner: { roomId: call.roomId, peerId: call.peerId, epoch: call.epoch },
          controller: new AbortController(), streams: [], cursor: 0, oldest: 0, status: 'starting', outputClosed: false, quiescent: false, writing: false };
        start = state;
        this.resources.set(state.id, state); // reserve BEFORE any asynchronous resolve/allocation
        const cancel = () => { void this.stop(state, 'START_CANCELLED').catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          const lease = this.grants.lease({ ...call, signal }, 'resolve');
          const target = await bounded(this.grants.target(lease, cwd), signal);
          if ((await bounded(this.fs.stat(target, lease.signal), signal))?.type !== 'directory') throw failure('INVALID_INPUT', 'Working directory must be a real Host directory');
          const processCwd = this.fs.processPath(target);
          if (!path.isAbsolute(processCwd)) throw failure('PROCESS_DENIED');
          argv[0] = await bounded(this.subprocess.resolveExecutable(argv[0]!, env, signal), signal);
          check();
          const lifetime = AbortSignal.any([this.lifecycle!.signal, state.controller.signal]);
          changed = true; // From this point onward errors MUST NOT imply safe replay.
          if (kind === 'exec') {
            state.handle = this.subprocess.spawn({ argv, cwd: processCwd, env, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: 500, signal: lifetime });
            if (lifetime.aborted) {
              state.stopping = undefined; state.quiescent = false;
              void this.stop(state, 'START_CANCELLED').catch(() => {});
            }
            if (state.handle.stdout) this.observe(state, state.handle.stdout, 'stdout');
            if (state.handle.stderr) this.observe(state, state.handle.stderr, 'stderr');
            state.handle.stdin?.on('error', () => {}); // EPIPE is reported by the individual write; never an unhandled event.
            this.observeDone(state, state.handle.done);
            state.timer = setTimeout(() => { void this.stop(state, 'EXEC_DEADLINE').catch(() => {}); }, this.limits.maxExecMs);
          } else {
            if (typeof this.subprocess.spawnTerminal !== 'function') throw failure('CAPABILITY_UNAVAILABLE');
            const allocationController = new AbortController();
            const cancelAllocation = () => allocationController.abort();
            signal.addEventListener('abort', cancelAllocation, { once: true });
            const allocation = this.subprocess.spawnTerminal({ argv, cwd: processCwd, env, cols, rows, terminalType: 'xterm-256color', graceMs: 500,
              signal: AbortSignal.any([allocationController.signal, lifetime]) });
            state.allocating = allocation;
            // An allocating provider may ignore cancellation and publish late: never orphan that session.
            void allocation.then(handle => {
              if (lifetime.aborted || allocationController.signal.aborted) { handle.output.destroy(); void handle.terminate().catch(() => {}); }
            }, () => {});
            try { state.terminal = await bounded(allocation, signal); }
            catch (error) {
              if (signal.aborted) throw error;
              throw failure('CAPABILITY_UNAVAILABLE', 'The Host subprocess provider could not allocate a real PTY; no pipe fallback is permitted');
            } finally { signal.removeEventListener('abort', cancelAllocation); }
            this.observe(state, state.terminal.output, 'terminal');
            this.observeDone(state, state.terminal.done);
            this.touch(state);
          }
          state.timer?.unref();
          if (state.status === 'starting') state.status = 'running';
          check();
          await bounded(journal('success'), signal);
          check();
          result = { handle: state.id, cursor: 0, kind, access: 'full-host-and-network' };
        } finally { signal.removeEventListener('abort', cancel); }
      } else {
        const state = this.resource(text(args.handle, 'process handle', 128), kind, call);
        if (action === 'read') result = this.read(state, integer(args.after ?? 0, 'output cursor', 0, Number.MAX_SAFE_INTEGER), integer(args.maxBytes ?? this.limits.chunkBytes, 'output page bytes', 4, this.limits.chunkBytes));
        else if (action === 'kill') { changed = true; mutation = state; await bounded(this.stop(state, 'GUEST_KILL'), signal); result = { killed: true }; }
        else {
          if (state.status !== 'running' || state.controller.signal.aborted) throw failure('PROCESS_CLOSED');
          if (state.writing) throw failure('PROCESS_BUSY');
          state.writing = true; // At most one outstanding stdin/resize operation; no unbounded write queue.
          try {
            changed = true;
            mutation = state;
            if (action === 'resize') {
              await bounded(state.terminal!.resize(integer(args.cols, 'terminal columns', 2, 500), integer(args.rows, 'terminal rows', 1, 200)), signal);
              result = { resized: true };
            } else {
              const data = text(args.data, 'stdin data', this.limits.chunkBytes);
              if (Buffer.byteLength(data) > this.limits.chunkBytes || (args.end !== undefined && typeof args.end !== 'boolean') || (kind === 'pty' && args.end !== undefined)) throw failure('INVALID_INPUT');
              if (kind === 'pty') await bounded(state.terminal!.write(data), signal);
              else await bounded(this.write(state, data, args.end === true), signal);
              result = { acceptedBytes: Buffer.byteLength(data), ended: args.end === true };
            }
          } catch (error) {
            // An interrupted write can have partially reached stdin. Kill, classify unknown, NEVER resend.
            void this.stop(state, 'WRITE_UNKNOWN').catch(() => {});
            throw error;
          } finally { state.writing = false; }
        }
        this.touch(state);
        check();
        await bounded(journal('success'), signal);
      }
      return json(result);
    } catch (error) {
      if (start) await this.stop(start, 'START_FAILED').catch(() => {});
      if (mutation) await this.stop(mutation, 'OPERATION_UNKNOWN').catch(() => {});
      const underlying = timeout.aborted ? 'OPERATION_TIMEOUT' : call.signal.aborted ? 'OPERATION_CANCELLED' : codeOf(error);
      const code = changed && underlying !== 'CAPABILITY_UNAVAILABLE' ? 'OUTCOME_UNKNOWN' : underlying;
      // Metadata-only; audit outages never skip cleanup or authorize a process.
      await bounded(journal(changed ? 'unknown' : underlying === 'PROCESS_DENIED' || underlying === 'NOT_AUTHORIZED' ? 'denied' : 'error', code), AbortSignal.timeout(this.limits.cleanupMs)).catch(() => {});
      throw failure(code, code === 'OUTCOME_UNKNOWN' ? 'Process side effects may have occurred; owned resource was terminated. Do not replay this request' : undefined);
    }
  }

  /** Abort/terminate EVERY resource first, before awaiting ANY audit/provider operation. */
  revoke(_reason: string): Promise<void> {
    if (this.closing) return this.closing;
    const grant = this.grant;
    this.grant = undefined;
    this.lifecycle?.abort();
    this.grants.revoke('Process capability revoked');
    clearTimeout(this.expiry);
    this.detachRoom?.();
    this.detachRoom = undefined;
    const cleanups = [...this.resources.values()].map(state => this.stop(state, 'REVOKED'));
    this.closing = (async () => {
      let failed = false;
      try {
        const outcomes = await Promise.allSettled(cleanups);
        failed = outcomes.some(outcome => outcome.status === 'rejected');
      } finally {
        for (const state of this.resources.values()) this.finishOutput(state);
        this.resources.clear(); this.chunks.length = 0; this.ringSize = 0;
      }
      if (grant) await bounded(this.audit.append({ roomId: grant.roomId, peerId: grant.peerId, epoch: grant.epoch, requestId: `process-revoke:${grant.epoch}`,
        operation: 'process.revoke', status: failed ? 'unknown' : 'revoked', ...(failed ? { code: 'CLEANUP_UNKNOWN' } : {}) }), AbortSignal.timeout(this.limits.cleanupMs));
      if (failed) throw failure('CLEANUP_UNKNOWN', 'Provider could not confirm whole process-range teardown within the Host deadline');
    })();
    return this.closing;
  }

  private argv(value: unknown): string[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 128) throw failure('INVALID_INPUT');
    const result = value.map(item => text(item, 'process argument', 32 * 1024));
    if (!result[0] || Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) throw failure('INVALID_INPUT');
    return result;
  }
  private env(value: unknown): Record<string, string> | undefined {
    if (value === undefined) return undefined;
    const record = object(value);
    if (Object.keys(record).length > 128) throw failure('INVALID_INPUT');
    const result: Record<string, string> = Object.create(null);
    for (const [name, entry] of Object.entries(record)) {
      if (!/^[a-z_][a-z0-9_]*$/iu.test(name) || name.length > 128) throw failure('INVALID_INPUT');
      result[name] = text(entry, 'environment value', 16 * 1024);
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024) throw failure('INVALID_INPUT');
    return result;
  }
  private resource(id: string, kind: Kind, call: OperationContext): Resource {
    const state = this.resources.get(id);
    if (!state || state.kind !== kind || state.owner.roomId !== call.roomId || state.owner.peerId !== call.peerId || state.owner.epoch !== call.epoch) throw failure('HANDLE_NOT_FOUND');
    return state;
  }
  private touch(state: Resource): void {
    if (state.kind !== 'pty' || state.status === 'exited' || state.status === 'error' || state.controller.signal.aborted) return;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { void this.stop(state, 'PTY_IDLE').catch(() => {}); }, this.limits.ptyIdleMs);
    state.timer.unref();
  }
  private write(state: Resource, data: string, end: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = state.handle?.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded) { reject(failure('PROCESS_CLOSED')); return; }
      // Writable callback acknowledges buffer processing/backpressure, not just queue insertion.
      const done = (error?: Error | null) => error ? reject(failure('PROCESS_FAILED')) : resolve();
      if (end) stdin.end(data, 'utf8', () => done());
      else stdin.write(data, 'utf8', done);
    });
  }
  private observe(state: Resource, stream: Readable, name: Stream): void {
    const decoder = new StringDecoder('utf8');
    const item: Resource['streams'][number] = { stream, decoder, name, ended: false,
      data: data => { if (!item.ended) this.append(state, name, typeof data === 'string' ? data : decoder.write(data)); },
      end: () => { if (item.ended) return; item.ended = true; this.append(state, name, decoder.end());
        if (state.outcome && state.streams.every(part => part.ended)) this.finishOutput(state); },
      error: () => { state.reason ??= 'OUTPUT_ERROR'; item.end(); } };
    state.streams.push(item);
    stream.on('data', item.data); stream.once('end', item.end); stream.on('error', item.error);
  }
  private observeDone(state: Resource, done: Promise<SubprocessOutcome>): void {
    void done.then(outcome => {
      state.outcome = outcome; state.status = 'exited'; clearTimeout(state.timer);
      // A direct exit is NOT whole-range quiescence: descendants can retain work and pipes.
      // Terminate the remaining owned range and keep its concurrency slot until verified empty.
      void this.stop(state, 'PROCESS_EXITED').catch(() => {});
      if (state.streams.every(item => item.ended)) this.finishOutput(state);
      else { state.drainTimer = setTimeout(() => this.finishOutput(state), 500); state.drainTimer.unref(); }
    }, () => { state.status = 'error'; state.reason ??= 'PROCESS_FAILED'; clearTimeout(state.timer); void this.stop(state, 'PROCESS_FAILED').catch(() => {}); this.finishOutput(state); });
  }
  private append(state: Resource, stream: Stream, value: string): void {
    if (!value || state.outputClosed) return;
    const data = Buffer.from(value, 'utf8');
    let offset = 0;
    while (offset < data.length) {
      let end = Math.min(data.length, offset + this.limits.chunkBytes);
      while (end < data.length && (data[end]! & 0xc0) === 0x80) end--;
      const piece = Buffer.from(data.subarray(offset, end)); // no retained reference to a huge provider buffer
      this.chunks.push({ owner: state, stream, from: state.cursor, data: piece });
      state.cursor += piece.length; this.ringSize += piece.length; offset = end;
      // Object count is bounded too: adversarial one-byte writes must not create unbounded metadata.
      while (this.ringSize > this.limits.ringBytes || this.chunks.length > 512) {
        const removed = this.chunks.shift()!;
        this.ringSize -= removed.data.length;
        removed.owner.oldest = Math.max(removed.owner.oldest, removed.from + removed.data.length);
      }
    }
  }
  private read(state: Resource, after: number, maxBytes: number): unknown {
    if (after > state.cursor) throw failure('INVALID_INPUT', 'Output cursor exceeds the latest published byte');
    let next = Math.max(after, state.oldest);
    let used = 0;
    let gap = next !== after;
    const chunks: { stream: Stream; text: string; from: number; to: number }[] = [];
    for (const chunk of this.chunks) {
      if (chunk.owner !== state || chunk.from + chunk.data.length <= next) continue;
      const rawStart = Math.max(0, next - chunk.from);
      const start = boundary(chunk.data, rawStart);
      if (start !== rawStart) gap = true;
      next = chunk.from + start;
      let end = Math.min(chunk.data.length, start + maxBytes - used);
      while (end < chunk.data.length && end > start && (chunk.data[end]! & 0xc0) === 0x80) end--;
      if (end === start) break;
      chunks.push({ stream: chunk.stream, text: chunk.data.subarray(start, end).toString('utf8'), from: next, to: chunk.from + end });
      used += end - start; next = chunk.from + end;
      if (end < chunk.data.length || used === maxBytes) break;
    }
    return { chunks, nextCursor: next, oldestCursor: state.oldest, latestCursor: state.cursor, gap,
      gapBytes: Math.max(0, (chunks[0]?.from ?? next) - after), outputClosed: state.outputClosed,
      status: { state: state.status, exitCode: state.outcome?.exitCode ?? null, signal: state.outcome?.signal ?? null, reason: state.reason ?? null } };
  }
  private finishOutput(state: Resource): void {
    if (state.outputClosed) return;
    clearTimeout(state.drainTimer);
    for (const item of state.streams) {
      if (!item.ended) { item.ended = true; this.append(state, item.name, item.decoder.end()); }
      item.stream.removeListener('data', item.data); item.stream.removeListener('end', item.end);
      // Keep the harmless error listener until stream destruction settles to avoid unhandled EPIPE.
      item.stream.destroy();
    }
    state.outputClosed = true;
  }
  private stop(state: Resource, reason: string): Promise<void> {
    state.controller.abort(); state.reason ??= reason; clearTimeout(state.timer);
    if (state.stopping) return state.stopping;
    let work: Promise<unknown>;
    try {
      // Termination starts synchronously for EVERY stop call, never behind an audit await.
      if (state.terminal) work = state.terminal.terminate();
      else if (state.handle) { state.handle.terminate(); work = state.handle.waitForExit(AbortSignal.timeout(this.limits.cleanupMs)).then(empty => { if (!empty) throw failure('CLEANUP_UNKNOWN'); }); }
      else if (state.allocating) work = state.allocating.then(handle => { handle.output.destroy(); return handle.terminate(); }, () => {});
      else { state.status = 'error'; work = Promise.resolve(); }
    } catch { work = Promise.reject(failure('CLEANUP_UNKNOWN')); }
    state.stopping = bounded(work, AbortSignal.timeout(this.limits.cleanupMs), 'CLEANUP_UNKNOWN').then(() => {
      state.quiescent = true;
      if (state.status === 'running' || state.status === 'starting') state.status = 'exited';
    }).finally(() => this.finishOutput(state));
    return state.stopping;
  }
  private evict(): void {
    while (this.resources.size >= this.limits.maxHandles) {
      const entry = [...this.resources.values()].find(state => state.outputClosed && state.quiescent);
      if (!entry) throw failure('LIMIT_EXCEEDED');
      this.resources.delete(entry.id);
      for (let index = this.chunks.length - 1; index >= 0; index--) if (this.chunks[index]!.owner === entry) this.ringSize -= this.chunks.splice(index, 1)[0]!.data.length;
    }
  }
}
