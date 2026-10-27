/** Owns the sharing gateway lifecycle and turns Host requests into room operations. */
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Listener, RoomRegistry, RoomSnapshot } from './room-state.ts'
import { RoomError } from './room-state.ts'
import { Gateway } from './gateway.ts'
import { RelayClient } from './relay-client.ts'
import { LoopbackCredentials, type Credentials } from './upstream.ts'
import { isLoopbackAddress, isPrivateAddress, parseCidr, type Cidr } from './net.ts'
import type { Config } from './config.ts'

export interface UpstreamTarget { host: string; port: number; secure: boolean; origin: string; authenticatedUrl: () => string }

export type { HostConnection as ServiceHost } from './contracts.ts'

/** Refuse to expose loopback DSH through a listener that is not on a private address. */
export function assertBindable(host: string, secure: boolean): void {
  if (host === '' || host === '0.0.0.0' || host === '::' || host === '*') throw new RoomError('BIND_FORBIDDEN', 'A wildcard address is never accepted; choose one interface')
  if (!isPrivateAddress(host)) throw new RoomError('BIND_FORBIDDEN', `${host} is not a private address; share only over loopback or a private interface`)
  // Loopback stays plaintext for SSH forwarding; anything a network peer can reach must be TLS.
  if (!secure && !isLoopbackAddress(host)) throw new RoomError('BIND_FORBIDDEN', `${host} needs a TLS certificate; plaintext sharing is limited to loopback`)
}

export class RoomService {
  private gateway: Gateway | undefined
  private credentials: Credentials | undefined
  private listener: Listener | undefined
  private relay: RelayClient | undefined
  private relayAuthority = ''
  private relayToken = ''
  private relayPublicUrl = ''
  private sweep: ReturnType<typeof setInterval> | undefined
  private notice = ''
  private opening: Promise<RoomSnapshot> | undefined
  private lastError = ''

  constructor(
    private readonly registry: RoomRegistry,
    private readonly config: Config,
    private readonly upstream: () => UpstreamTarget,
    private readonly log: (line: string) => void = () => {},
  ) {}

  get error(): string { return this.lastError }
  get info(): string { return this.notice }
  get relayCredentials(): { authority: string; token: string } { return { authority: this.relayAuthority, token: this.relayToken } }
  get current(): Listener | undefined { return this.listener }

  /** Build the exact authorities and origins this listener answers for. */
  private policy(host: string, port: number, secure: boolean): { authorities: string[]; origins: string[]; peers: readonly Cidr[] } {
    const scheme = secure ? 'https' : 'http'
    const withPort = (name: string): string => (name.includes(':') && !name.startsWith('[') ? `[${name}]` : name) + `:${port}`
    const hosts = new Set<string>([withPort(host), withPort('localhost'), withPort('127.0.0.1')])
    for (const alias of this.config.authorityAliases) hosts.add(alias.toLowerCase())
    // The relay publishes its own authority; guests browse that, so the fence must accept it.
    const publicAuthority = (this.relayAuthority || this.config.relayPublicAuthority).trim().toLowerCase()
    if (publicAuthority !== '') hosts.add(publicAuthority)
    const origins = [...hosts].map(authority => `${scheme}://${authority}`)
    const peers = this.config.allowedCidrs.length > 0
      ? this.config.allowedCidrs.map(parseCidr)
      : [parseCidr('127.0.0.0/8'), parseCidr('::1/128')]
    return { authorities: [...hosts], origins, peers }
  }

  private async tls(): Promise<{ cert: string; key: string } | undefined> {
    const { tlsCertFile, tlsKeyFile } = this.config
    if (tlsCertFile === '' || tlsKeyFile === '') return undefined
    const [cert, key] = await Promise.all([readFile(tlsCertFile, 'utf8'), readFile(tlsKeyFile, 'utf8')])
    return { cert, key }
  }

  async open(): Promise<RoomSnapshot> {
    if (this.opening !== undefined) return this.opening
    if (this.gateway !== undefined) throw new RoomError('ROOM_ALREADY_OPEN', 'A room is already open')
    this.opening = this.start()
    try { return await this.opening } finally { this.opening = undefined }
  }

