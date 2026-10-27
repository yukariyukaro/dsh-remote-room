import { describe, expect, it, vi } from 'vitest'
import { BridgeError } from '../../src/client/bridge.ts'
import type { Failure, RemoteRoomApi, RoomState } from '../../src/client/contracts.ts'
import { createRoomClient } from '../../src/client/state.ts'

// Only the transport is controlled: state.ts imports the real dsh-client-store engine.
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const snapshot = (revision: number): RoomState => ({ revision, rooms: [] })
const disconnected: Failure = { code: 'remote-room/events-disconnected', message: 'Updates interrupted' }
function setup() {
  const requests: ReturnType<typeof deferred<RoomState>>[] = []
  const watchers: { changed: (value: RoomState) => void; failed: (failure: Failure) => void; stop: ReturnType<typeof vi.fn> }[] = []
  const state = vi.fn<RemoteRoomApi['state']>(() => {
    const request = deferred<RoomState>()
    requests.push(request)
    return request.promise
  })
  const watch = vi.fn<RemoteRoomApi['watch']>((changed, failed) => {
    const watcher = { changed, failed, stop: vi.fn() }
    watchers.push(watcher)
    return watcher.stop
  })
  const client = createRoomClient({ state, watch } as unknown as RemoteRoomApi)
  const controller = new AbortController()
  const start = () => client.start(controller.signal)
  // Drain the finite promise chain; no timers, network, credentials, or manual polling.
  const settle = async () => { await Promise.resolve(); await Promise.resolve() }
  return { client, controller, state, watch, requests, watchers, start, settle }
}

