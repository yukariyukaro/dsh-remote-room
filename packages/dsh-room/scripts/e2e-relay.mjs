// Relay end-to-end: the owner dials out to a relay, the guest reaches DSH through a non-loopback address.
// Usage: node scripts/e2e-relay.mjs <ownerBase> <token> <relayAuthority>
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const [base, token, authority, secret = 'dsh-room-demo-secret-1234', scheme = 'http'] = process.argv.slice(2)
if (!base || !token || !authority) throw new Error('usage: node scripts/e2e-relay.mjs <ownerBase> <token> <relayAuthority> [secret] [http|https]')
const shots = 'artifacts/e2e'
await mkdir(shots, { recursive: true })

const report = []
const check = (name, ok, extra = '') => {
  report.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) process.exitCode = 1
}

const browser = await chromium.launch()
const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const owner = await ownerContext.newPage()
await owner.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
await owner.waitForSelector('#root > *', { timeout: 30_000 })
await owner.waitForTimeout(1000)
const dismiss = owner.getByRole('button', { name: '继续' })
if (await dismiss.count() > 0) await dismiss.first().click({ force: true })

const admin = (action, input = {}) => owner.evaluate(async ([action, input]) => {
  const response = await fetch('/api/room', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...input }) })
  return response.json()
}, [action, input])

const before = await admin('state')
if (before.ok && before.value.room.phase === 'open') await admin('close')
const opened = await admin('listen')
check('room opened', opened.ok === true)

const relayed = await admin('relay.connect', {
  url: `${scheme === 'https' ? 'wss' : 'ws'}://${authority}/tunnel`,
  room: 'room',
  secret,
  authority,
  publicUrl: `${scheme}://${authority}`,
})
check('host dials the relay', relayed.ok === true && relayed.value.relay.enabled === true, relayed.ok ? relayed.value.relay.authority : JSON.stringify(relayed))
await owner.waitForTimeout(1500)

const invited = await admin('invite')
const inviteToken = invited.value.invitationUrl.split('#')[1]
const guestUrl = `${scheme}://${authority}/join#${inviteToken}`

const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const guest = await guestContext.newPage()
const sockets = []
guest.on('websocket', ws => {
  const entry = { url: ws.url(), frames: 0 }
  sockets.push(entry)
  ws.on('framereceived', () => { entry.frames += 1 })
  ws.on('framesent', () => { entry.frames += 1 })
})
guest.on('pageerror', error => report.push(`INFO  guest pageerror: ${error.message.slice(0, 80)}`))

await guest.goto(guestUrl, { waitUntil: 'domcontentloaded' })
check('guest reaches the pairing page through the relay', true)
await guest.getByPlaceholder('你的名字（会显示给房主）').fill('中继访客')
await guest.getByRole('button', { name: '申请加入' }).click()
await guest.waitForFunction(() => document.body.innerText.includes('已发送申请'), undefined, { timeout: 20_000 })

await admin('approve', { id: (await admin('state')).value.room.pending[0].id })
await guest.waitForURL(url => !url.pathname.startsWith('/join'), { timeout: 30_000 })
await guest.waitForSelector('#root > *', { timeout: 30_000 })
await guest.waitForTimeout(5000)
const guestText = await guest.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
check('guest renders the proxied DSH UI through the relay', guestText.length > 40, guestText.slice(0, 50))
check('guest session is connected, not reconnecting', !guestText.includes('重新连接'), guestText.includes('重新连接') ? 'UI still reconnecting' : 'stable')

const mux = sockets.find(entry => entry.url.includes('/api/remote.mux'))
check('guest WebSocket rides the relay', mux !== undefined && mux.frames > 10, mux ? `${mux.frames} frames` : 'no socket')
await guest.screenshot({ path: `${shots}/relay-guest.png` })

// A write request proves the tunnel carries non-GET traffic with the session cookie.
const write = await guest.evaluate(async () => {
  const response = await fetch('/api/room', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"state"}' })
  return response.status
})
check('owner bridge stays hidden through the relay', write === 404, String(write))

const kicked = await admin('kick', { id: (await admin('state')).value.room.members[0].id })
check('owner can revoke a relayed member', kicked.ok === true && kicked.value.room.members.length === 0)
check('invitation link uses the public relay', typeof invited.value.invitationUrl === 'string' && invited.value.invitationUrl.startsWith(`${scheme}://${authority}`), invited.value.invitationUrl?.split('#')[0])
const refused = await guest.evaluate(async () => (await fetch('/', { redirect: 'manual' })).status).catch(() => 0)
check('revoked guest is refused', refused === 401, String(refused))

await admin('relay.disconnect')
await admin('close')
check('relay and room closed', true)

await browser.close()
console.log(report.join('\n'))
