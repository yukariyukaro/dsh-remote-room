// Live smoke test against a running DSH Web instance. Usage: node scripts/smoke-live.mjs <base> <token>
import { WebSocket } from 'ws'

const base = process.argv[2]
const token = process.argv[3]
if (!base || !token) throw new Error('usage: node scripts/smoke-live.mjs <base> <token>')

const report = []
const check = (name, ok, extra = '') => {
  report.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) process.exitCode = 1
}

const firstCookie = response => {
  const values = response.headers.getSetCookie?.() ?? []
  return values.length === 0 ? '' : values[0].split(';')[0]
}

const owner = firstCookie(await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' }))
check('owner cookie minted', owner.startsWith('dsh-auth-'), owner.slice(0, 24))

const admin = async (action, input = {}) => {
  const response = await fetch(`${base}/api/room`, {
    method: 'POST',
    headers: { cookie: owner, 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...input }),
  })
  return response.json()
}

const initial = await admin('state')
check('room starts closed', initial.ok === true && initial.value.room.phase === 'closed')

const listed = await admin('listen')
check('room opens a listener', listed.ok === true && listed.value.room.phase === 'open', listed.ok ? `${listed.value.listener.host}:${listed.value.listener.port}` : JSON.stringify(listed))
const guestBase = listed.ok ? `http://${listed.value.listener.host}:${listed.value.listener.port}` : ''

const invited = await admin('invite')
check('invitation minted', invited.ok === true && typeof invited.value.invitationUrl === 'string')
const inviteUrl = invited.ok ? invited.value.invitationUrl : ''
const inviteToken = inviteUrl.split('#')[1] ?? ''

const joinPage = await fetch(`${guestBase}/join`)
const joinHtml = await joinPage.text()
check('pairing page served', joinPage.status === 200 && joinHtml.includes('DSH Room'))

const anonymous = await fetch(`${guestBase}/`, { redirect: 'manual' })
check('anonymous guest refused', anonymous.status === 401, String(anonymous.status))

const requested = await (await fetch(`${guestBase}/join/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: inviteToken }) })).json()
check('join request accepted', requested.ok === true && typeof requested.requestId === 'string')

const waiting = await (await fetch(`${guestBase}/join/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requested) })).json()
check('request waits for approval', waiting.ok === true && waiting.phase === 'pending')

const approved = await admin('approve', { id: requested.requestId })
check('owner approves', approved.ok === true && approved.value.room.members.length === 1)

const polled = await fetch(`${guestBase}/join/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requested) })
const guest = firstCookie(polled)
check('guest session issued', guest.startsWith('dsh_room='), guest.slice(0, 18))

const index = await fetch(`${guestBase}/`, { headers: { cookie: guest }, redirect: 'manual' })
const indexHtml = await index.text()
check('proxied UI served', index.status === 200 && indexHtml.includes('DeepSeek Harness'), String(index.status))
check('no upstream cookie leaked', index.headers.getSetCookie?.().length === 0)

const assetPath = indexHtml.includes('src="./') ? indexHtml.split('src="./')[1].split('"')[0] : ''
if (assetPath !== '') {
  const file = await fetch(`${guestBase}/${assetPath}`, { headers: { cookie: guest } })
  check('proxied asset served', file.status === 200, `${assetPath} ${file.status}`)
}

const bridge = await fetch(`${guestBase}/api/room`, { method: 'POST', headers: { cookie: guest, 'content-type': 'application/json' }, body: '{"action":"state"}' })
check('guest cannot reach owner bridge', bridge.status === 404, String(bridge.status))

const crossSite = await fetch(`${guestBase}/`, { headers: { cookie: guest, origin: 'http://evil.example' }, redirect: 'manual' })
check('foreign origin refused', crossSite.status === 403, String(crossSite.status))

const socketState = await new Promise(resolve => {
  const ws = new WebSocket(`${guestBase.replace('http', 'ws')}/api/remote.mux`, { headers: { cookie: guest } })
  const timer = setTimeout(() => { ws.terminate(); resolve('timeout') }, 4000)
  ws.on('open', () => { clearTimeout(timer); ws.close(); resolve('open') })
  ws.on('error', error => { clearTimeout(timer); resolve(`error: ${error.message}`) })
})
check('guest mux WebSocket upgrades', socketState === 'open', socketState)

const kickedId = approved.ok ? approved.value.room.members[0].id : ''
const kicked = await admin('kick', { id: kickedId })
check('member removed', kicked.ok === true && kicked.value.room.members.length === 0)

const afterKick = await fetch(`${guestBase}/`, { headers: { cookie: guest }, redirect: 'manual' })
check('kicked guest refused', afterKick.status === 401, String(afterKick.status))

const closed = await admin('close')
check('room closes', closed.ok === true && closed.value.room.phase === 'closed')

const afterClose = await fetch(`${guestBase}/`, { redirect: 'manual' }).catch(() => undefined)
check('gateway stopped listening', afterClose === undefined || afterClose.status >= 500 || afterClose.status === 0)

console.log(report.join('\n'))
