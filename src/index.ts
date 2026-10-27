import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-storage'
import type {} from '@deepseek-ai/dsh-subprocess'
import { Config } from './config.ts'
import { RemoteRoomManager } from './room-service.ts'
import { RoomController } from './host/controller.ts'
import { FileRoomBackend } from './host/backend.ts'
import { KvAuditStore } from './host/audit-store.ts'
import { registerRemoteTools } from './guest/tools.ts'
import { registerRemoteProcessTools } from './guest/process-tools.ts'

export { Config }
export const name = 'remote-room'
export const inject = ['fs', 'connection', 'storage', 'tools', 'subprocess']

/** The Host half never opens a listener or creates an Agent/session. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const backend = ctx.storage.backend.get(config.auditBackend)
  if (!backend.kv) throw new Error(`Remote room requires a KV audit backend: ${config.auditBackend}`)
  const unit = await backend.kv.open({ name: 'remote_room_audit', version: 1, tables: [], hasGlobal: true, layout: 'single' })
  const audit = await KvAuditStore.open(unit, { maxEntries: config.auditMaxEntries, maxBytes: config.auditMaxBytes })
  const manager = new RemoteRoomManager(config, () => new FileRoomBackend(ctx.fs, audit, config, ctx.subprocess))
  const controller = new RoomController(manager, ctx.connection, 128 * 1024)
  ctx.effect(() => async () => {
    await controller.dispose()
    try { await manager.dispose() } finally { await audit.close() }
  })
  controller.mount()
  ctx.effect(() => registerRemoteTools(ctx, manager), 'remote-room: explicit remote tools')
  ctx.effect(() => registerRemoteProcessTools(ctx, manager), 'remote-room: explicit remote process tools')
}
