import { afterEach, describe, expect, it } from 'vitest'
import { createServer, connect, type Server } from 'node:net'
import { once } from 'node:events'
import { RpcPeer, defaultRpcLimits } from '../../src/wire/rpc.ts'
import { RoomError } from '../../src/protocol.ts'

const peers: RpcPeer[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close()
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))))
})
async function pair() {
  const server = createServer(); servers.push(server)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No TCP address')
  const accepted = once(server, 'connection')
  const socket = connect(address.port, '127.0.0.1'); await once(socket, 'connect')
  const [remote] = await accepted
  const a = new RpcPeer(socket)
  const b = new RpcPeer(remote)
  peers.push(a, b)
  return { a, b }
}

describe('real stream RPC', () => {
  it('carries concurrent UTF-8/binary envelopes and typed refusal in both directions', async () => {
    const { a, b } = await pair()
    b.serve(async (method, args) => {
      if (method === 'deny') throw new RoomError('NOT_AUTHORIZED', 'No room grant')
      return args
    })
    a.serve(async () => ({ source: 'guest' }))
    const input = { text: '云端 — é😀'.repeat(30_000), base64: Buffer.from([0, 255, 2]).toString('base64') }
    expect(await a.call('echo', input)).toEqual(input)
    expect(await b.call('reverse')).toEqual({ source: 'guest' })
    expect(await Promise.all(Array.from({ length: 8 }, (_, i) => a.call('echo', i)))).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    await expect(a.call('deny')).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
  })

  it('cancels work, does not replay a timed-out mutation, and ignores the late reply', async () => {
    const { a, b } = await pair()
    let calls = 0
    let aborted = false
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    b.serve(async (_method, _args, signal) => {
      calls++
      started()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }))
      return 'already executed'
    })
    const controller = new AbortController()
    const request = a.call('write', null, { signal: controller.signal })
    const rejected = expect(request).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' })
    await ready; controller.abort(); await rejected
    // Use a separate round trip after the cancel to ensure it has reached the peer.
    a.serve(async () => 'ack')
    await b.call('ack')
    expect(calls).toBe(1)
    expect(aborted).toBe(true)
  })

  it('refuses send limits without silently truncating a result', async () => {
    const { a, b } = await pair()
    b.serve(async () => 'x'.repeat(defaultRpcLimits.maxMessageBytes + 1))
    await expect(a.call('too-large')).rejects.toBeInstanceOf(Error)
  })

  it('aborts in-flight work and rejects new calls on disconnect', async () => {
    const { a, b } = await pair()
    let start!: () => void
    const ready = new Promise<void>(resolve => { start = resolve })
    b.serve(async (_method, _args, signal) => {
      start()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return null
    })
    const call = a.call('pending')
    const rejected = expect(call).rejects.toBeInstanceOf(Error)
    await ready; b.close(); await rejected
    await expect(a.call('again')).rejects.toMatchObject({ code: 'DISCONNECTED' })
  })
})
