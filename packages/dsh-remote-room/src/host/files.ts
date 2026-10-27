import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { FsError, type FileSystem, type FsTarget, type FsEditRequest, type FsVersion, type FsWriteIntent, type FsWriteOutcome, type FsEditOutcome } from '@deepseek-ai/dsh-fs';
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox';
import { GrantAccess, denied, type AccessLease, type FileCall, type FileMethod } from './access.js';
import { AuditError, type AuditStore, type AuditInput, type AuditOutcome } from './audit-store.js';

export interface HostFileLimits {
  readonly maxReadBytes?: number;
  readonly maxWriteBytes?: number;
  readonly maxRangeBytes?: number;
  readonly maxListEntries?: number;
  readonly maxStreams?: number;
  readonly streamTtlMs?: number;
}
export interface ResolvedHostFile { readonly target: FsTarget; readonly processPath: string; readonly fileUrl: string }
export interface TextPull { readonly done: boolean; readonly value?: string }
interface StreamHandle {
  readonly owner: Pick<FileCall, 'roomId' | 'peerId' | 'epoch'>;
  readonly lease: AccessLease;
  readonly path: string;
  readonly targetKey: string;
  readonly iterator: AsyncIterator<string>;
  readonly controller: AbortController;
  readonly abortSignal: AbortSignal;
  readonly abortListener: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
  bytes: number;
  busy: boolean;
}
function limit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError('Invalid host file limit');
  return value;
}
function codeOf(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'FS_IO_ERROR';
}
function safeError(error: unknown): Error {
  if (error instanceof AuditError) return error;
  // No canonical paths, provider causes, stack messages or resolved outroot metadata cross wire.
  if (error instanceof FsError) return new FsError(`Remote file operation failed (${error.code})`, error.code);
  return new FsError('Remote file operation failed', 'FS_IO_ERROR');
}
function outcomeMetadata(outcome: FsWriteOutcome | FsEditOutcome): AuditOutcome {
  return { version: outcome.version, ...('operation' in outcome ? { operation: outcome.operation } : {}),
    beforeBytes: outcome.before === null ? null : Buffer.byteLength(outcome.before), afterBytes: Buffer.byteLength(outcome.after), content: 'omitted' };
}

/** Independent business API, intentionally not a Cordis/RPC service or guest-controlled policy seam. */
export class HostFiles {
  private readonly limits: Required<HostFileLimits>;
  private readonly streams = new Map<string, StreamHandle>();
  private closed = false;
  private openingStreams = 0;
  constructor(private readonly fs: FileSystem, private readonly grants: GrantAccess, private readonly audit: AuditStore, limits: HostFileLimits = {}) {
    // This implementation uses host-native path dialect/root identity. No SSH/remote masquerading.
    // Requiring the exact sandbox provider also fails closed for missing mutation fences.
    if (!(fs instanceof SandboxedFileSystem)) throw new TypeError('HostFiles requires the local rc3 SandboxedFileSystem provider');
    this.limits = { maxReadBytes: limit(limits.maxReadBytes ?? 8 * 1024 * 1024, 64 * 1024 * 1024),
      maxWriteBytes: limit(limits.maxWriteBytes ?? 8 * 1024 * 1024, 64 * 1024 * 1024),
      maxRangeBytes: limit(limits.maxRangeBytes ?? 1024 * 1024, 8 * 1024 * 1024),
      maxListEntries: limit(limits.maxListEntries ?? 1000, 10000), maxStreams: limit(limits.maxStreams ?? 8, 64),
      streamTtlMs: limit(limits.streamTtlMs ?? 60_000, 300_000) };
  }

