import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.ts'
import type { Config as ConfigShape } from './config.ts'
import type { HostConnection, HostServices } from './contracts.ts'
import { RoomRegistry } from './room-state.ts'
import { RoomService } from './service.ts'
import { RoomAdmin } from './admin.ts'

export { Config }
export const name = 'room'
export const inject = ['webServer', 'connection']

/** Resolve the loopback listener this Host is actually serving right now. */
function upstreamOf(host: HostServices): { host: string; port: number; secure: boolean; origin: string; authenticatedUrl: () => string } {
  const origin = new URL(host.webServer.getOrigin())
  const hostname = origin.hostname.replace(/^\[|\]$/gu, '')
  const port = Number(origin.port === '' ? (origin.protocol === 'https:' ? 443 : 80) : origin.port)
  const base = `${host.webServer.protocol}//${origin.host}`
  return { host: hostname, port, secure: origin.protocol === 'https:', origin: origin.origin, authenticatedUrl: () => host.connection.authenticatedUrl(base) }
}

export function apply(ctx: Context, config: ConfigShape): void {
  const host = ctx as unknown as Context & HostServices
  const registry = new RoomRegistry({
    invitationTtlMs: config.invitationTtlMs,
    pendingTtlMs: config.pendingTtlMs,
    sessionIdleTtlMs: config.sessionIdleTtlMs,
    sessionMaxTtlMs: config.sessionMaxTtlMs,
    maxPending: config.maxPending,
    maxMembers: config.maxMembers,
  })
  const log = (line: string): void => {
    try { (ctx as unknown as { logger: { info(value: string): void } }).logger.info(line) } catch { /* logging is best effort */ }
  }
  const service = new RoomService(registry, config, () => upstreamOf(host), log)
  const admin = new RoomAdmin(registry, service)
  ctx.effect(() => {
    admin.mount(host.connection as unknown as HostConnection)
    return () => admin.dispose()
  }, 'room: owner bridge')
  ctx.effect(() => () => service.dispose(), 'room: lifecycle')
}
