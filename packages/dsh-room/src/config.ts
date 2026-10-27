import Schema from '@deepseek-ai/schemastery'

/** Deployment budgets are configurable; ingress rules and secret handling are not. */
export const Config = Schema.object({
  listenHost: Schema.string().default('127.0.0.1'),
  listenPort: Schema.number().min(0).max(65_535).default(19_443),
  invitationTtlMs: Schema.number().min(30_000).max(3_600_000).default(300_000),
  pendingTtlMs: Schema.number().min(30_000).max(3_600_000).default(300_000),
  sessionIdleTtlMs: Schema.number().min(60_000).max(86_400_000).default(1_800_000),
  sessionMaxTtlMs: Schema.number().min(60_000).max(7 * 86_400_000).default(8 * 3_600_000),
  maxPending: Schema.number().min(1).max(64).default(8),
  maxMembers: Schema.number().min(1).max(64).default(16),
  /** Direct peers allowed to reach the gateway. Empty means the default for the listen host. */
  allowedCidrs: Schema.array(String).default([]),
  /** Extra authorities and origins accepted besides the bound listener address. */
  authorityAliases: Schema.array(String).default([]),
  tlsCertFile: Schema.string().default(''),
  tlsKeyFile: Schema.string().default(''),
  /** Off by default: a relay publishes this room to whatever network the relay sits on. */
  relayEnabled: Schema.boolean().default(false),
  relayUrl: Schema.string().default(''),
  relayRoom: Schema.string().default('room'),
  relaySecret: Schema.string().role('secret').default(''),
  /** Public authority guests use to reach the relay, e.g. room.example.com:8443. */
  relayPublicAuthority: Schema.string().default(''),
  /** Full public origin for invitation links, e.g. https://dsh-room.example.workers.dev */
  relayPublicUrl: Schema.string().default(''),
})

export interface Config {
  listenHost: string
  listenPort: number
  invitationTtlMs: number
  pendingTtlMs: number
  sessionIdleTtlMs: number
  sessionMaxTtlMs: number
  maxPending: number
  maxMembers: number
  allowedCidrs: string[]
  authorityAliases: string[]
  tlsCertFile: string
  tlsKeyFile: string
  relayEnabled: boolean
  relayUrl: string
  relayRoom: string
  relaySecret: string
  relayPublicAuthority: string
  relayPublicUrl: string
}
