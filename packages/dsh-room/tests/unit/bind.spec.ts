import { describe, expect, it } from 'vitest'
import { assertBindable } from '../../src/service.ts'

describe('bind guard', () => {
  it('accepts loopback without TLS', () => {
    expect(() => assertBindable('127.0.0.1', false)).not.toThrow()
    expect(() => assertBindable('::1', false)).not.toThrow()
  })

  it('refuses plaintext off loopback', () => {
    expect(() => assertBindable('192.168.1.20', false)).toThrowError(/TLS certificate/)
    expect(() => assertBindable('10.0.0.5', false)).toThrowError(/TLS certificate/)
  })

  it('accepts a private interface with TLS', () => {
    expect(() => assertBindable('192.168.1.20', true)).not.toThrow()
  })

  it('never accepts a wildcard or a public address', () => {
    for (const host of ['0.0.0.0', '::', '*', '']) {
      expect(() => assertBindable(host, true), host).toThrowError(/wildcard|private/)
    }
    expect(() => assertBindable('8.8.8.8', true)).toThrowError(/not a private address/)
  })
})
