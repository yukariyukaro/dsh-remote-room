import { describe, expect, it } from 'vitest'
import { RelayHost, lanAddress, type RelayServerOptions } from '../../src/host/relay-host.ts'

type Interfaces = NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>
function ipv4(address: string, internal = false): import('node:os').NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: `${address}/24` }
}

class FakeModule {
  readonly starts: RelayServerOptions[] = []
  closes = 0
  fail = 0
  async startRelay(options: RelayServerOptions) {
    this.starts.push(options)
    if (this.fail > 0) { this.fail--; throw new Error('port unavailable') }
    return { url: `ws://${options.host}:5555`, close: async () => { this.closes++ } }
  }
}

describe('local relay selection', () => {
  it('binds a loopback relay with a fresh reservation token', async () => {
    const module = new FakeModule()
    const host = new RelayHost(async () => module)
    const endpoint = await host.endpoint('local')
    expect(endpoint).toMatchObject({ kind: 'local', url: 'ws://127.0.0.1:5555' })
    expect(endpoint.createToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(module.starts[0]).toMatchObject({ host: '127.0.0.1', port: 0, allowLan: false })
    await host.dispose()
  })

  it('reuses one relay per reach', async () => {
    const module = new FakeModule()
    const host = new RelayHost(async () => module)
    await Promise.all([host.endpoint('local'), host.endpoint('local')])
    await host.endpoint('local')
    expect(module.starts).toHaveLength(1)
    await host.dispose()
  })

  it('binds the network only for a same-network share', async () => {
    const module = new FakeModule()
    const host = new RelayHost(async () => module)
    const endpoint = await host.endpoint('lan')
    expect(endpoint.url).toMatch(/^ws:\/\/\d+\.\d+\.\d+\.\d+:5555$/)
    expect(endpoint.url).not.toContain('0.0.0.0')
    expect(module.starts[0]).toMatchObject({ host: '0.0.0.0', allowLan: true })
    await host.dispose()
  })

  it('retries a reach that failed to start', async () => {
    const module = new FakeModule()
    module.fail = 1
    const host = new RelayHost(async () => module)
    await expect(host.endpoint('local')).rejects.toThrow('port unavailable')
    await expect(host.endpoint('local')).resolves.toMatchObject({ kind: 'local' })
    expect(module.starts).toHaveLength(2)
    await host.dispose()
  })

  it('closes every started relay once and refuses further starts', async () => {
    const module = new FakeModule()
    const host = new RelayHost(async () => module)
    await host.endpoint('local')
    await host.endpoint('lan')
    await host.dispose()
    await host.dispose()
    expect(module.closes).toBe(2)
    await expect(host.endpoint('local')).rejects.toMatchObject({ code: 'DISPOSED' })
  })
})

describe('network address selection', () => {
  it('prefers private ranges and ignores unusable interfaces', () => {
    const interfaces: Interfaces = {
      loopback: [ipv4('127.0.0.1', true)],
      docker: [ipv4('172.17.0.1')],
      wifi: [ipv4('192.168.1.24')],
      vpn: [ipv4('10.8.0.2')],
      linkLocal: [ipv4('169.254.10.5')],
    }
    expect(lanAddress(interfaces)).toBe('192.168.1.24')
    expect(lanAddress({ wifi: [ipv4('192.168.1.24')], vpn: [ipv4('10.8.0.2')] })).toBe('192.168.1.24')
    expect(lanAddress({ vpn: [ipv4('10.8.0.2')], docker: [ipv4('172.17.0.1')] })).toBe('10.8.0.2')
  })

  it('reports no address when only loopback or link-local interfaces exist', () => {
    expect(lanAddress({})).toBeUndefined()
    expect(lanAddress({ loopback: [ipv4('127.0.0.1', true)] })).toBeUndefined()
    expect(lanAddress({ apipa: [ipv4('169.254.3.4')] })).toBeUndefined()
  })
})
