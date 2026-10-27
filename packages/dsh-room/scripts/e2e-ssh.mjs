// Simulates "ssh -L 127.0.0.1:17443:127.0.0.1:<gateway>" and verifies the guest path end to end.
import net from 'node:net'
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const [base, token, gatewayPort = '19443', localPort = '17443'] = process.argv.slice(2)
if (!base || !token) throw new Error('usage: node scripts/e2e-ssh.mjs <ownerBase> <token> [gatewayPort] [localPort]')
const shots = 'artifacts/e2e'
await mkdir(shots, { recursive: true })

const report = []
const check = (name, ok, extra = '') => {
  report.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) process.exitCode = 1
}

// The forwarder is what ssh -L does: accept on the local port, dial the gateway on loopback.
const forwarder = net.createServer(client => {
  const upstream = net.connect(Number(gatewayPort), '127.0.0.1')
  client.pipe(upstream).pipe(client)
  const close = () => { client.destroy(); upstream.destroy() }
  client.on('error', close); upstream.on('error', close)
  client.on('close', close); upstream.on('close', close)
})
await new Promise(resolve => forwarder.listen(Number(localPort), '127.0.0.1', resolve))

const browser = await chromium.launch()
const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const owner = await ownerContext.newPage()
await owner.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
await owner.waitForSelector('#root > *', { timeout: 30_000 })
await owner.waitForTimeout(800)
const dismiss = owner.getByRole('button', { name: '继续' })
if (await dismiss.count() > 0) await dismiss.first().click({ force: true })
const admin = (action, input = {}) => owner.evaluate(async ([action, input]) => {
  const response = await fetch('/api/room', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...input }) })
  return response.json()
}, [action, input])
const before = await admin('state')
if (before.ok && before.value.room.phase === 'open') await admin('close')
await admin('listen')
const invited = await admin('invite')
const inviteToken = invited.value.invitationUrl.split('#')[1]

const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const guest = await guestContext.newPage()
const sockets = []
guest.on('websocket', ws => {
  const entry = { url: ws.url(), frames: 0, closed: false }
  sockets.push(entry)
  ws.on('framesent', () => { entry.frames += 1 })
  ws.on('framereceived', () => { entry.frames += 1 })
  ws.on('close', () => { entry.closed = true })
})

await guest.goto(`http://127.0.0.1:${localPort}/join#${inviteToken}`, { waitUntil: 'domcontentloaded' })
await guest.waitForFunction(() => document.body.innerText.includes('已发送申请'), undefined, { timeout: 20_000 })
check('guest pairing page reached through the SSH-style port', true)
await guest.getByPlaceholder('你的名字（会显示给房主）').fill('SSH 访客')
await guest.getByRole('button', { name: '申请加入' }).click()

const pending = await admin('state')
check('owner sees the guest name', pending.value.room.pending[0]?.label === 'SSH 访客', pending.value.room.pending[0]?.label ?? '(none)')
await admin('approve', { id: pending.value.room.pending[0].id })

await guest.waitForURL(url => !url.pathname.startsWith('/join'), { timeout: 30_000 })
await guest.waitForSelector('#root > *', { timeout: 30_000 })
await guest.waitForTimeout(5000)
const text = await guest.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
check('UI renders over the SSH-style port', text.length > 40, text.slice(0, 40))
check('session connects instead of reconnecting', !text.includes('重新连接'))

const mux = sockets.find(entry => entry.url.includes('/api/remote.mux'))
check('mux WebSocket established', mux !== undefined && mux.frames > 10, mux ? `${mux.frames} frames` : 'none')
await guest.screenshot({ path: `${shots}/ssh-guest.png` })

const members = await admin('state')
await admin('kick', { id: members.value.room.members[0].id })
await guest.waitForTimeout(1500)
check('kick closes the live WebSocket', mux?.closed === true, mux?.closed ? 'closed' : 'still open')
const status = await guest.evaluate(async () => (await fetch('/', { redirect: 'manual' })).status).catch(() => 0)
check('kicked guest is refused afterwards', status === 401, String(status))

await admin('close')
await browser.close()
forwarder.close()
console.log(report.join('\n'))
