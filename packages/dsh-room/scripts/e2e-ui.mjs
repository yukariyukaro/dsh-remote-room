// Fully UI-driven end-to-end: the owner clicks the panel, a second browser joins as guest.
// Usage: node scripts/e2e-ui.mjs <base> <token>
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const [base, token] = process.argv.slice(2)
if (!base || !token) throw new Error('usage: node scripts/e2e-ui.mjs <base> <token>')
const shots = 'artifacts/e2e'
await mkdir(shots, { recursive: true })

const report = []
const check = (name, ok, extra = '') => {
  report.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) process.exitCode = 1
}

const browser = await chromium.launch()
const owner = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await owner.newPage()
const pageErrors = []
page.on('pageerror', error => pageErrors.push(error.message))

await page.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#root > *', { timeout: 30_000 })
await page.waitForTimeout(1200)
const dismiss = page.getByRole('button', { name: '继续' })
if (await dismiss.count() > 0) await dismiss.first().click({ force: true })
await page.waitForTimeout(600)

await page.getByLabel('新建会话').first().click({ force: true })
await page.waitForTimeout(1800)
await page.getByLabel('打开右侧边栏').first().click({ force: true })
await page.waitForTimeout(1200)
await page.getByText('DSH Room', { exact: false }).first().click({ force: true })
await page.waitForTimeout(1000)
check('room panel opens from the sidebar', await page.getByRole('button', { name: '开启房间' }).count() === 1)

await page.getByRole('button', { name: '开启房间' }).click()
await page.getByRole('button', { name: '生成邀请链接' }).waitFor({ timeout: 15_000 })
const listen = await page.evaluate(() => document.body.innerText.match(/监听地址\s*(\S+)/)?.[1] ?? '')
check('panel opens a listener', listen.startsWith('http://'), listen)
await page.screenshot({ path: `${shots}/panel-open.png` })

await page.getByRole('button', { name: '生成邀请链接' }).click()
const invite = page.locator('input[readonly]').first()
await invite.waitFor({ timeout: 10_000 })
const inviteUrl = await invite.inputValue()
check('panel shows an invitation link', inviteUrl.includes('/join#'), inviteUrl.replace(/#.*/, '#…'))
await page.screenshot({ path: `${shots}/panel-invite.png` })

const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const guest = await guestContext.newPage()
await guest.goto(inviteUrl, { waitUntil: 'domcontentloaded' })
await guest.waitForFunction(() => document.body.innerText.includes('等待房主批准'), undefined, { timeout: 20_000 })
check('guest waits for approval', true)
await guest.screenshot({ path: `${shots}/guest-waiting.png` })

await page.getByRole('button', { name: '批准' }).first().click()
await page.getByText('在线成员 (1)', { exact: false }).waitFor({ timeout: 15_000 })
check('owner sees the approved member', true)
await page.screenshot({ path: `${shots}/panel-member.png` })

await guest.waitForURL(url => !url.pathname.startsWith('/join'), { timeout: 30_000 })
await guest.waitForSelector('#root > *', { timeout: 30_000 })
await guest.waitForTimeout(2500)
const guestText = await guest.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
check('guest loads the proxied DSH UI', guestText.length > 40, guestText.slice(0, 60))
await guest.screenshot({ path: `${shots}/guest-app.png` })

await page.getByRole('button', { name: '踢出' }).first().click()
await page.getByText('在线成员 (0)', { exact: false }).waitFor({ timeout: 15_000 })
check('owner kicks the member', true)
const refused = await guest.evaluate(async () => (await fetch('/', { redirect: 'manual' })).status).catch(() => 0)
check('kicked guest is refused', refused === 401, String(refused))

await page.getByRole('button', { name: '关闭房间' }).click()
await page.getByRole('button', { name: '开启房间' }).waitFor({ timeout: 15_000 })
check('owner closes the room', true)
await page.screenshot({ path: `${shots}/panel-closed.png` })
check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))

await browser.close()
console.log(report.join('\n'))