describe('room client state and watch readiness (real snapshot store)', () => {
  it('starts disconnected and an initial HTTP success does not prove watch readiness', async () => {
    const h = setup()
    expect(h.client.source.getSnapshot()).toEqual({ state: snapshot(-1), connected: false })
    h.start()
    h.requests[0]!.resolve(snapshot(1))
    await h.settle()
    expect(h.client.source.getSnapshot()).toEqual({ state: snapshot(1), connected: false })
    expect(h.watch).toHaveBeenCalledOnce()
    expect(h.state).toHaveBeenCalledExactlyOnceWith(h.controller.signal)
  })

  it('keeps a failed watch disconnected when the initial HTTP response arrives later', async () => {
    const h = setup()
    h.start()
    h.watchers[0]!.failed(disconnected)
    h.requests[0]!.resolve(snapshot(2))
    await h.settle()
    expect(h.client.source.getSnapshot()).toEqual({ state: snapshot(2), connected: false, failure: disconnected })
  })

  it('marks an already initialized client disconnected when its watch fails', async () => {
    const h = setup()
    h.start()
    h.requests[0]!.resolve(snapshot(1))
    await h.settle()
    h.watchers[0]!.changed(snapshot(2))
    h.watchers[0]!.failed(disconnected)
    expect(h.client.source.getSnapshot()).toEqual({ state: snapshot(2), connected: false, failure: disconnected })
  })

  it('refresh updates data without clearing a watch failure or claiming a live stream', async () => {
    const h = setup()
    h.start()
    h.watchers[0]!.failed(disconnected)
    const refreshing = h.client.refresh()
    h.requests[1]!.resolve(snapshot(3))
    await refreshing
    expect(h.client.source.getSnapshot()).toEqual({ state: snapshot(3), connected: false, failure: disconnected })
  })

  it('post-mutation reads update data without clearing a watch failure', async () => {
    const h = setup()
    h.start()
    h.watchers[0]!.failed(disconnected)
    await expect(h.client.changed(Promise.resolve('mutated'))).resolves.toBe('mutated')
    h.requests[1]!.resolve(snapshot(4))
    await h.settle()
    expect(h.client.source.getSnapshot()).toEqual({ state: snapshot(4), connected: false, failure: disconnected })
  })

  it('only a watch snapshot recovers readiness and clears failure, including an equal revision', async () => {
    const h = setup()
    h.start()
    h.requests[0]!.resolve(snapshot(5))
    await h.settle()
    h.watchers[0]!.failed(disconnected)
    h.watchers[0]!.changed(snapshot(5))
    expect(h.client.source.getSnapshot()).toEqual({ state: snapshot(5), connected: true })
  })

  it('does not roll back data when a recovered stream baseline trails the HTTP revision', async () => {
    const h = setup()
    h.start()
    h.requests[0]!.resolve(snapshot(10))
    await h.settle()
    h.watchers[0]!.failed(disconnected)
    h.watchers[0]!.changed(snapshot(9))
    expect(h.client.source.getSnapshot()).toEqual({ state: snapshot(10), connected: true })
  })

  it('rejects older HTTP responses and watch snapshots without losing readiness', async () => {
    const h = setup()
    h.start()
    const refreshing = h.client.refresh()
    h.watchers[0]!.changed(snapshot(8))
    h.requests[1]!.resolve(snapshot(7))
    await refreshing
    h.requests[0]!.resolve(snapshot(1))
    await h.settle()
    h.watchers[0]!.changed(snapshot(6))
    expect(h.client.source.getSnapshot()).toEqual({ state: snapshot(8), connected: true })
  })

  it('initial HTTP rejection preserves carrier readiness and reports the request failure', async () => {
    const h = setup()
    h.start()
    h.watchers[0]!.changed(snapshot(2))
    h.requests[0]!.reject(new BridgeError('http/503', 'Read unavailable'))
    await h.settle()
    expect(h.client.source.getSnapshot()).toEqual({ state: snapshot(2), connected: true, failure: { code: 'http/503', message: 'Read unavailable' } })
    h.watchers[0]!.changed(snapshot(2))
    expect(h.client.source.getSnapshot()).toEqual({ state: snapshot(2), connected: true })
  })

  it('does not replace a stream failure with a late HTTP rejection', async () => {
    const h = setup()
    h.start()
    h.watchers[0]!.failed(disconnected)
    h.requests[0]!.reject(new Error('Late read failure'))
    await h.settle()
    expect(h.client.source.getSnapshot()).toEqual({ state: snapshot(-1), connected: false, failure: disconnected })
  })

  it('refresh rejection is observable without disconnecting a healthy watch', async () => {
    const h = setup()
    h.start()
    h.watchers[0]!.changed(snapshot(1))
    const error = new BridgeError('http/503', 'Read unavailable')
    const refreshing = h.client.refresh()
    const assertion = expect(refreshing).rejects.toBe(error)
    h.requests[1]!.reject(error)
    await assertion
    expect(h.client.source.getSnapshot()).toMatchObject({ connected: true, failure: { code: 'http/503' } })
  })

  it('a failed post-mutation read neither rejects the mutation nor disconnects the watch', async () => {
    const h = setup()
    h.start()
    h.watchers[0]!.changed(snapshot(1))
    await expect(h.client.changed(Promise.resolve('done'))).resolves.toBe('done')
    h.requests[1]!.reject(new Error('Read failed'))
    await h.settle()
    expect(h.client.source.getSnapshot()).toMatchObject({ connected: true, failure: { message: 'Read failed' } })
    const error = new Error('Mutation rejected')
    await expect(h.client.changed(Promise.reject(error))).rejects.toBe(error)
    expect(h.state).toHaveBeenCalledTimes(2)
  })

  it('abort closes once and ignores queued watch callbacks and late initial HTTP success', async () => {
    const h = setup()
    const stop = h.start()
    h.watchers[0]!.changed(snapshot(1))
    h.controller.abort()
    stop()
    h.watchers[0]!.changed(snapshot(99))
    h.watchers[0]!.failed(disconnected)
    h.requests[0]!.resolve(snapshot(100))
    await h.settle()
    expect(h.watchers[0]!.stop).toHaveBeenCalledOnce()
    expect(h.client.source.getSnapshot()).toEqual({ state: snapshot(1), connected: false })
  })

  it('explicit stop ignores a late initial rejection without requiring signal abort', async () => {
    const h = setup()
    const stop = h.start()
    stop()
    h.requests[0]!.reject(new Error('Disposed read'))
    await h.settle()
    expect(h.client.source.getSnapshot()).toEqual({ state: snapshot(-1), connected: false })
    expect(h.watchers[0]!.stop).toHaveBeenCalledOnce()
  })

  it('does not start transport for a pre-aborted signal', () => {
    const h = setup()
    h.controller.abort()
    h.start()()
    expect(h.watch).not.toHaveBeenCalled()
    expect(h.state).not.toHaveBeenCalled()
  })

  it('a replacement start owns readiness and ignores the old lifecycle', async () => {
    const h = setup()
    const oldStop = h.start()
    h.watchers[0]!.changed(snapshot(1))
    const next = new AbortController()
    h.client.start(next.signal)
    h.watchers[1]!.changed(snapshot(2))
    oldStop()
    h.controller.abort()
    h.watchers[0]!.failed(disconnected)
    h.watchers[0]!.changed(snapshot(99))
    h.requests[0]!.resolve(snapshot(100))
    await h.settle()
    expect(h.client.source.getSnapshot()).toEqual({ state: snapshot(2), connected: true })
    expect(h.watchers[0]!.stop).toHaveBeenCalledOnce()
  })

  it('publishes stream recovery data and readiness in a single real-store notification', () => {
    const h = setup()
    h.start()
    h.watchers[0]!.failed(disconnected)
    const observed: unknown[] = []
    const unsubscribe = h.client.source.subscribe(() => { observed.push(h.client.source.getSnapshot()) })
    h.watchers[0]!.changed(snapshot(3))
    unsubscribe()
    expect(observed).toEqual([{ state: snapshot(3), connected: true }])
  })

  it('a standalone refresh loads data without advertising a live watch', async () => {
    const h = setup()
    const refreshing = h.client.refresh()
    h.requests[0]!.resolve(snapshot(4))
    await refreshing
    expect(h.client.source.getSnapshot()).toEqual({ state: snapshot(4), connected: false })
    expect(h.watch).not.toHaveBeenCalled()
  })

  it('propagates refresh cancellation without recording it as a request or carrier failure', async () => {
    const h = setup()
    const refreshing = h.client.refresh(h.controller.signal)
    const error = new DOMException('Cancelled', 'AbortError')
    const assertion = expect(refreshing).rejects.toBe(error)
    h.controller.abort()
    h.requests[0]!.reject(error)
    await assertion
    expect(h.client.source.getSnapshot()).toEqual({ state: snapshot(-1), connected: false })
  })

  it('ignores a refresh response after its signal is aborted', async () => {
    const h = setup()
    const refreshing = h.client.refresh(h.controller.signal)
    h.controller.abort()
    h.requests[0]!.resolve(snapshot(100))
    await refreshing
    expect(h.client.source.getSnapshot()).toEqual({ state: snapshot(-1), connected: false })
  })
})
