import { chromium } from 'playwright'
const [base, token, authority] = process.argv.slice(2)
const browser = await chromium.launch()
const ownerCtx = await browser.newContext()
const owner = await ownerCtx.newPage()
await owner.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' })
await owner.waitForSelector('#root > *', { timeout: 30000 })
await owner.waitForTimeout(800)
const admin = (action, input = {}) => owner.evaluate(async ([action, input]) => {
  const r = await fetch('/api/room', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...input }) })
  return r.json()
}, [action, input])
const state = await admin('state')
if (state.ok && state.value.room.phase === 'open') { await admin('relay.disconnect'); await admin('close') }
await admin('listen')
await admin('relay.connect', { url: `ws://${authority}/tunnel`, room: 'demo', secret: 'dsh-room-demo-secret-1234', authority })
await owner.waitForTimeout(1200)
const invited = await admin('invite')
const inviteToken = invited.value.invitationUrl.split('#')[1]

const guestCtx = await browser.newContext()
const guest = await guestCtx.newPage()
await guest.goto(`http://${authority}/join#${inviteToken}`, { waitUntil: 'domcontentloaded' })
await guest.waitForFunction(() => document.body.innerText.includes('等待房主批准'), undefined, { timeout: 20000 })
await admin('approve', { id: (await admin('state')).value.room.pending[0].id })
await guest.waitForURL(u => !u.pathname.startsWith('/join'), { timeout: 30000 })
await guest.waitForTimeout(1500)

const probe = await guest.evaluate(async (authority) => {
  const result = []
  const run = (url) => new Promise(resolve => {
    const events = []
    let socket
    try { socket = new WebSocket(url) } catch (error) { resolve([`ctor-error ${error}`]); return }
    const timer = setTimeout(() => { events.push('timeout'); try { socket.close() } catch {} resolve(events) }, 6000)
    socket.onopen = () => { events.push('open'); socket.send(JSON.stringify({ type: 'client-request', rpcId: 'probe-1', method: 'session/list', payload: {} })) }
    socket.onmessage = event => { events.push('msg:' + String(event.data).slice(0, 60)) }
    socket.onclose = event => { events.push(`close:${event.code}`); clearTimeout(timer); resolve(events) }
    socket.onerror = () => { events.push('error') }
  })
  result.push(['relay', await run(`ws://${authority}/api/remote.mux`)])
  result.push(['direct', await run('ws://127.0.0.1:19443/api/remote.mux')])
  return result
}, authority)
console.log(JSON.stringify(probe, null, 1))
await admin('relay.disconnect'); await admin('close')
await browser.close()