  private metadata(call: FileCall, operation: string, status: AuditInput['status'], code?: string, outcome?: AuditOutcome): AuditInput {
    return { roomId: call.roomId, peerId: call.peerId, epoch: call.epoch, requestId: call.requestId, operation, status,
      ...(code ? { code } : {}), ...(outcome ? { outcome } : {}) };
  }
  private async perform<T>(call: FileCall, method: FileMethod, requestedPath: string,
    op: (target: FsTarget, lease: AccessLease) => Promise<T>, mutation = false): Promise<T> {
    let invoked = false;
    let completed = false;
    try {
      if (this.closed) denied();
      const lease = this.grants.lease(call, method);
      const target = await this.grants.target(lease, requestedPath);
      // Never journal a rejected guest path (it can contain secrets or a crafted outroot name).
      await this.audit.append({ ...this.metadata(call, method, 'attempt'), path: target.displayPath }, lease.signal);
      lease.check();
      invoked = true;
      const result = await op(target, lease);
      completed = true;
      // A committed mutation is not undone by cancellation/revocation; record its authoritative outcome.
      await this.audit.append({ ...this.metadata(call, method, 'success', undefined,
        mutation ? outcomeMetadata(result as FsWriteOutcome | FsEditOutcome) : undefined), path: target.displayPath });
      if (!mutation) lease.check();
      return result;
    } catch (error) {
      const code = codeOf(error);
      try { await this.audit.append(this.metadata(call, method, completed || (mutation && invoked && code !== 'FS_STALE_VERSION' && code !== 'FS_SANDBOX_DENIED' && code !== 'FS_NOT_OBSERVED' && code !== 'FS_EDIT_NOT_FOUND' && code !== 'FS_AMBIGUOUS_EDIT') ? 'unknown' : code === 'FS_SANDBOX_DENIED' ? 'denied' : 'error', code)); }
      catch { /* The original audit failure remains visible; never pretend execution was rolled back. */ }
      if (completed && mutation) throw new AuditError('File mutation committed, but outcome journal failed; do not replay', { cause: error });
      throw safeError(error);
    }
  }

