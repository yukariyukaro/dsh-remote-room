import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveShare, roomName, type ShareDeps } from '../../src/share.ts'
import { DEFAULT_SETTINGS, readSettings, type ShareSettings } from '../../src/host/settings.ts'
import type { RelayKind } from '../../src/host/relay-host.ts'

const ROOT = path.resolve(path.sep, 'work', 'project')

function harness(options: { settings?: Partial<ShareSettings>; directory?: boolean; statFails?: boolean; writeFails?: boolean } = {}) {
  let value: ShareSettings = { ...DEFAULT_SETTINGS, ...options.settings }
  const writes: Partial<ShareSettings>[] = []
  const kinds: RelayKind[] = []
  const deps: ShareDeps = {
    settings: {
      current: () => ({ ...value }),
      update: async patch => {
        writes.push(patch)
        if (options.writeFails) throw new Error('storage unavailable')
        value = readSettings({ ...value, ...patch })
        return { ...value }
      },
    },
    relays: {
      endpoint: async (kind: RelayKind) => {
        kinds.push(kind)
        return { kind, url: kind === 'lan' ? 'ws://192.168.0.9:7777' : 'ws://127.0.0.1:7777', createToken: `${kind}-token` }
      },
    },
    config: { relayUrl: '', relayCreateToken: '' },
    stat: async () => {
      if (options.statFails) throw new Error('ENOENT')
      return { isDirectory: () => options.directory !== false }
    },
  }
  return { deps, writes, kinds, settings: () => value }
}

describe('one-click share resolution', () => {
  it('shares the remembered directory over the remembered public relay with workspace write access', async () => {
    const h = harness({ settings: { lastRoot: ROOT, relayUrl: 'wss://relay.example.com' } })
    const target = await resolveShare({}, h.deps)
    expect(target).toEqual({
      root: ROOT, name: 'project', mode: 'workspace-write', scope: 'public',
      relay: 'wss://relay.example.com',
    })
    expect(h.kinds).toEqual([])
    expect(h.writes[0]).toMatchObject({ scope: 'public', lastRoot: ROOT })
  })

  it('follows the remembered reach and uses the paired relay endpoint', async () => {
    const h = harness({ settings: { scope: 'lan', lastRoot: ROOT } })
    const target = await resolveShare({ root: ROOT }, h.deps)
    expect(target.scope).toBe('lan')
    expect(target.relay).toBe('ws://192.168.0.9:7777')
    expect(h.kinds).toEqual(['lan'])
  })

  it('validates and remembers a public relay address', async () => {
    const h = harness({ settings: { lastRoot: ROOT, relayCreateToken: 'relay-secret' } })
    const target = await resolveShare({ scope: 'public', relay: 'wss://relay.example.com/' }, h.deps)
    expect(target).toMatchObject({ scope: 'public', relay: 'wss://relay.example.com', createToken: 'relay-secret' })
    expect(h.writes[0]).toMatchObject({ scope: 'public', relayUrl: 'wss://relay.example.com' })
    expect(h.kinds).toEqual([])
  })

  it('accepts a private-network relay without TLS but never a public one', async () => {
    const h = harness({ settings: { lastRoot: ROOT } })
    await expect(resolveShare({ scope: 'public', relay: 'ws://192.168.0.9:7777' }, h.deps)).resolves.toMatchObject({ relay: 'ws://192.168.0.9:7777' })
    await expect(resolveShare({ scope: 'public', relay: 'ws://relay.example.com' }, h.deps)).rejects.toMatchObject({ code: 'INVALID_RELAY' })
  })

  it('requires an address for a cross-network share', async () => {
    const h = harness({ settings: { lastRoot: ROOT } })
    await expect(resolveShare({ scope: 'public' }, h.deps)).rejects.toMatchObject({ code: 'RELAY_REQUIRED' })
  })

  it('rejects inputs that cannot name a shareable directory', async () => {
    const h = harness()
    await expect(resolveShare({}, h.deps)).rejects.toMatchObject({ code: 'ROOT_REQUIRED' })
    await expect(resolveShare({ root: 'relative/dir' }, h.deps)).rejects.toMatchObject({ code: 'INVALID_ROOT' })
    await expect(resolveShare({ root: ROOT, scope: 'mars' }, h.deps)).rejects.toMatchObject({ code: 'INVALID_SCOPE' })
    await expect(resolveShare({ root: ROOT, mode: 'owner' }, h.deps)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('reports an unreadable or non-directory target', async () => {
    await expect(resolveShare({ root: ROOT }, harness({ statFails: true }).deps)).rejects.toMatchObject({ code: 'ROOT_UNAVAILABLE' })
    await expect(resolveShare({ root: ROOT }, harness({ directory: false }).deps)).rejects.toMatchObject({ code: 'ROOT_NOT_DIRECTORY' })
  })

  it('falls back to the deployment relay when no address is saved yet', async () => {
    const h = harness({ settings: { lastRoot: ROOT } })
    h.deps.config.relayUrl = 'wss://relay.example.test'
    await expect(resolveShare({}, h.deps)).resolves.toMatchObject({ relay: 'wss://relay.example.test', scope: 'public' })
  })

  it('still shares when the preference cannot be stored', async () => {
    const h = harness({ settings: { lastRoot: ROOT, relayUrl: 'wss://relay.example.com' }, writeFails: true })
    await expect(resolveShare({}, h.deps)).resolves.toMatchObject({ root: ROOT })
  })
})

describe('room naming', () => {
  it('uses the shared directory name', () => {
    expect(roomName(ROOT)).toBe('project')
    expect(roomName(`${ROOT}${path.sep}`)).toBe('project')
    expect(roomName(path.resolve(path.sep, '我的项目'))).toBe('我的项目')
  })

  it('falls back to a readable name for a drive root', () => {
    expect(roomName(`${path.parse(ROOT).root}`)).toBe('工作区')
  })
})
