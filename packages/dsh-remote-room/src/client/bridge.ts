/** Same-origin, authenticated Host bridge. Invitations are deliberate bearer secrets; never persist them. */
import type { Failure, RemoteRoomApi, Result, RoomState } from './contracts.ts'
export class BridgeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'BridgeError' }
}
export function failureOf(error: unknown): Failure {
  return error instanceof BridgeError ? { code: error.code, message: error.message }
    : { code: 'remote-room/request-failed', message: error instanceof Error ? error.message : String(error) }
}
/** API paths respect an application deployment prefix when supplied by the loader. */
export function createBridge(baseUrl: string = document.baseURI): RemoteRoomApi {
  const endpoint = new URL('api/remote-room', baseUrl.endsWith('/') ? baseUrl : new URL('.', baseUrl).href)
  async function call<T>(action: string, input: object = {}, signal?: AbortSignal): Promise<T> {
    const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ action, ...input }) })
    if (!response.ok) throw new BridgeError(`http/${response.status}`, `Host request failed (${response.status})`)
    const result = await response.json() as Result<T>
    if (typeof result !== 'object' || result === null || typeof result.ok !== 'boolean') throw new BridgeError('remote-room/invalid-response', 'Invalid Host response')
    if (!result.ok) throw new BridgeError(result.error.code, result.error.message)
    return result.value
  }
  return {
    state: signal => call('state', {}, signal),
    create: (input, signal) => call('create', input, signal),
    join: (invitation, signal) => call('join', { invitation }, signal),
    approve: id => call('approve', { id }), revoke: id => call('revoke', { id }), close: id => call('close', { id }),
    settings: signal => call('settings', {}, signal),
    updateSettings: (patch, signal) => call('settings.update', patch, signal),
    list: (ref, signal) => call('list', { id: ref.roomId, epoch: ref.epoch, path: ref.path }, signal),
    readText: (ref, signal) => call('readText', { id: ref.roomId, epoch: ref.epoch, path: ref.path }, signal),
    readBytes: (ref, signal) => call('readBytes', { id: ref.roomId, epoch: ref.epoch, path: ref.path, maxBytes: 8 * 1024 * 1024 }, signal),
    audit: (id, signal) => call('audit', { id }, signal),
    process: (ref, method, args, signal) => call('process', { id: ref.roomId, epoch: ref.epoch, method, args }, signal),
    watch(changed, failed, signal) {
      if (signal.aborted) return () => {}
      const url = new URL(`${endpoint.pathname}/events`, endpoint)
      const source = new EventSource(url.href, { withCredentials: true })
      const message = (event: MessageEvent<string>): void => {
        try {
          const value: unknown = JSON.parse(event.data)
          if (typeof value !== 'object' || value === null || !('revision' in value) || !('rooms' in value) || !Array.isArray(value.rooms)) throw new Error('Invalid event snapshot')
          changed(value as RoomState)
        } catch (error) { failed(failureOf(error)) }
      }
      source.addEventListener('message', message)
      source.addEventListener('error', () => failed({ code: 'remote-room/events-disconnected', message: 'Connection updates interrupted; reconnecting.' }))
      const close = (): void => { source.close(); signal.removeEventListener('abort', close) }
      signal.addEventListener('abort', close, { once: true })
      return close
    },
  }
}
