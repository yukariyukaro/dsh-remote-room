/** Shared, browser-safe v1 values. All untrusted JSON is bounded before parsing. */
export type RoomMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type RoomRole = 'host' | 'guest'
export type RoomPhase = 'connecting' | 'authenticating' | 'pending' | 'authorized' | 'closed' | 'failed'

export class RoomError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'RoomError' }
}

export interface RoomSnapshot {
  id: string
  role: RoomRole
  phase: RoomPhase
  epoch: string
  /** Display name agreed by both ends; the shared directory's own name. */
  name?: string
  /** Reach of the relay, so the UI can explain who can join. */
  relayKind?: 'local' | 'lan' | 'public'
  root?: string
  mode?: RoomMode
  expiresAt?: number
  error?: string
}
export interface RoomState { revision: number; rooms: RoomSnapshot[] }

/** JSON frames use explicit binary encodings at the operation layer. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RoomError('INVALID_INPUT', 'Expected an object')
  return value as Record<string, unknown>
}
export function text(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new RoomError('INVALID_INPUT', `Invalid ${name}`)
  return value
}
export function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < min || value > max) throw new RoomError('INVALID_INPUT', `Invalid ${name}`)
  return value
}
export function roomMode(value: unknown): RoomMode {
  if (value !== 'read-only' && value !== 'workspace-write' && value !== 'danger-full-access') throw new RoomError('INVALID_INPUT', 'Invalid permission mode')
  return value
}

/** Validate JSON structure after length-bounded decode, before dispatch or retention. */
export function json(value: unknown, maxDepth = 24, remaining = { items: 50_000 }): Json {
  if (--remaining.items < 0 || maxDepth < 0) throw new RoomError('LIMIT_EXCEEDED', 'JSON nesting or item limit exceeded')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(item => json(item, maxDepth - 1, remaining))
  const record = object(value)
  const result: { [key: string]: Json } = Object.create(null)
  for (const [key, entry] of Object.entries(record)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new RoomError('INVALID_INPUT', 'Unsafe object key')
    result[key] = json(entry, maxDepth - 1, remaining)
  }
  return result
}