  resolve(call: FileCall, requestedPath: string): Promise<ResolvedHostFile> {
    return this.perform(call, 'resolve', requestedPath, async target => ({ target: { ...target }, processPath: this.fs.processPath(target), fileUrl: this.fs.fileUrl(target) }));
  }
  stat(call: FileCall, requestedPath: string) {
    return this.perform(call, 'stat', requestedPath, (target, lease) => this.fs.stat(target, lease.signal));
  }
  lstat(call: FileCall, requestedPath: string) {
    return this.perform(call, 'lstat', requestedPath, (target, lease) => this.fs.lstat(target.displayPath, undefined, lease.signal));
  }
  readText(call: FileCall, requestedPath: string): Promise<string> {
    return this.perform(call, 'readText', requestedPath, async (target, lease) => {
      await this.readSize(target, lease, this.limits.maxReadBytes);
      const chunks: string[] = [];
      let bytes = 0;
      for await (const chunk of await this.fs.streamText(target, lease.signal)) {
        lease.check();
        bytes += Buffer.byteLength(chunk);
        if (bytes > this.limits.maxReadBytes) this.tooLarge();
        chunks.push(chunk);
      }
      return chunks.join('');
    });
  }
  readBytes(call: FileCall, requestedPath: string): Promise<Uint8Array> {
    return this.perform(call, 'readBytes', requestedPath, (target, lease) => this.fs.readBytes(target, lease.signal, this.limits.maxReadBytes));
  }
  readByteRange(call: FileCall, requestedPath: string, range: { offset: number; length: number }): Promise<Uint8Array> {
    return this.perform(call, 'readByteRange', requestedPath, async (target, lease) => {
      if (!range || !Number.isSafeInteger(range.offset) || range.offset < 0 || !Number.isSafeInteger(range.length) || range.length < 0 ||
        range.length > this.limits.maxRangeBytes || !Number.isSafeInteger(range.offset + range.length)) this.tooLarge();
      return this.fs.readByteRange(target, { offset: range.offset, length: range.length }, lease.signal);
    });
  }
  listDir(call: FileCall, requestedPath: string) {
    return this.perform(call, 'listDir', requestedPath, async (target, lease) => {
      const entries = await this.fs.listDir(target, lease.signal);
      if (entries.length > this.limits.maxListEntries) this.tooLarge();
      const result = [];
      for (const entry of entries) {
        if (!entry.name || path.basename(entry.name) !== entry.name || entry.name === '..') denied();
        try {
          const child = await this.grants.target(lease, path.join(target.displayPath, entry.name));
          const info = await this.fs.stat(child, lease.signal);
          lease.check();
          // Upstream listDir follows links while collecting metadata. Never reuse that
          // earlier version/size: return metadata only from the freshly authorized child.
          result.push({ name: entry.name, target: child, type: info?.type ?? 'other',
            ...(info ? { version: info.version } : {}), ...(info?.type === 'file' && info.size !== undefined ? { size: info.size } : {}) });
        } catch (error) {
          // Filter all links and outside descendants; never return provider's resolved outroot target.
          if (error instanceof FsError && error.code === 'FS_SANDBOX_DENIED') { lease.check(); continue; }
          throw error;
        }
      }
      return result;
    });
  }
  writeText(call: FileCall, requestedPath: string, content: string, expected?: FsWriteIntent): Promise<FsWriteOutcome> {
    return this.perform(call, 'writeText', requestedPath, async (target, lease) => {
      if (typeof content !== 'string' || Buffer.byteLength(content) > this.limits.maxWriteBytes) this.tooLarge();
      this.validateWriteIntent(expected);
      lease.check();
      return this.fs.writeText(target, content, expected, lease.signal, { mode: lease.grant.mode, workspaceRoot: lease.grant.root });
    }, true);
  }
  editText(call: FileCall, requestedPath: string, edit: FsEditRequest, expected?: { version: FsVersion }): Promise<FsEditOutcome> {
    return this.perform(call, 'editText', requestedPath, async (target, lease) => {
      if (!edit || typeof edit.oldString !== 'string' || !edit.oldString || typeof edit.newString !== 'string' || typeof edit.replaceAll !== 'boolean' ||
        Buffer.byteLength(edit.oldString) + Buffer.byteLength(edit.newString) > this.limits.maxWriteBytes) this.tooLarge();
      if (expected && (typeof expected.version !== 'string' || expected.version.length > 4096)) denied();
      const info = await this.readSize(target, lease, this.limits.maxWriteBytes);
      // Conservative expansion bound. No content pre/post reads: diff comes ONLY from atomic outcome.
      const size = info?.size ?? this.limits.maxWriteBytes;
      const oldBytes = Buffer.byteLength(edit.oldString.replace(/\r\n/gu, '\n'));
      const count = edit.replaceAll ? Math.floor(size / oldBytes) : 1;
      // Existing CRLF storage may expand each replacement LF to two bytes.
      const newBytes = Buffer.byteLength(edit.newString.replace(/\r\n/gu, '\n').replace(/\n/gu, '\r\n'));
      if (size + count * Math.max(0, newBytes - oldBytes) > this.limits.maxWriteBytes) this.tooLarge();
      lease.check();
      // Tie the size admission to the backend's atomic guard without any content pre-read.
      const guard = expected ?? (info ? { version: info.version } : undefined);
      return this.fs.editText(target, { oldString: edit.oldString, newString: edit.newString, replaceAll: edit.replaceAll }, guard, lease.signal,
        { mode: lease.grant.mode, workspaceRoot: lease.grant.root });
    }, true);
  }

