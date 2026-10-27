import { chromium } from 'playwright'
import { writeFile } from 'node:fs/promises'
const [base, token] = process.argv.slice(2)
const browser = await chromium.launch()
const ownerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const owner = await ownerCtx.newPage()
const admin = (page, action, input = {}) => page.evaluate(async ([action, input]) => {
  const r = await fetch('/api/room', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...input }) })
  return r.json()
}, [action, input])
await owner.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
await owner.waitForSelector('#root > *', { timeout: 30000 })
await owner.waitForTimeout(1000)
const dismiss = owner.getByRole('button', { name: '继续' })
if (await dismiss.count() > 0) await dismiss.first().click({ force: true })
const state = await admin(owner, 'state')
if (state.value?.room.phase === 'open') await admin(owner, 'close')
await admin(owner, 'listen')
const invited = await admin(owner, 'invite')

const guestCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const guest = await guestCtx.newPage()
const failures = []
guest.on('response', r => { if (r.status() >= 400) failures.push(`${r.status()} ${r.url().slice(0, 120)}`) })
guest.on('requestfailed', r => failures.push(`FAILED ${r.url().slice(0, 120)} ${r.failure()?.errorText}`))
await guest.goto(invited.value.invitationUrl, { waitUntil: 'domcontentloaded' })
await guest.waitForFunction(() => document.body.innerText.includes('等待房主批准'), undefined, { timeout: 20000 })
const pending = await admin(owner, 'state')
await admin(owner, 'approve', { id: pending.value.room.pending[0].id })
await guest.waitForURL(u => !u.pathname.startsWith('/join'), { timeout: 30000 })
await guest.waitForSelector('#root > *', { timeout: 30000 })
await guest.waitForTimeout(2000)
await guest.getByLabel('新建会话').first().click({ force: true })
await guest.waitForTimeout(2000)

// 1. attachment button: does a file chooser appear, and does an upload land?
await writeFile('artifacts/e2e/upload-probe.txt', 'uploaded through the room gateway\n')
failures.length = 0
const chooser = guest.waitForEvent('filechooser', { timeout: 4000 }).catch(() => undefined)
await guest.getByLabel('添加文件或调用指令').first().click({ force: true })
await guest.waitForTimeout(800)
const menu = await guest.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(-200))
console.log('PLUS MENU TAIL:', menu)
const picked = await chooser
if (picked) {
  await picked.setFiles('artifacts/e2e/upload-probe.txt')
  await guest.waitForTimeout(3500)
  const after = await guest.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(-220))
  console.log('AFTER UPLOAD:', after)
} else {
  console.log('no file chooser opened from the + control')
}
console.log('FAILURES', JSON.stringify(failures.slice(0, 8), null, 1))
await guest.screenshot({ path: 'artifacts/e2e/guest-upload.png' })

// 2. mention picker
failures.length = 0
await guest.getByLabel('描述你想要构建的内容, / 调用指令, @ 文件或对话').first().click({ force: true })
await guest.keyboard.type('@')
await guest.waitForTimeout(2000)
const mention = await guest.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(-300))
console.log('MENTION:', mention)
console.log('FAILURES2', JSON.stringify(failures.slice(0, 8), null, 1))
await guest.screenshot({ path: 'artifacts/e2e/guest-mention.png' })
await admin(owner, 'close')
await browser.close()
