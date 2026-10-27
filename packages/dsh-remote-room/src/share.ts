/** Turns a share request into one validated target: directory, room name, permission, relay. */
import path from 'node:path'
import { validateRelay } from './invite.ts'
import { RoomError, roomMode, text, type RoomMode } from './protocol.ts'
import { rememberShare, shareScope, type ShareScope, type ShareSettings } from './host/settings.ts'
import type { RelayEndpoint, RelayKind } from './host/relay-host.ts'

export interface ShareInput {
  scope?: unknown
  root?: unknown
  mode?: unknown
  relay?: unknown
}

export interface ShareTarget {
  root: string
  /** Display name of the room; the shared directory's own name. */
  name: string
  mode: RoomMode
  scope: ShareScope
  relay: string
  createToken?: string
}

export interface ShareDeps {
  settings: { current(): ShareSettings; update(patch: Partial<Omit<ShareSettings, 'version'>>): Promise<ShareSettings> }
  relays: { endpoint(kind: RelayKind): Promise<RelayEndpoint> }
  config: { relayUrl: string; relayCreateToken: string }
  stat?: (target: string) => Promise<{ isDirectory(): boolean }>
}

/** Directory names are the room's own name; a drive root has none. */
export function roomName(root: string): string {
  const name = path.basename(root).trim()
  return name === '' || name === path.sep ? '工作区' : name
}

async function defaultStat(target: string): Promise<{ isDirectory(): boolean }> {
  const { stat } = await import('node:fs/promises')
  return stat(target)
}

/** Every user-facing share decision passes through here, so no path bypasses validation. */
export async function resolveShare(input: ShareInput, deps: ShareDeps): Promise<ShareTarget> {
  const settings = deps.settings.current()
  const scope = input.scope === undefined ? settings.scope : shareScope(input.scope)
  const requested = text(input.root === undefined ? settings.lastRoot : input.root, 'shared directory', 4096)
  if (requested.trim() === '') throw new RoomError('ROOT_REQUIRED', 'Choose a directory to share')
  if (!path.isAbsolute(requested)) throw new RoomError('INVALID_ROOT', 'Choose an absolute shared directory')
  const root = path.resolve(requested)
  let info: { isDirectory(): boolean }
  try { info = await (deps.stat ?? defaultStat)(root) }
  catch { throw new RoomError('ROOT_UNAVAILABLE', 'That directory cannot be read') }
  if (!info.isDirectory()) throw new RoomError('ROOT_NOT_DIRECTORY', 'Choose a directory, not a file')
  const mode = roomMode(input.mode === undefined ? 'workspace-write' : input.mode)
  const target = await resolveRelay(scope, input.relay, deps, settings)
  await rememberShare(deps.settings, { scope, lastRoot: root, ...(scope === 'public' ? { relayUrl: target.relay } : {}) })
  return { root, name: roomName(root), mode, scope, relay: target.relay, ...(target.createToken ? { createToken: target.createToken } : {}) }
}

interface RelayChoice { relay: string; createToken?: string }

async function resolveRelay(scope: ShareScope, requested: unknown, deps: ShareDeps, settings: ShareSettings): Promise<RelayChoice> {
  if (scope === 'lan') {
    const endpoint = await deps.relays.endpoint('lan')
    return { relay: endpoint.url, createToken: endpoint.createToken }
  }
  // An empty saved preference must not shadow the deployment default: only a real value wins.
  // Precedence: explicit request, saved preference, local environment, plugin config.
  const candidate = [requested, settings.relayUrl, process.env.DSH_REMOTE_ROOM_RELAY, deps.config.relayUrl]
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map(value => value.trim())[0] ?? ''
  if (candidate === '') throw new RoomError('RELAY_REQUIRED', 'A public relay address is required for a cross-network share')
  const relay = validateRelay(candidate)
  const createToken = settings.relayCreateToken
    || process.env.DSH_REMOTE_ROOM_RELAY_TOKEN
    || deps.config.relayCreateToken
  return { relay, ...(createToken ? { createToken } : {}) }
}
