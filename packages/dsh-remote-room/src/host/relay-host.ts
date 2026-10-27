/** Owns the loopback/LAN relay instances a local share needs. Nothing here reaches the network. */
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import { RoomError } from '../protocol.ts'

/** Reach of a new room; `public` never starts a local listener. */
export type RelayKind = 'local' | 'lan'

export interface RelayEndpoint {
  kind: RelayKind
  /** Address written into the invitation. */
  url: string
  /** Reservation gate for this relay instance; distinct from the invitation credential. */
  createToken: string
}

export interface RelayServerOptions {
  host: '127.0.0.1' | '::1' | '0.0.0.0'
  port: number
  allowLan?: boolean
  createToken?: string
}

export interface RelayServerModule {
  startRelay(options: RelayServerOptions): Promise<{ url: string; close(): Promise<void> }>
}

interface Instance { endpoint: RelayEndpoint; close(): Promise<void> }

/** RFC1918 ordering: home/office ranges first so a VPN or container bridge rarely wins. */
function rank(address: string): number {
  if (address.startsWith('192.168.')) return 0
  if (address.startsWith('10.')) return 1
  const second = Number(address.split('.')[1] ?? '')
  if (address.startsWith('172.') && second >= 16 && second <= 31) return 2
  return 3
}

/** The IPv4 address a peer on the same network can reach, or undefined when none exists. */
export function lanAddress(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string | undefined {
  const candidates: string[] = []
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const family = typeof entry.family === 'string' ? entry.family : ''
      if (entry.internal || family !== 'IPv4' || entry.address.startsWith('169.254.')) continue
      candidates.push(entry.address)
    }
  }
  return candidates.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0]
}

/** Lazily starts one relay per reach and keeps it for this Host process lifetime. */
export class RelayHost {
  private readonly instances = new Map<RelayKind, Promise<Instance>>()
  private disposed = false
  constructor(private readonly load: () => Promise<RelayServerModule>) {}

  async endpoint(kind: RelayKind): Promise<RelayEndpoint> {
    if (this.disposed) throw new RoomError('DISPOSED', 'Relay host was stopped')
    const existing = this.instances.get(kind)
    if (existing) return (await existing).endpoint
    const starting = this.start(kind)
    this.instances.set(kind, starting)
    try { return (await starting).endpoint }
    catch (error) { this.instances.delete(kind); throw error }
  }

  private async start(kind: RelayKind): Promise<Instance> {
    const address = kind === 'lan' ? lanAddress() : undefined
    if (kind === 'lan' && !address) throw new RoomError('NETWORK_UNAVAILABLE', 'No local network address is available for a same-network share')
    const module = await this.load()
    const createToken = randomBytes(32).toString('base64url')
    const relay = await module.startRelay({ host: kind === 'lan' ? '0.0.0.0' : '127.0.0.1', port: 0, allowLan: kind === 'lan', createToken })
    const port = new URL(relay.url.replace(/^ws:/, 'http:')).port
    const url = `ws://${kind === 'lan' ? address : '127.0.0.1'}:${port}`
    return { endpoint: { kind, url, createToken }, close: () => relay.close() }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const pending = [...this.instances.values()]
    this.instances.clear()
    const settled = await Promise.allSettled(pending.map(instance => instance.then(value => value.close())))
    const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Some local relays could not be closed')
  }
}

/** Loads the bundled relay build that ships next to the plugin entry. */
export function bundledRelay(): Promise<RelayServerModule> {
  const url = new URL('./local-relay.mjs', import.meta.url).href
  return import(url) as Promise<RelayServerModule>
}
