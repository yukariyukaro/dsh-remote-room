import { createPrivateKey, randomBytes, X509Certificate } from 'node:crypto'
import { RoomError } from './protocol.ts'
import { createRoomCredential, validateRoomCredential, type RoomCredential } from './security/credential.ts'

export interface Invitation { roomId: string; relay: string; credential: RoomCredential }

/** The bearer credential stays in the invitation fragment, never relay URLs or persisted room state. */
export async function createInvitation(relay: string): Promise<{ invitation: Invitation; url: string }> {
  const selectedRelay = validateRelay(relay)
  const roomId = randomBytes(24).toString('base64url')
  const invitation = { roomId, relay: selectedRelay, credential: await createRoomCredential(roomId) }
  return { invitation, url: invitationUrl(invitation) }
}
export function invitationUrl(invitation: Invitation): string {
  const url = new URL('dsh-room://join/v2')
  const certificate = new X509Certificate(invitation.credential.certificate).raw.toString('base64url')
  const key = createPrivateKey(invitation.credential.privateKey).export({ type: 'pkcs8', format: 'der' }).toString('base64url')
  url.hash = new URLSearchParams({ relay: invitation.relay, room: invitation.roomId, certificate, key }).toString()
  return url.toString()
}
export function parseInvitation(value: string): Invitation {
  if (typeof value !== 'string' || value.length > 8192) throw new RoomError('INVALID_INVITATION', 'Invitation is too long')
  let url: URL
  try { url = new URL(value) } catch { throw new RoomError('INVALID_INVITATION', 'Invalid invitation URL') }
  if (url.protocol !== 'dsh-room:' || url.hostname !== 'join' || url.pathname !== '/v2' || url.search || url.username || url.password || url.port) throw new RoomError('INVALID_INVITATION', 'Unsupported invitation version; create a new v2 invitation')
  const params = new URLSearchParams(url.hash.slice(1))
  const roomId = params.get('room') ?? ''
  const certificate = params.get('certificate') ?? ''
  const key = params.get('key') ?? ''
  const fields = [...params.keys()]
  if (!/^[A-Za-z0-9_-]{32}$/.test(roomId) || fields.length !== 4 || new Set(fields).size !== 4 || fields.some(field => !['room', 'relay', 'certificate', 'key'].includes(field))) throw new RoomError('INVALID_INVITATION', 'Invalid invitation fields')
  try {
    const certificateDer = decode(certificate, 3072)
    const privateKeyDer = decode(key, 1024)
    const credential = {
      certificate: new X509Certificate(certificateDer).toString(),
      privateKey: createPrivateKey({ key: privateKeyDer, type: 'pkcs8', format: 'der' }).export({ type: 'pkcs8', format: 'pem' }).toString(),
    }
    privateKeyDer.fill(0)
    validateRoomCredential(roomId, credential)
    return { roomId, relay: validateRelay(params.get('relay') ?? ''), credential }
  } catch { throw new RoomError('INVALID_INVITATION', 'Invalid or expired invitation credential') }
}
function decode(value: string, cap: number): Buffer {
  if (!value || value.length > Math.ceil(cap * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid credential encoding')
  const result = Buffer.from(value, 'base64url')
  if (result.length > cap || result.toString('base64url') !== value) throw new Error('Non-canonical credential encoding')
  return result
}
export function validateRelay(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new RoomError('INVALID_RELAY', 'Invalid relay URL') }
  const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) || url.username || url.password || url.hash || url.search) throw new RoomError('INVALID_RELAY', 'Use WSS (or literal loopback WS for local testing), without credentials or query')
  return url.toString().replace(/\/$/, '')
}
