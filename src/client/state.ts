/** One apply-owned bridge observer; components consume its framework-bound source hook. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { failureOf } from './bridge.ts'
import type { Failure, RemoteRoomApi, RoomSnapshot, RoomState } from './contracts.ts'
export interface ClientSnapshot { state: RoomState; connected: boolean; failure?: Failure }
export function createRoomClient(api: RemoteRoomApi) {
  const source = createSnapshotStore<ClientSnapshot>({ state: { revision: -1, rooms: [] }, connected: false })
  const commit = (state: RoomState): void => {
    if (state.revision < source.getSnapshot().state.revision) return
    // HTTP snapshots are data, not evidence that the update stream is live.
    source.update(s => { s.state = state })
  }
  const readFailed = (error: unknown): void => {
    // A failed read does not diagnose the independent SSE carrier or replace its failure.
    source.update(s => { s.failure ??= failureOf(error) })
  }
  let stopWatch: (() => void) | undefined
  return {
    source,
    start(signal: AbortSignal) {
      stopWatch?.()
      if (signal.aborted) return () => {}
      let active = true
      let disposeWatch = () => {}
      const stop = (): void => {
        if (!active) return
        active = false
        signal.removeEventListener('abort', stop)
        disposeWatch()
        if (stopWatch === stop) stopWatch = undefined
        source.update(s => { s.connected = false })
      }
      stopWatch = stop
      signal.addEventListener('abort', stop, { once: true })
      disposeWatch = api.watch(state => {
        if (!active || signal.aborted) return
        // Even an older baseline proves stream recovery, but must not roll data back.
        source.update(s => {
          if (state.revision >= s.state.revision) s.state = state
          s.connected = true
          delete s.failure
        })
      }, failure => {
        if (!active || signal.aborted) return
        source.update(s => { s.connected = false; s.failure = failure })
      }, signal)
      void api.state(signal).then(state => {
        if (active && !signal.aborted) commit(state)
      }, error => { if (active && !signal.aborted) readFailed(error) })
      return stop
    },
    async refresh(signal?: AbortSignal) {
      try {
        const state = await api.state(signal)
        if (!signal?.aborted) commit(state)
      } catch (error) {
        if (!signal?.aborted) readFailed(error)
        throw error
      }
    },
    room(id: string): RoomSnapshot | undefined { return source.getSnapshot().state.rooms.find(room => room.id === id) },
    async changed<T>(operation: Promise<T>): Promise<T> {
      const value = await operation
      // A successful mutation must not be reported as failed just because its following read loses the carrier.
      void api.state().then(commit, readFailed)
      return value
    },
  }
}
export type RoomClient = ReturnType<typeof createRoomClient>
