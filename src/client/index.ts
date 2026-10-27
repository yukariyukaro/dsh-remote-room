/** Harness Client entry: isolated room page, settings entry, and remote-only document protocol. */
import type { ComponentType } from 'react'
import { createBridge } from './bridge.ts'
import { createRoomClient } from './state.ts'
import type { ClientSnapshot } from './state.ts'
import { RoomPanel } from './RoomPanel.tsx'
import { Preview } from './Preview.tsx'
import { DOCUMENT_KIND, PROTOCOL, ROOM_KIND, parseFileAddress } from './contracts.ts'
import { en, zh } from './locale.ts'
import type { Translate } from './locale.ts'

/** Structural loading contract; feature packages are never runtime-imported. */
interface ClientContext {
  effect(effect: () => (() => void) | void, label?: string): unknown
  locale: { register(namespace: string, dictionaries: object): () => void; bind(namespace: string): Translate }
  sidebarRightTabs: { register(definition: { id: string; kind: string; keepMounted?: boolean; patterns?: string[]; priority?: 'extension'; canOpen?: (address: string) => boolean; title: (address: string) => string; guide?: { id: string; order: number; title: () => string; description: () => string }[] }): () => void }
  slots: { inject(name: string, factory: () => (() => void)): () => void; register<P>(options: object, component: ComponentType<P>): () => void }
  resources: { register(provider: { protocol: string; open(address: string, context: { signal: AbortSignal }): AsyncIterable<ResourceFrame> }): () => void }
}
type ResourceFrame = { ok: true; value: { roomId: string; epoch: string; path: string; source: 'remote-room'; authorized: boolean } } | { ok: false; error: { code: string; message: string; details: object } }
export const inject = ['slots', 'sidebarRightTabs', 'resources', 'locale']
const ROOM_ID = 'dsh-remote-room/room'
const DOCUMENT_ID = 'dsh-remote-room/document'
function titleOf(address: string): string {
  const parsed = parseFileAddress(address)
  return parsed?.path.split(/[\\/]/u).pop() || address
}
/** Called by the Harness lazy module factory. All contributions leave with this fiber. */
export function apply(ctx: ClientContext): void {
  const api = createBridge()
  const client = createRoomClient(api)
  const t = ctx.locale.bind('remoteRoom')
  const face = {
    api,
    mutate: <T,>(operation: Promise<T>) => client.changed(operation),
    refresh: () => client.refresh(),
    hooks: { roomState: client.source },
  }
  ctx.effect(() => ctx.locale.register('remoteRoom', { en, zh }), 'remote-room: dictionaries')
  ctx.effect(() => { const lifetime = new AbortController(); const stop = client.start(lifetime.signal); return () => { lifetime.abort(); stop() } }, 'remote-room: Host observation')
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: ROOM_ID, kind: ROOM_KIND, keepMounted: true, title: () => t('title'), guide: [{ id: 'connect', order: 45, title: () => t('title'), description: () => t('guide') }] }), 'remote-room: workbench type')
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: DOCUMENT_ID, kind: DOCUMENT_KIND, keepMounted: true, patterns: ['dsh-resource://remote-room-file/**'], priority: 'extension', canOpen: address => parseFileAddress(address) !== undefined, title: titleOf }), 'remote-room: remote document type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: ROOM_ID, locale: 'remoteRoom', inject: () => face }, RoomPanel)), 'remote-room: workbench body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: DOCUMENT_ID, locale: 'remoteRoom', inject: () => ({ api, hooks: { roomState: client.source } }) }, Preview)), 'remote-room: document body')
  // A root settings entry works without a mounted conversation. Remote files remain disabled here.
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dsh-remote-room', order: 45, label: () => t('title'), locale: 'remoteRoom', inject: () => ({ ...face, canOpenFiles: false }) }, RoomPanel)), 'remote-room: settings entry')
  ctx.effect(() => ctx.resources.register({
    protocol: PROTOCOL,
    async *open(address, { signal }): AsyncIterable<ResourceFrame> {
      const ref = parseFileAddress(address)
      if (!ref) { yield { ok: false, error: { code: 'remote-room/invalid-address', message: 'Invalid remote file address', details: {} } }; return }
      let latest: ClientSnapshot = client.source.getSnapshot()
      let wake: (() => void) | undefined
      let dirty = true
      const changed = (): void => { latest = client.source.getSnapshot(); dirty = true; wake?.(); wake = undefined }
      const stop = client.source.subscribe(changed)
      const abort = (): void => { wake?.(); wake = undefined }
      signal.addEventListener('abort', abort, { once: true })
      try {
        while (!signal.aborted) {
          if (!dirty) await new Promise<void>(resolve => { wake = resolve; if (signal.aborted) resolve() })
          if (signal.aborted) return
          dirty = false
          const room = latest.state.rooms.find(value => value.id === ref.roomId)
          if (latest.connected && room?.phase === 'authorized' && room.epoch === ref.epoch) yield { ok: true, value: { ...ref, source: 'remote-room', authorized: true } }
          else yield { ok: false, error: { code: room?.epoch !== ref.epoch ? 'remote-room/stale-epoch' : 'remote-room/not-authorized', message: 'Remote identity changed or access is not authorized', details: { roomId: ref.roomId } } }
        }
      } finally { stop(); signal.removeEventListener('abort', abort) }
    },
  }), 'remote-room: resource provider')
}
