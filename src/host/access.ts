import { lstat as nativeLstat } from 'node:fs/promises';
import path from 'node:path';
import { FsError, type FileSystem, type FsTarget } from '@deepseek-ai/dsh-fs';

export type GrantMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type FileMethod = 'resolve' | 'stat' | 'lstat' | 'readText' | 'readBytes' | 'readByteRange' | 'listDir' | 'streamText' | 'writeText' | 'editText';
export const FILE_METHODS: readonly FileMethod[] = ['resolve', 'stat', 'lstat', 'readText', 'readBytes', 'readByteRange', 'listDir', 'streamText', 'writeText', 'editText'];
export interface HostGrant {
  readonly roomId: string;
  readonly peerId: string;
  readonly epoch: string;
  readonly mode: GrantMode;
  readonly root: string;
  readonly expiresAt: number;
  readonly methods?: readonly FileMethod[];
}
/** Constructed from the authenticated connection by RoomService, never from guest JSON. */
export interface FileCall {
  readonly roomId: string;
  readonly peerId: string;
  readonly epoch: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
}
export interface AccessLease {
  readonly grant: HostGrant;
  readonly signal: AbortSignal;
  check(): void;
}
interface ActiveGrant {
  grant: HostGrant;
  controller: AbortController;
  rootTarget: FsTarget;
  rootIdentity: string;
  timer: ReturnType<typeof setTimeout>;
}
export function denied(): never { throw new FsError('Remote file access denied', 'FS_SANDBOX_DENIED'); }
function aborted(): never { throw new FsError('Remote file operation aborted', 'FS_ABORTED'); }
function validText(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0'); }
function identity(info: Awaited<ReturnType<typeof nativeLstat>>): string { return `${info.dev}:${info.ino}`; }

/**
 * Host-owned grant authority. approve/revoke must NOT be placed on a guest RPC whitelist.
 * Local-only filesystem: native root identity pins directory replacement. Link traversal is
 * conservatively refused, including junctions. This reduces attack surface, NOT the residual
 * canonicalize-to-syscall TOCTOU against a concurrent hostile host-local process.
 */
export class GrantAccess {
  private active?: ActiveGrant;
  constructor(private readonly fs: FileSystem) {}

  async approve(input: HostGrant, signal: AbortSignal): Promise<HostGrant> {
    signal.throwIfAborted();
    if (!validText(input.roomId) || !validText(input.peerId) || !validText(input.epoch) || input.epoch.length > 128 ||
      !['read-only', 'workspace-write', 'danger-full-access'].includes(input.mode) || !validText(input.root) || !path.isAbsolute(input.root) ||
      !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now() || input.expiresAt - Date.now() > 2_147_483_647 ||
      input.methods?.some(method => !FILE_METHODS.includes(method))) denied();
    if (this.active && input.epoch === this.active.grant.epoch) denied();
    const root = path.resolve(input.root);
    await this.noLinks(root, signal);
    const rootTarget = await this.fs.resolve(root, { signal });
    const canonical = this.fs.processPath(rootTarget);
    if (!path.isAbsolute(canonical)) denied();
    const rootInfo = await nativeLstat(root, { bigint: true });
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) denied();
    const canonicalInfo = await nativeLstat(canonical, { bigint: true });
    if (identity(rootInfo) !== identity(canonicalInfo)) denied();
    signal.throwIfAborted();
    const grant: HostGrant = Object.freeze({ ...input, root, methods: Object.freeze([...(input.methods ?? FILE_METHODS)]) });
    this.revoke('replaced');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Grant expired')), Math.max(1, input.expiresAt - Date.now()));
    timer.unref();
    this.active = { grant, controller, rootTarget, rootIdentity: identity(rootInfo), timer };
    return grant;
  }

  revoke(reason = 'revoked'): void {
    const active = this.active;
    if (!active) return;
    clearTimeout(active.timer);
    active.controller.abort(new Error(reason));
    // Retain the epoch to prevent accidental reuse by subsequent approval.
  }

  lease(call: FileCall, method: FileMethod): AccessLease {
    const active = this.active;
    if (!active || !call || !validText(call.requestId) || !(call.signal instanceof AbortSignal)) denied();
    const check = () => {
      if (this.active !== active || active.controller.signal.aborted || active.grant.expiresAt <= Date.now() ||
        call.roomId !== active.grant.roomId || call.peerId !== active.grant.peerId || call.epoch !== active.grant.epoch ||
        !active.grant.methods?.includes(method)) denied();
      if (call.signal.aborted) aborted();
      if ((method === 'writeText' || method === 'editText') && active.grant.mode === 'read-only') denied();
    };
    check();
    return { grant: active.grant, signal: AbortSignal.any([call.signal, active.controller.signal]), check };
  }

  /** Re-resolve for EVERY operation; no caller-supplied FsTarget is ever consumed. */
  async target(lease: AccessLease, requestedPath: string): Promise<FsTarget> {
    lease.check();
    if (!validText(requestedPath)) denied();
    // Refuse parent traversal, Windows device namespaces, ADS and drive-relative paths.
    if (requestedPath.split(/[\\/]/u).includes('..') || (process.platform === 'win32' &&
      (/^[\\/]{2}[?.]/u.test(requestedPath) || /[<>|"*?]/u.test(requestedPath) || requestedPath.replace(/^[a-z]:[\\/]/iu, '').includes(':')))) denied();
    const absolute = path.resolve(lease.grant.root, requestedPath);
    const active = this.active;
    if (!active) denied();
    // Lexical refusal precedes any probe of an unauthorized guest path.
    if (lease.grant.mode !== 'danger-full-access' && !this.lexicallyInside(lease.grant.root, absolute)) denied();
    await this.pin(active, lease);
    await this.noLinks(absolute, lease.signal);
    const fresh = await this.fs.resolve(absolute, { signal: lease.signal });
    if (lease.grant.mode !== 'danger-full-access' && !this.fs.contains(active.rootTarget, fresh)) denied();
    // Final check is against the same fresh target used by the capability.
    await this.pin(active, lease);
    lease.check();
    return fresh;
  }

  private lexicallyInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }
  private async pin(active: ActiveGrant, lease: AccessLease): Promise<void> {
    lease.check();
    try {
      await this.noLinks(active.grant.root, lease.signal);
      const info = await nativeLstat(active.grant.root, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink() || identity(info) !== active.rootIdentity) denied();
      const root = await this.fs.resolve(active.grant.root, { signal: lease.signal });
      if (root.targetKey !== active.rootTarget.targetKey) denied();
    } catch { denied(); }
    lease.check();
  }
  private async noLinks(absolute: string, signal: AbortSignal): Promise<void> {
    const root = path.parse(absolute).root;
    let current = root;
    for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
      if (signal.aborted) aborted();
      current = path.join(current, segment);
      const info = await this.fs.lstat(current, undefined, signal);
      if (info?.type === 'symlink') denied();
      if (!info) break;
    }
  }
}
