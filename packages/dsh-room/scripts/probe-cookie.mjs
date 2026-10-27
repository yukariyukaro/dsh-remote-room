import { chromium } from 'playwright'
const [base, token, authority, secret] = process.argv.slice(2)
const browser = await chromium.launch()
const ownerCtx = await browser.newContext()
const owner = await ownerCtx.newPage()
await owner.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
await owner.waitForSelector('#root > *', { timeout: 30000 })
const admin = (action, input = {}) => owner.evaluate(async ([action, input]) => {
  const r = await fetch('/api/room', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...input }) })
  return r.json()
}, [action, input])
const s0 = await admin('state')
if (s0.value?.room.phase === 'open') await admin('close')
await admin('listen')
await admin('relay.connect', { url: `wss://${authority}/tunnel`, room: 'room', secret, authority, publicUrl: `https://${authority}` })
await owner.waitForTimeout(1500)
const invited = await admin('invite')
const inviteToken = invited.value.invitationUrl.split('#')[1]

const guestCtx = await browser.newContext()
const guest = await guestCtx.newPage()
guest.on('response', async r => {
  if (r.url().includes('/join/status')) {
    try { console.log('status resp', r.status(), 'set-cookie=', JSON.stringify(r.headers()['set-cookie'])) } catch {}
  }
})
await guest.goto(`https://${authority}/join#${inviteToken}`, { waitUntil: 'domcontentloaded' })
await guest.getByPlaceholder('你的名字（会显示给房主）').fill('探针')
await guest.getByRole('button', { name: '申请加入' }).click()
await guest.waitForFunction(() => document.body.innerText.includes('已发送申请'), undefined, { timeout: 20000 })
await owner.waitForTimeout(400)
await admin('approve', { id: (await admin('state')).value.room.pending[0].id })
await guest.waitForTimeout(4000)
console.log('cookies', (await guestCtx.cookies()).map(c => c.name).join(',') || '(none)')
await admin('relay.disconnect'); await admin('close')
await browser.close()
