import { afterEach, describe, expect, it } from 'vitest'
import { RoomController } from '../../src/host/controller.ts'
import { RemoteRoomManager } from '../../src/room-service.ts'
import { Config } from '../../src/config.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function setup() {
  const routes = new Map<string, { methods: readonly string[]; requestBody: string; fetch(request: Request): Promise<Response> }>()
  let removed = 0
  const connection = {
    browserPeer: { id: 'browser-owner' },
    admit(request: Request) {
      const cookie = request.headers.get('cookie')
      if (cookie === 'browser=owner') return { peer: { id: 'browser-owner', principal: { kind: 'owner' } } }
      if (cookie === 'api=owner') return { peer: { id: 'api-owner', principal: { kind: 'owner' } } }
      return { rejection: 401 }
    },
    fetch: { register(route: { path: string; methods: readonly string[]; requestBody: string; fetch(request: Request): Promise<Response> }) {
      routes.set(route.path, route)
      return async () => { routes.delete(route.path); removed++ }
    } },
  }
  const manager = new RemoteRoomManager(Config({}), () => { throw new Error('No test backend') })
  const controller = new RoomController(manager, connection, 1024)
  controller.mount()
  cleanups.push(() => manager.dispose(), () => controller.dispose())
  const request = (body: object, cookie?: string) => new Request('http://127.0.0.1/api/remote-room', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) })
  return { routes, manager, controller, request, removed: () => removed }
}

describe('local controller admission / streaming lifetime', () => {
  it('rejects anonymous and independent API owners, permits local browser without an Agent/session', async () => {
    const { controller, request } = setup()
    for (const cookie of [undefined, 'api=owner']) {
      const response = await controller.handle(request({ action: 'approve', id: 'no-room' }, cookie))
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    const response = await controller.handle(request({ action: 'state' }, 'browser=owner'))
    expect(await response.json()).toEqual({ ok: true, value: { revision: 0, rooms: [] } })
    const approval = await controller.handle(request({ action: 'approve', id: 'no-room' }, 'browser=owner'))
    expect(await approval.json()).toMatchObject({ ok: false, error: { code: 'ROOM_NOT_FOUND' } })
  })

  it('bounds the complete request and rejects unsupported actions', async () => {
    const { controller, request } = setup()
    const huge = await controller.handle(request({ action: 'join', invitation: 'x'.repeat(1024) }, 'browser=owner'))
    expect(await huge.json()).toMatchObject({ ok: false, error: { code: 'LIMIT_EXCEEDED' } })
    const invalid = await controller.handle(request({ action: 'execute', id: 'no-room' }, 'browser=owner'))
    expect(await invalid.json()).toMatchObject({ ok: false })
  })

  it('allows browser stream cancellation without a controller double-close', async () => {
    const { routes } = setup()
    const response = await routes.get('/api/remote-room/events')!.fetch(new Request('http://127.0.0.1/api/remote-room/events', { headers: { cookie: 'browser=owner' } }))
    const reader = response.body!.getReader()
    await reader.read()
    await expect(reader.cancel()).resolves.toBeUndefined()
    reader.releaseLock()
  })

  it('starts SSE with a complete baseline and ends existing sinks when the plugin unloads', async () => {
    const { routes, controller, removed } = setup()
    // The HTTP carrier must construct a bodyless GET; response streaming is independent.
    expect(routes.get('/api/remote-room/events')).toMatchObject({ methods: ['GET'], requestBody: 'buffered' })
    const response = await routes.get('/api/remote-room/events')!.fetch(new Request('http://127.0.0.1/api/remote-room/events', { headers: { cookie: 'browser=owner' } }))
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: {"revision":0,"rooms":[]}')
    await controller.dispose()
    expect(await reader.read()).toMatchObject({ done: true })
    expect(routes.size).toBe(0)
    expect(removed()).toBe(2)
    reader.releaseLock()
  })
})
