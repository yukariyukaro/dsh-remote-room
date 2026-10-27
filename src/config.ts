import Schema from '@deepseek-ai/schemastery'

/** Deployment budgets are configurable, protocol and cryptographic invariants are not. */
export const Config = Schema.object({
  relayUrl: Schema.string().default(''),
  relayCreateToken: Schema.string().role('secret').default(''),
  invitationTtlMs: Schema.number().min(10_000).max(3_600_000).default(300_000),
  grantTtlMs: Schema.number().min(10_000).max(86_400_000).default(3_600_000),
  rpcTimeoutMs: Schema.number().min(1000).max(300_000).default(30_000),
  maxRooms: Schema.number().min(1).max(8).default(2),
  maxFileBytes: Schema.number().min(1024).max(8 * 1024 * 1024).default(2 * 1024 * 1024),
  maxDirectoryEntries: Schema.number().min(1).max(10_000).default(2000),
  auditMaxEntries: Schema.number().min(10).max(100_000).default(2000),
  auditMaxBytes: Schema.number().min(16_384).max(64 * 1024 * 1024).default(2 * 1024 * 1024),
  auditBackend: Schema.string().default('json'),
})
export interface Config {
  relayUrl: string
  relayCreateToken: string
  invitationTtlMs: number
  grantTtlMs: number
  rpcTimeoutMs: number
  maxRooms: number
  maxFileBytes: number
  maxDirectoryEntries: number
  auditMaxEntries: number
  auditMaxBytes: number
  auditBackend: string
}
