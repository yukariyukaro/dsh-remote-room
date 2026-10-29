import { describe, expect, it } from 'vitest'
import { createPrivateKey, X509Certificate } from 'node:crypto'
import { createInvitation, invitationUrl, parseInvitation, validateRelay } from '../../src/invite.ts'

describe('v2 bearer invitation encoding', () => {
  it('round trips bounded DER credentials using only the fragment', async () => {
    const created = await createInvitation('wss://relay.example.test/rooms')
    const parsed = parseInvitation(created.url)
    expect(parsed.roomId).toBe(created.invitation.roomId)
    expect(parsed.relay).toBe('wss://relay.example.test/rooms')
    expect(new X509Certificate(parsed.credential.certificate).fingerprint256).toBe(new X509Certificate(created.invitation.credential.certificate).fingerprint256)
    expect(createPrivateKey(parsed.credential.privateKey).asymmetricKeyType).toBe('ec')
    const url = new URL(created.url)
    expect(url.pathname).toBe('/v2')
    expect(url.search).toBe('')
    expect(url.hash).toContain('certificate=')
    expect(url.href.length).toBeLessThan(8192)
    expect(invitationUrl(parsed)).toBe(created.url)
  })
  it('keeps the credential window far beyond any share, so a link dies with its room', async () => {
    const created = await createInvitation('wss://relay.example.test')
    const certificate = new X509Certificate(created.invitation.credential.certificate)
    // The certificate is a backstop for a leaked credential, not the invitation's deadline:
    // the product rule is that a room, not a clock, ends a share.
    expect(Date.parse(certificate.validTo) - Date.parse(certificate.validFrom)).toBeGreaterThanOrEqual(3650 * 86_400_000)
    expect(Date.parse(certificate.validTo)).toBeGreaterThan(Date.now() + 365 * 86_400_000)
    expect(Date.parse(certificate.validFrom)).toBeLessThanOrEqual(Date.now())
  })
  it('rejects old versions, duplicated fields, malformed keys and room swaps instead of falling back', async () => {
    const a = await createInvitation('ws://127.0.0.1:12345')
    const b = await createInvitation('ws://127.0.0.1:12345')
    expect(() => parseInvitation(a.url.replace('/v2', '/v1'))).toThrow('Unsupported invitation version')
    expect(() => parseInvitation(`${a.url}&room=${a.invitation.roomId}`)).toThrow('Invalid invitation fields')
    const swapped = new URL(a.url)
    const params = new URLSearchParams(swapped.hash.slice(1))
    params.set('room', b.invitation.roomId)
    swapped.hash = params.toString()
    expect(() => parseInvitation(swapped.href)).toThrow('Invalid or expired invitation credential')
    params.set('room', a.invitation.roomId); params.set('key', 'bad_key')
    swapped.hash = params.toString()
    expect(() => parseInvitation(swapped.href)).toThrow('Invalid or expired invitation credential')
    expect(() => parseInvitation('x'.repeat(8193))).toThrow('Invitation is too long')
  })
  it('permits secure relays, and plaintext only on loopback or private-network addresses', () => {
    expect(validateRelay('wss://relay.example.test/')).toBe('wss://relay.example.test')
    expect(validateRelay('ws://127.0.0.1:12345')).toBe('ws://127.0.0.1:12345')
    expect(validateRelay('ws://[::1]:12345')).toBe('ws://[::1]:12345')
    for (const url of ['ws://192.168.0.9:7777', 'ws://10.1.2.3:7777', 'ws://172.16.0.1:7777', 'ws://172.31.255.254:7777']) expect(validateRelay(url)).toBe(url)
    for (const url of [
      'ws://relay.example.test', 'ws://localhost:12345', 'https://relay.example.test',
      'wss://user:secret@relay.example.test', 'wss://relay.example.test?key=x', 'wss://relay.example.test#x',
      // Outside RFC1918: plaintext is never acceptable on a network the operator does not own.
      'ws://8.8.8.8:7777', 'ws://172.32.0.1:7777', 'ws://192.169.0.1:7777', 'ws://100.64.0.1:7777', 'ws://169.254.1.1:7777',
    ]) expect(() => validateRelay(url)).toThrow()
  })
})
