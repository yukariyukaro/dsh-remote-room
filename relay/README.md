# Independent byte relay v1

This package imports no DSH runtime, grants, filesystem APIs, or end-to-end keys. It pairs two **outbound** WebSocket clients. The Node implementation is a loopback backend / real integration-test fixture; put a trusted TLS reverse proxy in front for self-host deployment. The Worker requires HTTPS/WSS and routes one random room ID to one SQLite-backed Durable Object.

## Pairing and capabilities

- Generate a fresh room ID with `randomBytes(24).toString('base64url')` and a separate private host reservation token with `randomBytes(32).toString('base64url')`.
- First host connects to `/v1/rooms/{roomId}/host?hostToken={token}`. A host token of 32–128 base64url characters is mandatory. It is **not** the invitation secret, TLS external PSK, or an authentication proof. It is an independent high-entropy reservation capability supplied by the creator. Since rooms are first-writer-wins, secrecy of an unguessable room ID plus the creation gate prevents practical preemption; a hostToken is not an invitation authorization system.
- The host creates the room. Guest connects to `/v1/rooms/{roomId}/guest`, without hostToken. Guest-before-host returns 404; second host/guest returns 409. At most two sockets. No guest reconnect or slot replacement during the same pairing. Closing either closes the entire pair. Create a new room ID and new TLS generation after a disconnect. Node removes a closed room immediately; DO keeps a closed-ID tombstone until TTL to prevent resurrection across hibernation.
- `CREATE_TOKEN` is a **required Worker deployment secret** gating creation across the namespace; hosts supply `?createToken=...`. Set it using `wrangler secret put CREATE_TOKEN`. The Node `startRelay` fixture accepts optional `createToken` for the same gate. This token is known to the relay; never derive it from TLS PSK. Do not publish it in guest invitations.
- Query capabilities can appear in proxy access logs. Disable/redact query logging and telemetry. Neither relay logs URLs, tokens, bytes, or secrets. E2E invitation secrets must remain local/fragment-only; they never enter these URLs.

The relay can observe routes, addresses, sizes and timings; it can drop, reorder or substitute bytes. Pairing/credit/`paired` notifications are **not authentication**. Run the separately authenticated TLS 1.3 PSK channel on the Duplex before any RPC/grant operation.

## Byte protocol and bounds

WebSocket compression is disabled by the Node client/server. Binary messages carry only opaque byte chunks. Text frames are the separate v1 flow-control envelope and never enter the Duplex:

1. Server sends `{"type":"hello","version":1,"maxMessageBytes":65536,"maxBufferedBytes":262144}` to each new member.
2. Client sends `{"type":"credit","bytes":N}` advertising bounded receive capacity. Before pairing, the relay remembers only a bounded integer credit, never application bytes.
3. After guest arrives, server sends `{"type":"paired"}` to both and forwards already-advertised peer credits. Future credits are forwarded immediately.
4. Sender must await pairing **and receiver credit** before binary sends. Binary size must be positive, <= maxMessageBytes and <= receiver credit. The relay decrements receiver credit atomically. Zero-credit or pre-pair binary closes the pair (1008); there is **no relay content queue**. Oversize closes with 1009.
5. Adapter credits account for all outstanding messages plus local Readable bytes. Consumption frees credit. This bounds bytes into this adapter, not TLS/RPC downstream memory: TLS/RPC must independently enforce consumption/stream windows and request limits. `Readable.pause()` and `bufferedAmount` alone are not end-to-end flow control.

Defaults / hard safety bounds:

| Limit | Default | Maximum |
|---|---:|---:|
| Room absolute TTL | 10 min | 24 h |
| Binary message | 64 KiB | 1 MiB |
| Receive credit / Node send queue | 256 KiB | 16 MiB |
| Messages per sender per second (including credit) | 1024 | configurable positive integer |
| Bytes per sender per second (including control) | 8 MiB | configurable positive integer |
| Lifetime bytes per sender (including control) | 64 MiB | configurable positive integer |
| Node simultaneous rooms / creations per minute | 256 / 32 | configurable positive integer |