  /** Bounded pull lifecycle. Handles are local opaque IDs, connection/epoch bound, never target keys. */
  async streamText(call: FileCall, requestedPath: string): Promise<{ handle: string }> {
    let opened: string | undefined;
    try {
      return await this.perform(call, 'streamText', requestedPath, async (target, lease) => {
        if (this.streams.size + this.openingStreams >= this.limits.maxStreams) this.tooLarge();
        this.openingStreams++;
        try {
          await this.readSize(target, lease, this.limits.maxReadBytes);
          const controller = new AbortController();
          const signal = AbortSignal.any([lease.signal, controller.signal]);
          const iterator = (await this.fs.streamText(target, signal))[Symbol.asyncIterator]();
          const handle = randomUUID();
          const timer = setTimeout(() => { void this.release(handle).catch(() => {}); }, this.limits.streamTtlMs);
          timer.unref();
          const abortListener = () => { void this.release(handle).catch(() => {}); };
          const state: StreamHandle = { owner: { roomId: call.roomId, peerId: call.peerId, epoch: call.epoch }, lease, path: requestedPath,
            targetKey: target.targetKey, iterator, controller, abortSignal: signal, abortListener, timer, bytes: 0, busy: false };
          this.streams.set(handle, state);
          opened = handle;
          signal.addEventListener('abort', abortListener, { once: true });
          if (signal.aborted || this.closed) { await this.release(handle); lease.check(); denied(); }
          return { handle };
        } finally { this.openingStreams--; }
      });
    } catch (error) { if (opened) await this.release(opened); throw error; }
  }
  async streamNext(call: FileCall, handle: string): Promise<TextPull> {
    const state = this.stream(call, handle);
    if (state.busy) denied();
    state.busy = true;
    const abortPull = () => state.controller.abort();
    call.signal.addEventListener('abort', abortPull, { once: true });
    try {
      const lease = this.grants.lease(call, 'streamText');
      const target = await this.grants.target(lease, state.path);
      if (target.targetKey !== state.targetKey) denied();
      state.lease.check();
      const next = await state.iterator.next();
      lease.check();
      state.lease.check();
      if (next.done) { await this.release(handle); return { done: true }; }
      state.bytes += Buffer.byteLength(next.value);
      if (state.bytes > this.limits.maxReadBytes) this.tooLarge();
      return { done: false, value: next.value };
    } catch (error) { await this.release(handle); throw safeError(error); }
    finally { call.signal.removeEventListener('abort', abortPull); state.busy = false; }
  }
  async streamClose(call: FileCall, handle: string): Promise<void> { this.stream(call, handle); await this.release(handle); }
  private stream(call: FileCall, handle: string): StreamHandle {
    if (this.closed) denied();
    this.grants.lease(call, 'streamText').check();
    const state = this.streams.get(handle);
    if (!state || state.owner.roomId !== call.roomId || state.owner.peerId !== call.peerId || state.owner.epoch !== call.epoch) denied();
    return state;
  }
  private async release(handle: string): Promise<void> {
    const state = this.streams.get(handle);
    if (!state) return;
    this.streams.delete(handle);
    clearTimeout(state.timer);
    state.abortSignal.removeEventListener('abort', state.abortListener);
    state.controller.abort();
    await state.iterator.return?.();
  }
  async cancelStreams(): Promise<void> { await Promise.all([...this.streams.keys()].map(handle => this.release(handle))); }
  async close(): Promise<void> { this.closed = true; await this.cancelStreams(); }
  private async readSize(target: FsTarget, lease: AccessLease, maxBytes: number) {
    const info = await this.fs.stat(target, lease.signal);
    lease.check();
    if (info?.size !== undefined && info.size > maxBytes) this.tooLarge();
    return info;
  }
  private validateWriteIntent(expected: FsWriteIntent | undefined): void {
    if (expected === undefined) return;
    if (!expected || !['createIfAbsent', 'replaceIfVersion'].includes(expected.kind) ||
      (expected.kind === 'replaceIfVersion' && (typeof expected.version !== 'string' || expected.version.length > 4096))) denied();
  }
  private tooLarge(): never { throw new FsError('Remote file operation exceeds host limit', 'FS_TOO_LARGE'); }
}
