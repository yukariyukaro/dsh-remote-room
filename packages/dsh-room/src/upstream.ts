/** Mint and hold the loopback DSH browser cookie. It never leaves the Host process. */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export interface Credentials { cookie(): Promise<string>; invalidate(): void }

/**
 * Exchange the process launch token for a browser cookie bound to the loopback authority,
 * then keep it in memory. Concurrent callers share one exchange.
 */
export class LoopbackCredentials implements Credentials {
  private cached: string | undefined
  private inflight: Promise<string> | undefined

  constructor(private readonly authority: string, private readonly authenticatedUrl: () => string) {}

  invalidate(): void {
    this.cached = undefined
    this.inflight = undefined
  }

  async cookie(): Promise<string> {
    if (this.cached !== undefined) return this.cached
    this.inflight ??= this.exchange().finally(() => { this.inflight = undefined })
    return this.inflight
  }

  private async exchange(): Promise<string> {
    const target = new URL(this.authenticatedUrl())
    const response = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
      // Redirects are followed manually: the token exchange answers 303 to a relative location.
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest
      const request = send({
        host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: 'GET',
        headers: { host: this.authority, accept: 'text/html' }, agent: false,
        ...(target.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
      }, incoming => {
        incoming.resume()
        resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers })
      })
      request.on('error', reject)
      request.end()
    })
    if (response.status !== 200 && response.status !== 303 && response.status !== 302) {
      throw new Error(`loopback authentication failed with HTTP ${response.status}`)
    }
    const raw = response.headers['set-cookie']
    const cookies = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
    const cookie = cookies.map(value => value.split(';', 1)[0]?.trim() ?? '').filter(value => value.length > 0).join('; ')
    if (cookie === '') throw new Error('loopback authentication returned no cookie')
    this.cached = cookie
    return cookie
  }
}
