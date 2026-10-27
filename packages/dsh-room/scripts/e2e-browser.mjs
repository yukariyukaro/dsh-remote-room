// Browser end-to-end: owner opens a room, a second browser joins as guest.
// Usage: node scripts/e2e-browser.mjs <base> <token>
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const base = process.argv[2]
const token = process.argv[3]
if (!base || !token) throw new Error('usage: node scripts/e2e-browser.mjs <base> <token>')

const shots = 'artifacts/e2e'
await mkdir(shots, { recursive: true })

const report = []
const check = (name, ok, extra = '') => {
  report.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) process.exitCode = 1
}

const browser = await chromium.launch()
const errors = []
const watch = (page, label) => {
  page.on('console', message => { if (message.type() === 'error') errors.push(`${label}: ${message.text()}`) })
  page.on('pageerror', error => errors.push(`${label}: ${error.message}`))
}

const admin = (page, action, input = {}) => page.evaluate(async ([action, input]) => {
  const response = await fetch('/api/room', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...input }),
  })
  return response.json()
}, [action, input])

// --- owner ---
const owner = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const ownerPage = await owner.newPage()
watch(ownerPage, 'owner')
await ownerPage.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
await ownerPage.waitForSelector('#root > *', { timeout: 30_000 })
check('owner UI renders', true)

const inBootGraph = await ownerPage.evaluate(() => JSON.stringify(globalThis.__DSH_BOOT__ ?? {}).includes('dsh-room'))
check('plugin is in the boot graph', inBootGraph)

const state = await admin(ownerPage, 'state')
check('owner bridge reachable from the page', state.ok === true && state.value.room.phase === 'closed')

const opened = await admin(ownerPage, 'listen')
check('room opened', opened.ok === true && opened.value.room.phase === 'open', opened.ok ? `${opened.value.listener.host}:${opened.value.listener.port}` : JSON.stringify(opened))
const guestBase = `http://${opened.value.listener.host}:${opened.value.listener.port}`

const invited = await admin(ownerPage, 'invite')
check('invitation created', invited.ok === true && typeof invited.value.invitationUrl === 'string')
const inviteUrl = invited.value.invitationUrl
await ownerPage.screenshot({ path: `${shots}/owner.png` })

// --- guest ---
const guestContext = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const guestPage = await guestContext.newPage()
watch(guestPage, 'guest')
await guestPage.goto(inviteUrl, { waitUntil: 'domcontentloaded' })
await guestPage.waitForFunction(() => document.body.innerText.includes('等待房主批准'), undefined, { timeout: 20_000 })
check('guest sees the waiting page', true)
await guestPage.screenshot({ path: `${shots}/guest-waiting.png` })

const pending = await admin(ownerPage, 'state')
check('owner sees the pending request', pending.ok === true && pending.value.room.pending.length === 1)
const approved = await admin(ownerPage, 'approve', { id: pending.value.room.pending[0].id })
check('owner approved', approved.ok === true && approved.value.room.members.length === 1)

await guestPage.waitForURL(url => !url.pathname.startsWith('/join'), { timeout: 30_000 })
await guestPage.waitForSelector('#root > *', { timeout: 30_000 })
const guestText = await guestPage.evaluate(() => document.body.innerText.slice(0, 200))
check('guest renders the proxied DSH UI', guestText.length > 0, guestText.replace(/\s+/g, ' ').slice(0, 60))

// Same-origin API through the guest session: the DSH RPC bridge must answer, not the owner bridge.
const guestBridge = await guestPage.evaluate(async () => {
  const response = await fetch('/api/room', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"state"}' })
  return response.status
})
check('guest cannot reach the owner bridge', guestBridge === 404, String(guestBridge))

await guestPage.waitForTimeout(1500)
await guestPage.screenshot({ path: `${shots}/guest-app.png` })

const room = await admin(ownerPage, 'state')
check('owner still sees one member', room.ok === true && room.value.room.members.length === 1)
await admin(ownerPage, 'kick', { id: room.value.room.members[0].id })
await guestPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined)
const afterKick = await guestPage.evaluate(async () => {
  const response = await fetch('/', { redirect: 'manual' })
  return response.status
}).catch(() => 0)
check('kicked guest is refused', afterKick === 401, String(afterKick))

await admin(ownerPage, 'close')
check('room closed', true)
check('no browser errors', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
console.log(report.join('\n'))
if (errors.length > 0) console.log('--- errors ---\n' + errors.slice(0, 10).join('\n'))
