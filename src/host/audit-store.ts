export type AuditStatus = 'attempt' | 'success' | 'denied' | 'error' | 'unknown' | 'granted' | 'revoked';
export interface AuditOutcome {
  readonly version: string;
  readonly operation?: 'create' | 'update';
  readonly beforeBytes: number | null;
  readonly afterBytes: number;
  /** Contextual diff basis, not a backup. Content is NEVER retained by these adapters. */
  readonly content: 'omitted';
}
export interface AuditInput {
  readonly requestId: string;
  readonly roomId: string;
  readonly peerId: string;
  readonly epoch: string;
  readonly operation: string;
  readonly path?: string;
  readonly status: AuditStatus;
  readonly code?: string;
  readonly outcome?: AuditOutcome;
}
export interface AuditEntry extends AuditInput { readonly seq: number; readonly time: number }
export interface AuditQuery { readonly after?: number; readonly limit?: number; readonly roomId?: string }
export interface AuditPage { readonly entries: readonly AuditEntry[]; readonly next: number; readonly oldest: number; readonly latest: number }
export interface AuditStore {
  append(entry: AuditInput, signal?: AbortSignal): Promise<AuditEntry>;
  query(query?: AuditQuery, signal?: AbortSignal): Promise<AuditPage>;
  close(): Promise<void>;
}
export interface AuditLimits { readonly maxEntries?: number; readonly maxBytes?: number; readonly ttlMs?: number; readonly maxEntryBytes?: number }
/** Exact structural KvUnit seam from installed Host storage Inspect; no runtime package dependency. */
export interface AuditKvUnit {
  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }>;
  putRecord(table: string, key: string, value: unknown): Promise<void>;
  deleteRecord(table: string, key: string): Promise<void>;
  setGlobal(value: unknown): Promise<void>;
  close(): Promise<void>;
}
interface Snapshot { format: 1; seq: number; entries: AuditEntry[] }
export class AuditError extends Error {
  readonly code = 'HOST_AUDIT_UNAVAILABLE';
  constructor(message = 'Host audit journal unavailable', options?: ErrorOptions) { super(message, options); this.name = 'AuditError'; }
}
const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const clone = <T>(value: T): T => structuredClone(value);
function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid audit ${name}`);
  return value;
}
function text(value: unknown, cap = 4096): value is string { return typeof value === 'string' && value.length <= cap && !value.includes('\0'); }
function normalize(input: AuditInput): AuditInput {
  if (!input || !text(input.requestId, 256) || !text(input.roomId, 256) || !text(input.peerId, 256) ||
    !text(input.epoch, 128) || input.epoch.length === 0 || !text(input.operation, 64) ||
    !['attempt', 'success', 'denied', 'error', 'unknown', 'granted', 'revoked'].includes(input.status) ||
    (input.path !== undefined && !text(input.path)) || (input.code !== undefined && !text(input.code, 128))) throw new AuditError('Invalid audit metadata');
  // Select only known metadata: callers cannot smuggle content/keys into the journal.
  const result: AuditInput = { requestId: input.requestId, roomId: input.roomId, peerId: input.peerId, epoch: input.epoch,
    operation: input.operation, status: input.status, ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.code === undefined ? {} : { code: input.code }) };
  if (!input.outcome) return result;
  const outcome = input.outcome;
  if (!text(outcome.version, 4096) || (outcome.operation !== undefined && !['create', 'update'].includes(outcome.operation)) ||
    (outcome.beforeBytes !== null && (!Number.isSafeInteger(outcome.beforeBytes) || outcome.beforeBytes < 0)) ||
    !Number.isSafeInteger(outcome.afterBytes) || outcome.afterBytes < 0) throw new AuditError('Invalid audit outcome');
  return { ...result, outcome: { version: outcome.version, ...(outcome.operation ? { operation: outcome.operation } : {}),
    beforeBytes: outcome.beforeBytes, afterBytes: outcome.afterBytes, content: 'omitted' } };
}

/** Serialized, bounded journal. Limits apply to serialized metadata bytes as well as entry count. */
export class BoundedMemoryAuditStore implements AuditStore {
  protected state: Snapshot = { format: 1, seq: 0, entries: [] };
  protected readonly limits: Required<AuditLimits>;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(limits: AuditLimits = {}) {
    this.limits = { maxEntries: positive(limits.maxEntries ?? 1000, 'maxEntries'), maxBytes: positive(limits.maxBytes ?? 1024 * 1024, 'maxBytes'),
      ttlMs: positive(limits.ttlMs ?? 7 * 24 * 60 * 60 * 1000, 'ttlMs'), maxEntryBytes: positive(limits.maxEntryBytes ?? 16 * 1024, 'maxEntryBytes') };
  }
  protected async persist(_state: Snapshot): Promise<void> {}
  protected async dispose(): Promise<void> {}
  protected prune(entries: AuditEntry[]): AuditEntry[] {
    const retained = entries.filter(entry => entry.time > Date.now() - this.limits.ttlMs).slice(-this.limits.maxEntries);
    while (retained.length > 0 && byteLength(retained) > this.limits.maxBytes) retained.shift();
    return retained;
  }
  protected run<T>(op: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => { if (this.closed) throw new AuditError('Host audit journal closed'); return op(); });
    this.tail = result.catch(() => {});
    return result;
  }
  append(input: AuditInput, signal?: AbortSignal): Promise<AuditEntry> {
    return this.run(async () => {
      signal?.throwIfAborted();
      const entry = { ...normalize(input), seq: this.state.seq + 1, time: Date.now() };
      if (!Number.isSafeInteger(entry.seq) || byteLength(entry) > Math.min(this.limits.maxEntryBytes, this.limits.maxBytes - 2)) throw new AuditError('Audit entry exceeds journal limit');
      const next: Snapshot = { format: 1, seq: entry.seq, entries: this.prune([...this.state.entries, entry]) };
      try { await this.persist(next); } catch (cause) { throw new AuditError(undefined, { cause }); }
      this.state = next;
      return clone(entry);
    });
  }
  query(query: AuditQuery = {}, signal?: AbortSignal): Promise<AuditPage> {
    return this.run(async () => {
      signal?.throwIfAborted();
      const after = query.after ?? 0;
      const limit = query.limit ?? 100;
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
        (query.roomId !== undefined && !text(query.roomId, 256))) throw new TypeError('Invalid audit query');
      const retained = this.prune(this.state.entries);
      const entries = retained.filter(entry => entry.seq > after && (query.roomId === undefined || entry.roomId === query.roomId)).slice(0, limit);
      return clone({ entries, next: entries.at(-1)?.seq ?? after, oldest: retained[0]?.seq ?? this.state.seq + 1, latest: this.state.seq });
    });
  }
  close(): Promise<void> {
    const result = this.tail.then(async () => { if (this.closed) return; this.closed = true; await this.dispose(); });
    this.tail = result.catch(() => {});
    return result;
  }
}

/**
 * Mount via (await ctx.storage.backend.get(name).kv!.open({name,version:1,tables:[],hasGlobal:true})).
 * A single setGlobal snapshot avoids a partial multi-record append/prune on restart. The backend
 * owns durable atomic publication; this journal does not claim a transaction with file writes.
 */
export class KvAuditStore extends BoundedMemoryAuditStore {
  private constructor(private readonly unit: AuditKvUnit, limits: AuditLimits) { super(limits); }
  static async open(unit: AuditKvUnit, limits: AuditLimits = {}): Promise<KvAuditStore> {
    const store = new KvAuditStore(unit, limits);
    try {
      const { global } = await unit.loadAll();
      if (global !== undefined && global !== null) {
        if (typeof global !== 'object' || !('format' in global) || global.format !== 1 || !('seq' in global) ||
          !Number.isSafeInteger(global.seq) || (global.seq as number) < 0 || !('entries' in global) || !Array.isArray(global.entries)) throw new AuditError('Invalid persisted audit journal');
        let previous = 0;
        const entries = global.entries.map((raw: unknown): AuditEntry => {
          if (!raw || typeof raw !== 'object' || !('seq' in raw) || !Number.isSafeInteger(raw.seq) || (raw.seq as number) <= previous ||
            (raw.seq as number) > (global.seq as number) || !('time' in raw) || !Number.isSafeInteger(raw.time)) throw new AuditError('Invalid persisted audit entry');
          previous = raw.seq as number;
          const entry = { ...normalize(raw as unknown as AuditInput), seq: previous, time: raw.time as number };
          if (byteLength(entry) > store.limits.maxEntryBytes) throw new AuditError('Persisted audit entry exceeds limit');
          return entry;
        });
        store.state = { format: 1, seq: global.seq as number, entries: store.prune(entries) };
      }
      return store;
    } catch (cause) { await unit.close(); throw new AuditError(undefined, { cause }); }
  }
  protected override persist(state: Snapshot): Promise<void> { return this.unit.setGlobal(clone(state)); }
  protected override dispose(): Promise<void> { return this.unit.close(); }
}
