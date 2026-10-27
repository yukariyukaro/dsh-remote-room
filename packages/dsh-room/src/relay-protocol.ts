/** Frame protocol shared by the Host connector and every relay implementation (Node or Worker). */

export interface RelayFrameBase { type: string; id?: string }

export interface RequestFrame extends RelayFrameBase {
  type: 'request'
  id: string
  method: string
  path: string
  headers: Record<string, string>
  peer?: string
}

export interface RequestBodyFrame extends RelayFrameBase { type: 'request.body'; id: string; data: string; binary: boolean }
export interface RequestEndFrame extends RelayFrameBase { type: 'request.end'; id: string }
export interface ResponseFrame extends RelayFrameBase { type: 'response'; id: string; status: number; headers: Record<string, string> }
export interface ResponseBodyFrame extends RelayFrameBase { type: 'response.body'; id: string; data: string; binary: boolean }
export interface ResponseEndFrame extends RelayFrameBase { type: 'response.end'; id: string; error?: string }
export interface StreamOpenFrame extends RelayFrameBase { type: 'stream.open'; id: string; path: string; headers: Record<string, string>; peer?: string }
export interface StreamOpenedFrame extends RelayFrameBase { type: 'stream.opened'; id: string; protocol?: string }
export interface StreamFailedFrame extends RelayFrameBase { type: 'stream.failed'; id: string; status: number; reason?: string }
export interface StreamDataFrame extends RelayFrameBase { type: 'stream.data'; id: string; data: string; binary: boolean }
export interface StreamCloseFrame extends RelayFrameBase { type: 'stream.close'; id: string; code?: number; reason?: string }
export interface HelloFrame extends RelayFrameBase { type: 'hello'; room: string; protocol: number }
export interface ReadyFrame extends RelayFrameBase { type: 'ready'; room: string; protocol: number }

export type RelayFrame =
  | RequestFrame | RequestBodyFrame | RequestEndFrame
  | ResponseFrame | ResponseBodyFrame | ResponseEndFrame
  | StreamOpenFrame | StreamOpenedFrame | StreamFailedFrame | StreamDataFrame | StreamCloseFrame
  | HelloFrame | ReadyFrame

/** Bump when a frame's meaning changes; both sides refuse a mismatch instead of guessing. */
export const RELAY_PROTOCOL = 1
/** Largest single body chunk, in bytes before base64 encoding. */
export const RELAY_CHUNK_BYTES = 64 * 1024
/** Refuse a tunneled body that would otherwise be buffered without bound. */
export const RELAY_MAX_BODY_BYTES = 64 * 1024 * 1024

const TYPES = new Set(['hello', 'ready', 'request', 'request.body', 'request.end', 'response', 'response.body', 'response.end', 'stream.open', 'stream.opened', 'stream.failed', 'stream.data', 'stream.close'])

export function isRelayFrame(value: unknown): value is RelayFrame {
  if (typeof value !== 'object' || value === null) return false
  const type = (value as { type?: unknown }).type
  return typeof type === 'string' && TYPES.has(type)
}

/** Payload bytes always travel base64-encoded; `binary` describes the WebSocket frame type, not the codec. */
export function encodeBody(chunk: Uint8Array): { data: string } {
  return { data: Buffer.from(chunk).toString('base64') }
}

export function decodeBody(frame: { data: string }): Buffer {
  return Buffer.from(frame.data, 'base64')
}