  private async start(): Promise<RoomSnapshot> {
    const host = this.config.listenHost
    const tls = await this.tls()
    assertBindable(host, tls !== undefined)
    // Reject a bad CIDR now rather than throwing on every request later.
    for (const entry of this.config.allowedCidrs) parseCidr(entry)
    const target = this.upstream()
    this.credentials = new LoopbackCredentials(`${target.host}:${target.port}`, target.authenticatedUrl)
    const credentials = this.credentials
    const registry = this.registry
    const gateway = new Gateway({
      registry,
      upstream: {
        host: target.host, port: target.port, secure: target.secure,
        cookie: () => credentials.cookie(), invalidate: () => credentials.invalidate(),
      },
      policy: {
        authorities: () => this.policy(host, this.listener?.port ?? this.config.listenPort, tls !== undefined).authorities,
        origins: () => this.policy(host, this.listener?.port ?? this.config.listenPort, tls !== undefined).origins,
        peers: () => this.policy(host, this.listener?.port ?? this.config.listenPort, tls !== undefined).peers,
        tls: () => tls,
        relayPeer: () => (this.relay === undefined ? undefined : this.relayToken),
      },
      log: this.log,
    })
    try {
      try {
        this.listener = await gateway.listen(host, this.config.listenPort)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EADDRINUSE' || this.config.listenPort === 0) throw error
        // Someone else owns the configured port; take any free one and show it in the panel.
        this.listener = await gateway.listen(host, 0)
        this.notice = `端口 ${this.config.listenPort} 已被占用，改用 ${this.listener.port}`
      }
      this.gateway = gateway
      this.lastError = ''
      const snapshot = registry.open(this.listener)
      this.startRelay()
      this.startSweep()
      return snapshot
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      await gateway.close().catch(() => {})
      this.credentials = undefined
      throw new RoomError('GATEWAY_FAILED', `Could not listen on ${host}: ${this.lastError}`)
    }
  }

  /** Relay is opt-in and dials out; failure never blocks the local room. */
  private startRelay(): void {
    if (!this.config.relayEnabled) return
    if (this.config.relayUrl === '' || this.config.relaySecret === '') { this.lastError = 'relay is enabled but relayUrl/relaySecret are empty'; return }
    this.connectRelay(this.config.relayUrl, this.config.relayRoom, this.config.relaySecret, this.config.relayPublicAuthority)
  }

  /** Start dialing the relay from the panel. The secret stays in memory. */
  connectRelay(url: string, room: string, secret: string, authority: string, publicUrl = ''): { connected: boolean } {
    this.requireOpenRoom()
    if (!/^wss?:\/\//u.test(url)) throw new RoomError('RELAY_INVALID', 'Relay URL must start with ws:// or wss://')
    if (secret.length < 16) throw new RoomError('RELAY_INVALID', 'Relay secret must be at least 16 characters')
    this.disconnectRelay()
    this.relayAuthority = authority.trim().toLowerCase()
    this.relayPublicUrl = publicUrl.trim()
    this.relayToken = randomUUID()
    const relay = new RelayClient({
      url,
      room: room.trim() === '' ? 'room' : room.trim(),
      secret,
      relayToken: this.relayToken,
      gateway: () => (this.listener === undefined ? undefined : { host: '127.0.0.1', port: this.listener.port }),
      log: this.log,
    })
    this.relay = relay
    relay.start()
    return { connected: relay.connected }
  }

  disconnectRelay(): void {
    const relay = this.relay
    this.relay = undefined
    this.relayAuthority = ''
    this.relayPublicUrl = ''
    this.relayToken = ''
    relay?.stop()
  }

  /** Kick closes the member's live streams first, then future requests fail authentication. */
  kick(memberId: string): void {
    this.registry.kick(memberId)
    this.gateway?.revokeMember(memberId)
  }

  get relayState(): { enabled: boolean; authority: string } {
    return { enabled: this.relay !== undefined, authority: this.relayAuthority }
  }

  private requireOpenRoom(): void {
    if (this.listener === undefined) throw new RoomError('ROOM_CLOSED', 'Open a room before starting the relay')
  }

  private startSweep(): void {
    this.stopSweep()
    // Streams outlive a single request, so expiry must be enforced on a timer as well.
    this.sweep = setInterval(() => { this.gateway?.sweepMembers(id => this.registry.isMemberActive(id)) }, 15_000)
    this.sweep.unref?.()
  }

  private stopSweep(): void {
    if (this.sweep !== undefined) clearInterval(this.sweep)
    this.sweep = undefined
  }

  async close(): Promise<RoomSnapshot> {
    const snapshot = this.registry.close()
    this.stopSweep()
    this.lastError = ''
    this.notice = ''
    this.disconnectRelay()
    const gateway = this.gateway
    this.gateway = undefined
    this.listener = undefined
    this.credentials = undefined
    if (gateway !== undefined) await gateway.close()
    return snapshot
  }

  /** The invitation link always points at the address this listener actually bound. */
  invite(): { token: string; expiresAt: number; url: string } {
    const invitation = this.registry.invite()
    const listener = this.listener
    if (listener === undefined) throw new RoomError('ROOM_CLOSED', 'No room is open')
    const authority = `${listener.host.includes(':') ? `[${listener.host}]` : listener.host}:${listener.port}`
    // A relayed room must hand out the address guests can actually reach.
    const publicUrl = this.relay !== undefined ? (this.relayPublicUrl || this.config.relayPublicUrl) : ''
    if (publicUrl !== '') {
      return { ...invitation, url: `${publicUrl.replace(/\/$/u, '')}/join#${invitation.token}` }
    }
    return { ...invitation, url: `${listener.secure ? 'https' : 'http'}://${authority}/join#${invitation.token}` }
  }

  async dispose(): Promise<void> { await this.close().catch(() => {}) }
}