Node `ws` enforces `maxPayload` before message delivery, disables per-message deflate, checks destination `bufferedAmount`, bounds writable accumulation even for callers ignoring `write() === false`, and tears down on close/error/abort. One frame send is active at once. Adapter splitting and credit also cap a frame to the receiver's advertised window. No plaintext status bytes pollute TLS.

**Cloudflare caveat:** native DO WebSockets have no `bufferedAmount`. Credit bounds compliant-client outstanding bytes; serialized rate/absolute lifetime budgets additionally bound abusive credit amplification, but DO cannot enforce Node's exact native send-queue watermark. Platform-received oversized WebSocket frames are also allocated before `webSocketMessage` applies the smaller application limit. This is not a proof of strict per-frame allocation bounds for adversarial Cloudflare clients. Configure ingress WebSocket/rate limits and measure native queue behavior before production. Node's parser has the stricter boundary. No deployment/network/hibernation-cost claims are made by the local tests.

## Node API

```ts
const relay = await startRelay({ host: '127.0.0.1', port: 0 });
const host = await connectRelay(relay.url, roomId, 'host', {
  hostToken, allowInsecureLoopback: true,
});
// connectRelay resolves on accepted upgrade, before guest or authentication.
// host.on('paired', ...) is informational; starting TLS immediately is supported:
// its first bounded write waits for pairing/guest credit.
// TLS handshake timeout must cover the intended invitation wait budget.
const guest = await connectRelay(relay.url, roomId, 'guest', {
  allowInsecureLoopback: true,
});
// ... authenticated TLS over host/guest, then RPC ...
host.destroy(); guest.destroy(); await relay.close();
```

`connectRelay(url, roomId, role, options)` options: `hostToken`, `createToken`, `maxQueueBytes`, `maxMessageBytes`, `signal`, `allowInsecureLoopback`, `connectTimeoutMs` (upgrade only; default 10 seconds). Production requires `wss:`. Plain `ws:` is allowed only when explicitly enabled **and** URL host is literal `127.0.0.1` or `[::1]`; localhost aliases, arbitrary hostnames, credentials, base query and fragment are rejected. Redirects are disabled. Adapter uses `ws@8`, not Node's global WebSocket, deliberately: the global client lacks configurable parser `maxPayload`. The plugin needs a runtime `ws` dependency (or a bundle containing it); relay declares its own independent dependency.

## Worker deployment and recovery

`wrangler.toml` declares a SQLite DO migration and ROOMS binding. Configure CREATE_TOKEN, adjust limits, add deployment-level ingress rate limits / creation quotas, then deploy using Wrangler. A creation secret prevents anonymous high-cardinality DO creation; it does not limit a compromised authorized creator. **Do not expose this deployment without ingress limits.** Neither per-room rate controls nor a random reservation token replace global abuse controls.

The DO uses WebSocket Hibernation API. Attachments contain role, expiry, receive credit, rate counters, and lifetime byte count only. Constructor restores host before guest, validates attachments, and does not replay hello/paired/credit (would double credit). Storage keeps room expiry/tombstone; alarm closes both sockets and deletes storage. Upgrades serialize storage awaits through `blockConcurrencyWhile` to avoid duplicate-host races. No content queue or TLS secret is persisted. No application heartbeat is emitted: TTL is absolute and does not renew on traffic; configure TLS/RPC idle/heartbeat budgets separately. Reconnect always establishes a new authenticated transport generation.

## Verification (no dependency installation required for Node tests)

From root using the installed Node/pnpm environment:

- `pnpm exec tsc --noEmit -p relay/tsconfig.json`
- `pnpm exec vitest run tests/e2e/relay.spec.ts`

The suite uses real loopback TCP/WebSocket connections for pairing, byte fidelity, duplicate roles, pre-host refusal, close cleanup, parser oversized messages, no-credit failure, bounded unread receivers/resume, write cap, absolute TTL/abort and scheme policy. A structural DO fixture verifies attachment restoration, no duplicate control messages, persisted credit/counters, and alarm cleanup. It does **not** substitute for actual Workers deployment/hibernation/rate-limit testing. No dependencies are installed and no test server is left running.
