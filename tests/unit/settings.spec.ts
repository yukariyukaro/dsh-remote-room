import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, ShareSettingsStore, readSettings, rememberShare } from '../../src/host/settings.ts'

class FakeUnit {
  writes = 0
  closed = false
  constructor(public global: unknown) {}
  async loadAll() { return { tables: {}, global: this.global } }
  async setGlobal(value: unknown) { this.global = value; this.writes++ }
  async close() { this.closed = true }
}

describe('sharing settings durability', () => {
  it('starts from documented defaults when nothing was stored', async () => {
    const store = await ShareSettingsStore.open(new FakeUnit(undefined))
    expect(store.current()).toEqual(DEFAULT_SETTINGS)
    expect(store.current().scope).toBe('local')
  })

  it('rejects records that are not the stored shape and keeps valid fields', async () => {
    expect(readSettings('garbage')).toEqual(DEFAULT_SETTINGS)
    expect(readSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(readSettings([1, 2])).toEqual(DEFAULT_SETTINGS)
    expect(readSettings({ scope: 'mars', relayUrl: 42, lastRoot: '/w' })).toEqual({ ...DEFAULT_SETTINGS, lastRoot: '/w' })
    expect(readSettings({ scope: 'public', relayUrl: 'wss://relay.example' })).toMatchObject({ scope: 'public', relayUrl: 'wss://relay.example' })
  })

  it('truncates oversized stored values instead of trusting them', async () => {
    const stored = readSettings({ lastRoot: 'x'.repeat(9000) })
    expect(stored.lastRoot).toHaveLength(4096)
  })

  it('persists each update and returns the merged record', async () => {
    const unit = new FakeUnit(undefined)
    const store = await ShareSettingsStore.open(unit)
    expect(await store.update({ scope: 'lan' })).toMatchObject({ scope: 'lan' })
    expect(await store.update({ lastRoot: '/work/app' })).toMatchObject({ scope: 'lan', lastRoot: '/work/app' })
    expect(unit.writes).toBe(2)
    expect(unit.global).toMatchObject({ scope: 'lan', lastRoot: '/work/app' })
    await store.close()
    expect(unit.closed).toBe(true)
  })

  it('serializes overlapping writes so the last record wins', async () => {
    const unit = new FakeUnit(undefined)
    const store = await ShareSettingsStore.open(unit)
    const first = store.update({ lastRoot: '/a' })
    const second = store.update({ lastRoot: '/b' })
    await Promise.all([first, second])
    expect(unit.global).toMatchObject({ lastRoot: '/b' })
    expect(unit.writes).toBe(2)
  })

  it('recovers the write chain after a failed write', async () => {
    const unit = new FakeUnit(undefined)
    const store = await ShareSettingsStore.open(unit)
    const original = unit.setGlobal.bind(unit)
    unit.setGlobal = async () => { throw new Error('disk full') }
    await expect(store.update({ lastRoot: '/lost' })).rejects.toThrow('disk full')
    unit.setGlobal = original
    expect(await store.update({ lastRoot: '/kept' })).toMatchObject({ lastRoot: '/kept' })
    expect(unit.global).toMatchObject({ lastRoot: '/kept' })
  })

  it('refuses updates after close', async () => {
    const store = await ShareSettingsStore.open(new FakeUnit(undefined))
    await store.close()
    await expect(store.update({ scope: 'lan' })).rejects.toMatchObject({ code: 'DISPOSED' })
  })

  it('treats a preference write as best effort', async () => {
    const store = await ShareSettingsStore.open(new FakeUnit(undefined))
    await store.close()
    await expect(rememberShare(store, { scope: 'lan' })).resolves.toBeUndefined()
  })
})
