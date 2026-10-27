/** Browser DTOs agreed with the Host bridge; a remote path is never a local Host file. */
export type { RoomMode } from '../protocol.ts'
import type { RoomMode, Json } from '../protocol.ts'
export type { Json } from '../protocol.ts'
export type ProcessMethod = 'exec.start' | 'exec.read' | 'exec.write' | 'exec.kill' | 'pty.start' | 'pty.read' | 'pty.write' | 'pty.resize' | 'pty.kill'
export type ProcessKind = 'exec' | 'pty'
export interface ProcessStart { handle: string; cursor: number; kind: ProcessKind; access: 'full-host-and-network' }
export interface ProcessChunk { stream: 'stdout' | 'stderr' | 'terminal'; text: string; from: number; to: number }
export interface ProcessPage { chunks: ProcessChunk[]; nextCursor: number; oldestCursor: number; latestCursor: number; gap: boolean; gapBytes: number; outputClosed: boolean; status: { state: 'starting' | 'running' | 'exited' | 'error'; exitCode: number | null; signal: string | null; reason: string | null } }
export interface Failure { code: string; message: string }
export type Result<T> = { ok: true; value: T } | { ok: false; error: Failure }
export type { RoomSnapshot, RoomState } from '../protocol.ts'
import type { RoomSnapshot, RoomState } from '../protocol.ts'
export interface AuditEntry { seq: number; time: number; operation: string; status: string; path?: string; code?: string; outcome?: { version: string; operation?: 'create' | 'update'; beforeBytes: number | null; afterBytes: number; content: 'omitted' } }
export interface RemoteFileRef { roomId: string; epoch: string; path: string }
export interface DirectoryEntry { name: string; type: 'file' | 'directory' | 'other'; target: { targetKey: string; displayPath: string }; version?: string; size?: number }
export interface TextFile { text: string; version?: string }
export interface FileBytes { base64: string; mediaType: string }
/** Reach of a share; sharing targets separate networks by default. */
export type ShareScope = 'lan' | 'public'
export interface CreateRequest { root: string; mode: RoomMode; scope: ShareScope; relay?: string }
export interface CreateResult { room: RoomSnapshot; invitation: string }
/** Owner-visible preferences; the relay secret is reported as a boolean, never as a value. */
export interface ShareSettingsView { version: 1; scope: ShareScope; relayUrl: string; lastRoot: string; hasRelayCreateToken: boolean; defaultRelay: string }
export interface SettingsPatch { scope?: ShareScope; relayUrl?: string; lastRoot?: string; relayCreateToken?: string }
export interface RemoteRoomApi {
  state(signal?: AbortSignal): Promise<RoomState>
  create(input: CreateRequest, signal?: AbortSignal): Promise<CreateResult>
  join(invitation: string, signal?: AbortSignal): Promise<RoomSnapshot>
  approve(id: string): Promise<RoomSnapshot>
  revoke(id: string): Promise<RoomSnapshot>
  close(id: string): Promise<RoomSnapshot>
  settings(signal?: AbortSignal): Promise<ShareSettingsView>
  updateSettings(patch: SettingsPatch, signal?: AbortSignal): Promise<ShareSettingsView>
  list(ref: RemoteFileRef, signal?: AbortSignal): Promise<DirectoryEntry[]>
  readText(ref: RemoteFileRef, signal?: AbortSignal): Promise<TextFile>
  readBytes(ref: RemoteFileRef, signal?: AbortSignal): Promise<FileBytes>
  audit(id: string, signal?: AbortSignal): Promise<AuditEntry[]>
  process(ref: Pick<RemoteFileRef, 'roomId' | 'epoch'>, method: ProcessMethod, args: Json, signal?: AbortSignal): Promise<Json>
  watch(changed: (snapshot: RoomState) => void, failed: (error: Failure) => void, signal: AbortSignal): () => void
}
export const PROTOCOL = 'remote-room-file'
export const ROOM_KIND = 'remote-room'
export const DOCUMENT_KIND = 'remote-room-document'
/** Encode path segments without interpreting them as local OS paths. */
export function fileAddress(ref: RemoteFileRef): string {
  return `dsh-resource://${PROTOCOL}/room/${encodeURIComponent(ref.roomId)}/epoch/${encodeURIComponent(ref.epoch)}/path/${ref.path.split('/').map(encodeURIComponent).join('/')}`
}
/** Syntax parsing is separate from the Host's room authorization and confinement. */
export function parseFileAddress(address: string): RemoteFileRef | undefined {
  const match = /^dsh-resource:\/\/remote-room-file\/room\/([^/]+)\/epoch\/([^/]+)\/path\/([^?#]*)$/.exec(address)
  if (!match) return undefined
  try {
    const ref = { roomId: decodeURIComponent(match[1]!), epoch: decodeURIComponent(match[2]!), path: match[3]!.split('/').map(decodeURIComponent).join('/') }
    return ref.roomId && ref.epoch && !ref.path.includes('\0') ? ref : undefined
  } catch { return undefined }
}
