import { describe, expect, it } from 'vitest'
import { inAnyCidr, isLoopbackAddress, isPrivateAddress, normalizeAddress, parseCidr } from '../../src/net.ts'

describe('address classification', () => {
  it('classifies private and public IPv4', () => {
    for (const address of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.20', '169.254.1.1', '100.64.0.1', '127.0.0.1']) {
      expect(isPrivateAddress(address), address).toBe(true)
    }
    for (const address of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '203.0.113.5']) {
      expect(isPrivateAddress(address), address).toBe(false)
    }
  })

  it('classifies IPv6 loopback, ULA and link-local', () => {
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isPrivateAddress('fd00::1')).toBe(true)
    expect(isPrivateAddress('fe80::1')).toBe(true)
    expect(isPrivateAddress('2001:4860::8888')).toBe(false)
  })

  it('unwraps IPv4-mapped addresses and zone ids', () => {
    expect(normalizeAddress('::ffff:192.168.1.4')).toBe('192.168.1.4')
    expect(normalizeAddress('fe80::1%eth0')).toBe('fe80::1')
    expect(isPrivateAddress('::ffff:10.0.0.5')).toBe(true)
  })

  it('matches CIDR ranges without stretching the prefix', () => {
    const lan = parseCidr('192.168.1.0/24')
    expect(inAnyCidr([lan], '192.168.1.7')).toBe(true)
    expect(inAnyCidr([lan], '192.168.2.7')).toBe(false)
    expect(inAnyCidr([parseCidr('127.0.0.0/8')], '::ffff:127.0.0.1')).toBe(true)
    expect(inAnyCidr([parseCidr('::1/128')], '::1')).toBe(true)
    expect(inAnyCidr([parseCidr('fd00::/8')], 'fd12:3456::1')).toBe(true)
    expect(inAnyCidr([parseCidr('fd00::/8')], 'fe80::1')).toBe(false)
  })
})
