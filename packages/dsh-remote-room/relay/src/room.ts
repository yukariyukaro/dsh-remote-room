// Shared byte-only pairing state machine. No DSH, TLS keys, or filesystem imports.
export type Role = 'host' | 'guest';
export interface Limits {
  ttlMs: number; maxMessageBytes: number; maxBufferedBytes: number;
  maxMessagesPerSecond: number; maxBytesPerSecond: number; maxSessionBytes: number;
}
export const DEFAULT_LIMITS: Limits = {
  ttlMs: 10 * 60_000, maxMessageBytes: 64 * 1024, maxBufferedBytes: 256 * 1024,
  maxMessagesPerSecond: 1024, maxBytesPerSecond: 8 * 1024 * 1024, maxSessionBytes: 64 * 1024 * 1024,
};
export function limits(input: Partial<Limits> = {}): Limits {
  const result = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
    if (input[key] !== undefined) result[key] = input[key]!;
  }
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  }
  if (result.ttlMs > 86_400_000 || result.maxMessageBytes > 1024 * 1024 ||
      result.maxBufferedBytes > 16 * 1024 * 1024 || result.maxMessageBytes > result.maxBufferedBytes)
    throw new Error('Relay limits exceed protocol bounds');
  return result;
}
export function parseRoute(raw: string): { roomId: string; role: Role; token: string | null } | null {
  const url = new URL(raw, 'http://relay.invalid');
  const match = /^\/v1\/rooms\/([A-Za-z0-9_-]{22,128})\/(host|guest)$/.exec(url.pathname);
  if (!match || url.hash) return null;
  return { roomId: match[1]!, role: match[2] as Role, token: url.searchParams.get('hostToken') };
}
export function validToken(token: string | null): boolean {
  return token !== null && /^[A-Za-z0-9_-]{32,128}$/.test(token);
}
export interface Endpoint {
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
  bufferedAmount: number;
}
export interface Attachment {
  role: Role; expiresAt: number; receiveCredit: number;
  rateAt: number; rateMessages: number; rateBytes: number; sessionBytes: number;
}
export interface Member { socket: Endpoint; state: Attachment }
export class Room {
  readonly members = new Map<Role, Member>();
  closed = false;
  private expires: number;
  constructor(readonly config: Limits, expiresAt: number,
    private readonly persist: (member: Member) => void = () => {},
    private readonly onClosed: () => void = () => {},
    private readonly onExtend: (expiresAt: number) => void = () => {}) { this.expires = expiresAt; }
  /**
   * A reservation is owned by its live host connection, not by a wall clock: the TTL
   * is an idle timeout, refreshed by traffic, not a deadline set when the room opens.
   * Extensions are throttled to a quarter TTL so a busy room does not churn storage.
   */
  get expiresAt(): number { return this.expires; }
  touch(): void {
    if (this.closed) return;
    const extended = Date.now() + this.config.ttlMs;
    if (extended - this.expires <= Math.floor(this.config.ttlMs / 4)) return;
    this.expires = extended;
    for (const member of this.members.values()) { member.state.expiresAt = extended; this.persist(member); }
    this.onExtend(extended);
  }
  add(role: Role, socket: Endpoint, restored?: Attachment): void {
    if (this.closed || Date.now() >= this.expiresAt) throw new Error('Room expired');
    if (this.members.has(role) || (role === 'guest' && !this.members.has('host')))
      throw new Error('Pairing conflict');
    const member = { socket, state: restored ?? {
      role, expiresAt: this.expiresAt, receiveCredit: 0,
      rateAt: Date.now(), rateMessages: 0, rateBytes: 0, sessionBytes: 0,
    } };
    this.members.set(role, member);
    this.persist(member);
    this.touch();
    if (restored) return;
    this.send(member, JSON.stringify({ type: 'hello', version: 1,
      maxMessageBytes: this.config.maxMessageBytes, maxBufferedBytes: this.config.maxBufferedBytes }));
    if (this.members.size === 2) {
      for (const item of this.members.values()) {
        this.send(item, '{"type":"paired"}');
        const peer = this.peer(item.state.role);
        if (peer && peer.state.receiveCredit > 0)
          this.send(item, JSON.stringify({ type: 'credit', bytes: peer.state.receiveCredit }));
      }
    }
  }
  peer(role: Role): Member | undefined { return this.members.get(role === 'host' ? 'guest' : 'host'); }
  send(member: Member, data: string | Uint8Array): void {
    const size = typeof data === 'string' ? data.length : data.byteLength;
    if (Number.isFinite(member.socket.bufferedAmount) &&
        member.socket.bufferedAmount + size > this.config.maxBufferedBytes) {
      this.shutdown(1009, 'Relay send queue exceeded'); return;
    }
    try { member.socket.send(data); } catch { this.shutdown(1011, 'Relay send failed'); }
  }
  message(role: Role, data: string | Uint8Array): void {
    if (this.closed) return;
    const member = this.members.get(role);
    if (!member) return;
    if (Date.now() >= this.expiresAt) { this.shutdown(1008, 'Room expired'); return; }
    const size = typeof data === 'string' ? data.length : data.byteLength;
    const state = member.state;
    if (Date.now() - state.rateAt >= 1000) {
      state.rateAt = Date.now(); state.rateBytes = 0; state.rateMessages = 0;
    }
    state.rateMessages++; state.rateBytes += size; state.sessionBytes += size;
    if (state.sessionBytes > this.config.maxSessionBytes ||
        state.rateMessages > this.config.maxMessagesPerSecond || state.rateBytes > this.config.maxBytesPerSecond) {
      this.shutdown(1008, 'Rate limit'); return;
    }
    this.touch();
    const peer = this.peer(role);
    if (typeof data === 'string') {
      if (size > 128) { this.shutdown(1008, 'Invalid control'); return; }
      let value: { type?: unknown; bytes?: unknown };
      try { value = JSON.parse(data) as typeof value; } catch { this.shutdown(1008, 'Invalid control'); return; }
      // A waiting host has no peer to talk to; this frame only proves it is still there.
      if (value?.type === 'keepalive') return;
      if (!value || value.type !== 'credit' || typeof value.bytes !== 'number' ||
          !Number.isSafeInteger(value.bytes) || value.bytes <= 0 ||
          state.receiveCredit + value.bytes > this.config.maxBufferedBytes) {
        this.shutdown(1008, 'Invalid credit'); return;
      }
      state.receiveCredit += value.bytes;
      this.persist(member);
      if (peer) this.send(peer, JSON.stringify({ type: 'credit', bytes: value.bytes }));
      return;
    }
    // No pre-pairing queue. A sender must obey explicit receiver credit.
    if (!peer || size === 0 || size > this.config.maxMessageBytes || size > peer.state.receiveCredit) {
      this.shutdown(size > this.config.maxMessageBytes ? 1009 : 1008, 'Payload or credit exceeded'); return;
    }
    peer.state.receiveCredit -= size;
    this.persist(member); this.persist(peer);
    this.send(peer, data);
  }
  shutdown(code = 1000, reason = 'Peer closed'): void {
    if (this.closed) return;
    this.closed = true;
    for (const member of this.members.values()) {
      try { member.socket.close(code, reason); } catch { /* already disconnected */ }
    }
    this.members.clear(); this.onClosed();
  }
}
