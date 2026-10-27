/** Durable sharing preferences. No invitation secret is ever stored here. */
import { RoomError } from '../protocol.ts'

/** Where the relay for a new room comes from. Sharing is for separate networks by default. */
export type ShareScope = 'lan' | 'public'

export const SHARE_SCOPES: readonly ShareScope[] = ['public', 'lan']

export interface ShareSettings {
  version: 1
  scope: ShareScope
  /** Public relay address, remembered after the first successful share. */
  relayUrl: string
  /** Deployment secret of the public relay; local to this Host, never sent to a guest. */
  relayCreateToken: string
  lastRoot: string
}

/** Structural subset of the installed Host storage KvUnit; no runtime package dependency. */
export interface SettingsUnit {
  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }>
  setGlobal(value: unknown): Promise<void>
  close(): Promise<void>
}

export const DEFAULT_SETTINGS: ShareSettings = {
  version: 1, scope: 'public', relayUrl: '', relayCreateToken: '', lastRoot: '',
}

export function shareScope(value: unknown): ShareScope {
  if (value !== 'lan' && value !== 'public') throw new RoomError('INVALID_SCOPE', 'Unknown sharing reach')
  return value
}

/** Durable record is untrusted input: every field is validated before use. */
export function readSettings(value: unknown): ShareSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_SETTINGS }
  const record = value as Record<string, unknown>
  const read = (key: keyof ShareSettings, max: number): string =>
    typeof record[key] === 'string' ? (record[key] as string).slice(0, max) : ''
  const scope: ShareScope = record.scope === 'lan' || record.scope === 'public' ? record.scope : DEFAULT_SETTINGS.scope
  return {
    version: 1,
    scope,
    relayUrl: read('relayUrl', 2048),
    relayCreateToken: read('relayCreateToken', 512),
    lastRoot: read('lastRoot', 4096),
  }
}

/** Serialized writes keep the last committed record authoritative across concurrent shares. */
export class ShareSettingsStore {
  private writing: Promise<unknown> = Promise.resolve()
  private closed = false
  private constructor(private readonly unit: SettingsUnit, private value: ShareSettings) {}

  static async open(unit: SettingsUnit): Promise<ShareSettingsStore> {
    const loaded = await unit.loadAll()
    return new ShareSettingsStore(unit, readSettings(loaded.global))
  }

  current(): ShareSettings { return { ...this.value } }

  async update(patch: Partial<Omit<ShareSettings, 'version'>>): Promise<ShareSettings> {
    if (this.closed) throw new RoomError('DISPOSED', 'Sharing settings are no longer available')
    const next: ShareSettings = readSettings({ ...this.value, ...patch })
    this.value = next
    // One failed write must not poison later ones: the chain recovers, then applies the new record.
    this.writing = this.writing.catch(() => {}).then(() => this.unit.setGlobal(next))
    await this.writing
    return { ...next }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.writing.catch(() => {})
    await this.unit.close()
  }
}

/** Settings are a preference, not a prerequisite: a failed write must not block sharing. */
export async function rememberShare(
  store: { update(patch: Partial<Omit<ShareSettings, 'version'>>): Promise<ShareSettings> },
  patch: Partial<Omit<ShareSettings, 'version'>>,
): Promise<void> {
  try { await store.update(patch) } catch { /* the share itself already succeeded */ }
}
