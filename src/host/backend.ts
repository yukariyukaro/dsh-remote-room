import { FsVersion, type FileSystem, type FsWriteIntent } from '@deepseek-ai/dsh-fs'
import type { Config } from '../config.ts'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { PROCESS_METHODS, RoomProcesses } from './processes.ts'
import type { HostRoomBackend, OperationContext, RoomGrant } from '../room-service.ts'
import { integer, json, object, RoomError, text, type Json } from '../protocol.ts'
import { GrantAccess } from './access.ts'
import { HostFiles } from './files.ts'
import type { AuditStore } from './audit-store.ts'

/** Explicit operation whitelist: the peer cannot call local management APIs or choose a policy. */
export class FileRoomBackend implements HostRoomBackend {
  private readonly grants: GrantAccess
  private readonly files: HostFiles
  private grant?: RoomGrant
  private readonly processes?: RoomProcesses
  constructor(fs: FileSystem, private readonly audit: AuditStore, config: Config, subprocess?: SubprocessRuntime) {
    if (subprocess) this.processes = new RoomProcesses(subprocess, fs, audit)
    this.grants = new GrantAccess(fs)
    this.files = new HostFiles(fs, this.grants, audit, { maxReadBytes: config.maxFileBytes, maxWriteBytes: config.maxFileBytes, maxListEntries: config.maxDirectoryEntries })
  }
  async authorize(grant: RoomGrant, signal: AbortSignal): Promise<void> {
    await this.grants.approve(grant, signal)
    try {
      await this.processes?.authorize(grant, signal)
      await this.audit.append({ ...grant, requestId: `grant:${grant.epoch}`, operation: 'grant', status: 'granted' }, signal)
      this.grant = grant
    } catch (error) { this.grants.revoke('Authorization failed'); await this.processes?.revoke('Authorization failed'); throw error }
  }
  async revoke(reason: string): Promise<void> {
    this.grants.revoke(reason)
    const results = await Promise.allSettled([this.files.close(), this.processes?.revoke(reason)])
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    const grant = this.grant
    this.grant = undefined
    if (grant) await this.audit.append({ ...grant, requestId: `revoke:${grant.epoch}`, operation: 'revoke', status: 'revoked' })
  }
  async invoke(method: string, input: Json, call: OperationContext): Promise<Json> {
    if ((PROCESS_METHODS as readonly string[]).includes(method)) {
      if (!this.processes) throw new RoomError('CAPABILITY_UNAVAILABLE', 'This host has no remote process provider')
      return this.processes.invoke(method, input, call)
    }
    if (!['audit.query', 'fs.resolve', 'fs.stat', 'fs.lstat', 'fs.list', 'fs.readText', 'fs.readBytes', 'fs.readByteRange', 'fs.streamText', 'fs.streamNext', 'fs.streamClose', 'fs.writeText', 'fs.editText'].includes(method)) throw new RoomError('METHOD_NOT_FOUND', 'This remote capability is not enabled')
    const args = object(input)
    if (method === 'audit.query') {
      this.grants.lease(call, 'resolve').check()
      return json(await this.audit.query({ roomId: call.roomId, ...(args.after === undefined ? {} : { after: integer(args.after, 'audit cursor', 0, Number.MAX_SAFE_INTEGER) }), limit: args.limit === undefined ? 100 : integer(args.limit, 'audit page size', 1, 200) }, call.signal))
    }
    if (method === 'fs.streamNext') return json(await this.files.streamNext(call, text(args.handle, 'stream handle', 128)))
    if (method === 'fs.streamClose') { await this.files.streamClose(call, text(args.handle, 'stream handle', 128)); return null }
    const path = text(args.path, 'remote path')
    switch (method) {
      case 'fs.resolve': return json(await this.files.resolve(call, path))
      case 'fs.stat': return json(await this.files.stat(call, path) ?? null)
      case 'fs.lstat': return json(await this.files.lstat(call, path) ?? null)
      case 'fs.list': return json(await this.files.listDir(call, path))
      case 'fs.readText': return json({ text: await this.files.readText(call, path) })
      case 'fs.readBytes': return { base64: Buffer.from(await this.files.readBytes(call, path)).toString('base64'), mediaType: mediaType(path) }
      case 'fs.readByteRange': return { base64: Buffer.from(await this.files.readByteRange(call, path, { offset: integer(args.offset, 'offset', 0, Number.MAX_SAFE_INTEGER), length: integer(args.length, 'length', 0, 1024 * 1024) })).toString('base64') }
      case 'fs.streamText': return json(await this.files.streamText(call, path))
      case 'fs.writeText': return json(await this.files.writeText(call, path, text(args.content, 'file content', 8 * 1024 * 1024), writeIntent(args.expected)))
      case 'fs.editText': return json(await this.files.editText(call, path, { oldString: text(args.oldString, 'old string', 8 * 1024 * 1024), newString: text(args.newString, 'new string', 8 * 1024 * 1024), replaceAll: args.replaceAll === true }, args.version === undefined ? undefined : { version: FsVersion(text(args.version, 'file version')) }))
      default: throw new RoomError('METHOD_NOT_FOUND', 'This remote capability is not enabled')
    }
  }
}
function writeIntent(value: unknown): FsWriteIntent | undefined {
  if (value === undefined || value === null) return undefined
  const input = object(value)
  if (input.kind === 'createIfAbsent') return { kind: 'createIfAbsent' }
  if (input.kind === 'replaceIfVersion') return { kind: 'replaceIfVersion', version: FsVersion(text(input.version, 'file version')) }
  throw new RoomError('INVALID_INPUT', 'Invalid write intent')
}
function mediaType(path: string): string {
  const extension = path.toLowerCase().split('.').pop()
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' } as Record<string, string>)[extension ?? ''] ?? 'application/octet-stream'
}
