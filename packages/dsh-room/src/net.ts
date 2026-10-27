/** Address classification for the sharing gateway: binding guard and direct-peer allow lists. */

export interface Cidr { family: 4 | 6; bytes: Uint8Array; prefix: number }

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** Parse a dotted-quad literal; null when any octet is out of range or the text is not IPv4. */
export function parseIpv4(text: string): Uint8Array | undefined {
  const match = IPV4.exec(text)
  if (match === null) return undefined
  const bytes = new Uint8Array(4)
  for (let index = 0; index < 4; index += 1) {
    const value = Number(match[index + 1])
    if (!Number.isInteger(value) || value > 255) return undefined
    bytes[index] = value
  }
  return bytes
}

/** Parse an IPv6 literal, including a trailing embedded IPv4 part. Zone ids are rejected here. */
export function parseIpv6(text: string): Uint8Array | undefined {
  if (!text.includes(':')) return undefined
  let source = text.toLowerCase()
  const lastColon = source.lastIndexOf(':')
  const tail = source.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail)
    if (v4 === undefined) return undefined
    const high = ((v4[0] ?? 0) << 8) | (v4[1] ?? 0)
    const low = ((v4[2] ?? 0) << 8) | (v4[3] ?? 0)
    source = `${source.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`
  }
  const halves = source.split('::')
  if (halves.length > 2) return undefined
  const left = halves[0] === '' ? [] : (halves[0] ?? '').split(':')
  const right = halves.length === 2 && halves[1] !== '' ? (halves[1] ?? '').split(':') : []
  const groups = halves.length === 2 ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left
  if (groups.length !== 8) return undefined
  const bytes = new Uint8Array(16)
  for (let index = 0; index < 8; index += 1) {
    const group = groups[index] ?? ''
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined
    const value = Number.parseInt(group, 16)
    bytes[index * 2] = value >> 8
    bytes[index * 2 + 1] = value & 0xff
  }
  return bytes
}

/** Drop an IPv6 zone index and unwrap IPv4-mapped addresses to dotted quad. */
export function normalizeAddress(raw: string): string {
  let text = raw.trim().toLowerCase()
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text)
  if (mapped !== null && parseIpv4(mapped[1] ?? '') !== undefined) return mapped[1] ?? text
  return text
}

export function addressBytes(raw: string): { family: 4 | 6; bytes: Uint8Array } | undefined {
  const text = normalizeAddress(raw)
  const v4 = parseIpv4(text)
  if (v4 !== undefined) return { family: 4, bytes: v4 }
  const v6 = parseIpv6(text)
  if (v6 !== undefined) return { family: 6, bytes: v6 }
  return undefined
}

export function isLoopbackAddress(raw: string): boolean {
  const parsed = addressBytes(raw)
  if (parsed === undefined) return false
  if (parsed.family === 4) return parsed.bytes[0] === 127
  return parsed.bytes.every((value, index) => (index === 15 ? value === 1 : value === 0))
}

/** RFC1918, link-local, CGNAT, loopback and the IPv6 ULA/link-local equivalents. */
export function isPrivateAddress(raw: string): boolean {
  const parsed = addressBytes(raw)
  if (parsed === undefined) return false
  const b = parsed.bytes
  if (parsed.family === 4) {
    return b[0] === 10
      || (b[0] === 172 && (b[1] ?? 0) >= 16 && (b[1] ?? 0) <= 31)
      || (b[0] === 192 && b[1] === 168)
      || (b[0] === 169 && b[1] === 254)
      || (b[0] === 100 && (b[1] ?? 0) >= 64 && (b[1] ?? 0) <= 127)
      || b[0] === 127
  }
  if (b.every((value, index) => (index === 15 ? value === 1 : value === 0))) return true
  const linkLocal = (b[0] ?? 0) === 0xfe && ((b[1] ?? 0) & 0xc0) === 0x80
  const uniqueLocal = (b[0] ?? 0) === 0xfc || (b[0] ?? 0) === 0xfd
  return linkLocal || uniqueLocal
}

/** Parse `address/prefix`; a bare address becomes a host route. */
export function parseCidr(entry: string): Cidr {
  const [address, prefix] = entry.includes('/') ? entry.split('/', 2) : [entry, undefined]
  const parsed = addressBytes(address ?? '')
  if (parsed === undefined) throw new Error(`Not an IP address: ${JSON.stringify(entry)}`)
  const max = parsed.family === 4 ? 32 : 128
  const bits = prefix === undefined ? max : Number(prefix)
  if (!Number.isInteger(bits) || bits < 0 || bits > max) throw new Error(`Invalid prefix length in ${JSON.stringify(entry)}`)
  return { family: parsed.family, bytes: parsed.bytes, prefix: bits }
}

export function inCidr(parsed: Cidr, address: string): boolean {
  const target = addressBytes(address)
  if (target === undefined || target.family !== parsed.family) return false
  let remaining = parsed.prefix
  for (let index = 0; index < parsed.bytes.length && remaining > 0; index += 1) {
    const bits = Math.min(8, remaining)
    const mask = 0xff << (8 - bits) & 0xff
    if (((parsed.bytes[index] ?? 0) & mask) !== ((target.bytes[index] ?? 0) & mask)) return false
    remaining -= bits
  }
  return true
}

export function inAnyCidr(entries: readonly Cidr[], address: string): boolean {
  return entries.some(entry => inCidr(entry, address))
}
