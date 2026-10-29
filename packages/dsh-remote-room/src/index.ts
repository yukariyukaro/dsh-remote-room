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
import { ShareSettingsStore } from './host/settings.ts'
import { RelayHost, bundledRelay } from './host/relay-host.ts'
import { resolveShare } from './share.ts'
import { registerRemoteTools } from './guest/tools.ts'
import { registerRemoteProcessTools } from './guest/process-tools.ts'
import { registerGuideTool } from './guide.ts'

export { Config }
export const name = 'remote-room'
export const inject = ['fs', 'connection', 'storage', 'tools', 'subprocess']

/** The Host half never opens a listener or creates an Agent/session. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const backend = ctx.storage.backend.get(config.auditBackend)
  if (!backend.kv) throw new Error(`Remote room requires a KV audit backend: ${config.auditBackend}`)
  const unit = await backend.kv.open({ name: 'remote_room_audit', version: 1, tables: [], hasGlobal: true, layout: 'single' })
  const audit = await KvAuditStore.open(unit, { maxEntries: config.auditMaxEntries, maxBytes: config.auditMaxBytes })
  const settingsUnit = await backend.kv.open({ name: 'remote_room_settings', version: 1, tables: [], hasGlobal: true, layout: 'single' })
  const settings = await ShareSettingsStore.open(settingsUnit)
  // Relays start on the first share; nothing listens while the plugin is idle.
  const relays = new RelayHost(bundledRelay)
  const manager = new RemoteRoomManager(config, () => new FileRoomBackend(ctx.fs, audit, config, ctx.subprocess))
  const controller = new RoomController(manager, ctx.connection, 128 * 1024, {
    create: input => resolveShare(input, { settings, relays, config }),
    settings: () => settings.current(),
    update: patch => settings.update(patch),
    defaultRelay: () => process.env.DSH_REMOTE_ROOM_RELAY || config.relayUrl,
  })
  ctx.effect(() => async () => {
    const failures: unknown[] = []
    const settle = async (step: () => Promise<void>): Promise<void> => { try { await step() } catch (error) { failures.push(error) } }
    await settle(() => controller.dispose())
    await settle(() => manager.dispose())
    await settle(() => relays.dispose())
    await settle(() => audit.close())
    await settle(() => settings.close())
    if (failures.length) throw new AggregateError(failures, 'Some remote room resources could not confirm cleanup')
  })
  controller.mount()
  ctx.effect(() => registerRemoteTools(ctx, manager), 'remote-room: explicit remote tools')
  ctx.effect(() => registerRemoteProcessTools(ctx, manager), 'remote-room: explicit remote process tools')
  ctx.effect(() => registerGuideTool(ctx), 'remote-room: guide locator')
}
