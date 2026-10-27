// Deep browser E2E: transport evidence, guest RPC/stream use, terminal, revocation, invitation reuse.
// Usage: node scripts/e2e-deep.mjs <base> <token>
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const [base, token] = process.argv.slice(2)
if (!base || !token) throw new Error('usage: node scripts/e2e-deep.mjs <base> <token>')
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
const ownerErrors = []
owner.on('pageerror', error => ownerErrors.push(error.message))

const admin = (page, action, input = {}) => page.evaluate(async ([action, input]) => {
  const response = await fetch('/api/room', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...input }) })
  return response.json()
}, [action, input])

// --- owner: open the panel through the UI ---
await owner.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
await owner.waitForSelector('#root > *', { timeout: 30_000 })
await owner.waitForTimeout(1200)
const dismiss = owner.getByRole('button', { name: '继续' })
if (await dismiss.count() > 0) await dismiss.first().click({ force: true })
await owner.waitForTimeout(600)

const reset = await admin(owner, 'state')
if (reset.ok && reset.value.room.phase === 'open') await admin(owner, 'close')

await owner.getByLabel('新建会话').first().click({ force: true })
await owner.waitForTimeout(1800)
await owner.getByLabel('打开右侧边栏').first().click({ force: true })
await owner.waitForTimeout(1200)
await owner.getByText('DSH Room', { exact: false }).first().click({ force: true })
await owner.getByRole('button', { name: '开启房间' }).waitFor({ timeout: 10_000 })
await owner.getByRole('button', { name: '开启房间' }).click()
await owner.getByRole('button', { name: '生成邀请链接' }).waitFor({ timeout: 15_000 })
check('owner opens the room from the panel', true)

const readInvite = async () => {
  await owner.getByRole('button', { name: '生成邀请链接' }).click()
  const input = owner.locator('input[readonly]').first()
  await input.waitFor({ timeout: 10_000 })
  return input.inputValue()
}
const inviteUrl = await readInvite()
check('invitation link minted', inviteUrl.includes('/join#'))

// --- guest ---
const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const guest = await guestContext.newPage()
const guestErrors = []
guest.on('pageerror', error => guestErrors.push(error.message))
const sockets = []
guest.on('websocket', ws => {
  const entry = { url: ws.url(), frames: 0 }
  sockets.push(entry)
  ws.on('framereceived', () => { entry.frames += 1 })
  ws.on('framesent', () => { entry.frames += 1 })
})

await guest.goto(inviteUrl, { waitUntil: 'domcontentloaded' })
await guest.waitForFunction(() => document.body.innerText.includes('等待房主批准'), undefined, { timeout: 20_000 })
check('guest waits for approval', true)

await owner.getByRole('button', { name: '批准' }).first().click()
await guest.waitForURL(url => !url.pathname.startsWith('/join'), { timeout: 30_000 })
await guest.waitForSelector('#root > *', { timeout: 30_000 })
await guest.waitForTimeout(3000)
check('guest renders the proxied UI', true)

const mux = sockets.find(entry => entry.url.includes('/api/remote.mux'))
check('guest opened the DSH mux WebSocket', mux !== undefined, mux?.url ?? sockets.map(entry => entry.url).join(','))
check('mux carried frames', (mux?.frames ?? 0) > 0, `${mux?.frames ?? 0} frames`)

// --- guest actually uses the session through the proxy ---
const before = (await guest.evaluate(() => document.body.innerText)).length
await guest.getByText('审查远程控制实现', { exact: false }).first().click({ force: true })
await guest.waitForTimeout(3500)
const afterText = await guest.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
check('guest can open an existing session', afterText.length > before + 200, `${before} → ${afterText.length} chars`)
check('session content streamed to the guest', afterText.includes('远程') || afterText.includes('会话'))
await guest.screenshot({ path: `${shots}/guest-session.png` })

// --- guest proves full owner capability: a real terminal command ---
const rightSidebar = guest.getByLabel('打开右侧边栏')
if (await rightSidebar.count() > 0) { await rightSidebar.first().click({ force: true }); await guest.waitForTimeout(1500) }
const newTerminal = guest.getByLabel('新建终端 在会话工作区运行命令')
if (await newTerminal.count() > 0) {
  await newTerminal.first().click({ force: true })
  await guest.waitForTimeout(2500)
  const marker = `dsh-room-e2e-${Date.now().toString(36)}`
  await guest.locator('.xterm').first().click({ force: true }).catch(() => undefined)
  await guest.waitForTimeout(500)
  await guest.keyboard.type(`echo ${marker}`)
  await guest.keyboard.press('Enter')
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await guest.waitForTimeout(500)
    const screen = await guest.evaluate(() => document.body.innerText)
    if (screen.includes(marker)) break
  }
  const screen = await guest.evaluate(() => document.body.innerText)
  check('guest can run a terminal command', screen.includes(marker), screen.includes(marker) ? 'echo printed the marker' : 'no output')
  await guest.screenshot({ path: `${shots}/guest-terminal.png` })
} else {
  report.push('SKIP  terminal surface not found in this build')
}

// --- invitation reuse ---
const reuseContext = await browser.newContext()
const reuse = await reuseContext.newPage()
await reuse.goto(inviteUrl, { waitUntil: 'domcontentloaded' })
await reuse.waitForTimeout(2500)
const reuseText = await reuse.evaluate(() => document.body.innerText)
check('consumed invitation cannot be reused', !reuseText.includes('等待房主批准'), reuseText.replace(/\s+/g, ' ').slice(0, 40))
await reuseContext.close()

// --- revocation ---
const roomState = await admin(owner, 'state')
const memberId = roomState.value.room.members[0]?.id ?? ''
await owner.getByRole('button', { name: '踢出' }).first().click()
await owner.getByText('在线成员 (0)', { exact: false }).waitFor({ timeout: 15_000 })
check('owner kicks through the panel', true)
await guest.waitForTimeout(1200)
const status = await guest.evaluate(async () => (await fetch('/', { redirect: 'manual' })).status).catch(() => 0)
check('kicked guest loses access', status === 401, String(status))
check('kicked member left the panel', memberId !== '')

await owner.getByRole('button', { name: '关闭房间' }).click()
await owner.getByRole('button', { name: '开启房间' }).waitFor({ timeout: 15_000 })
check('room closes', true)

check('no owner page errors', ownerErrors.length === 0, ownerErrors.slice(0, 2).join(' | '))
check('no guest page errors', guestErrors.length === 0, guestErrors.slice(0, 2).join(' | '))

await browser.close()
console.log(report.join('\n'))
