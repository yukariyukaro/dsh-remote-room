/** Owner panel: open a room, mint invitations, approve or kick members. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComponentType, ReactElement } from 'react'

interface Listener { host: string; port: number; secure: boolean }
interface Pending { id: string; address: string; label: string; requestedAt: number }
interface Member { id: string; address: string; label: string; joinedAt: number; lastSeenAt: number }
interface RoomSnapshot { phase: 'closed' | 'open'; roomId: string; epoch: string; openedAt: number; listener?: Listener; pending: Pending[]; members: Member[] }
interface AdminValue { room: RoomSnapshot; listener?: Listener; error: string; invitationUrl?: string; relay?: { enabled: boolean; authority: string } }

interface GuideEntry { id: string; order: number; title: () => string; description: () => string }
interface ClientContext {
  effect(effect: () => (() => void) | void, label?: string): unknown
  sidebarRightTabs: { register(definition: { id: string; kind: string; keepMounted?: boolean; title: () => string; guide?: GuideEntry[] }): () => void }
  slots: { inject(name: string, factory: () => (() => void)): () => void; register<P>(options: object, component: ComponentType<P>): () => void }
}

export const inject = ['slots', 'sidebarRightTabs']

const TAB_ID = 'dsh-room/panel'

function endpoint(path: string): URL {
  const base = document.baseURI.endsWith('/') ? document.baseURI : new URL('.', document.baseURI).href
  return new URL(path, base)
}

async function call(action: string, input: Record<string, unknown> = {}): Promise<AdminValue> {
  const response = await fetch(endpoint('api/room'), {
    method: 'POST', credentials: 'same-origin', signal: undefined,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ action, ...input }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const result = await response.json() as { ok: boolean; value?: AdminValue; error?: { message: string } }
  if (result.ok !== true || result.value === undefined) throw new Error(result.error?.message ?? '请求失败')
  return result.value
}

const addressOf = (value: AdminValue): string => {
  const listener = value.listener ?? value.room.listener
  if (listener === undefined) return ''
  const host = listener.host.includes(':') ? `[${listener.host}]` : listener.host
  return `${listener.secure ? 'https' : 'http'}://${host}:${listener.port}`
}

const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '14px', fontSize: '13px', lineHeight: 1.5, color: 'var(--dsh-text-primary, #e6edf3)', overflow: 'auto' },
  row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' as const },
  muted: { color: 'var(--dsh-text-secondary, #8b98a5)', fontSize: '12px' },
  card: { border: '1px solid var(--dsh-border, #2b333d)', borderRadius: '8px', padding: '10px' },
  primary: { background: '#2f6feb', color: '#fff', border: '0', borderRadius: '6px', padding: '6px 12px', cursor: 'pointer' },
  ghost: { background: 'transparent', color: 'inherit', border: '1px solid var(--dsh-border, #2b333d)', borderRadius: '6px', padding: '4px 10px', cursor: 'pointer' },
  danger: { background: 'transparent', color: '#f08c8c', border: '1px solid #6b3030', borderRadius: '6px', padding: '4px 10px', cursor: 'pointer' },
  input: { flex: '1 1 12rem', minWidth: '8rem', background: 'var(--dsh-surface, #161b22)', color: 'inherit', border: '1px solid var(--dsh-border, #2b333d)', borderRadius: '6px', padding: '6px 8px' },
  error: { color: '#f08c8c' },
} as const

function Panel(): ReactElement {
  const [value, setValue] = useState<AdminValue>()
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState(false)
  const [inviteUrl, setInviteUrl] = useState('')
  const mounted = useRef(true)

  const apply = useCallback((next: AdminValue) => {
    if (!mounted.current) return
    setValue(next)
    setFailure(next.error)
  }, [])

  const run = useCallback(async (action: string, input: Record<string, unknown> = {}) => {
    setBusy(true)
    try {
      const next = await call(action, input)
      apply(next)
      if (next.invitationUrl !== undefined) setInviteUrl(next.invitationUrl)
      if (action === 'close') setInviteUrl('')
    } catch (error) {
      if (mounted.current) setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [apply])

  useEffect(() => {
    mounted.current = true
    void run('state')
    const source = new EventSource(endpoint('api/room/events').href, { withCredentials: true })
    source.addEventListener('message', event => {
      try { apply(JSON.parse((event as MessageEvent<string>).data) as AdminValue) } catch { /* ignore malformed frames */ }
    })
    return () => { mounted.current = false; source.close() }
  }, [apply, run])

  const room = value?.room
  const open = room?.phase === 'open'
  void room

  return (
    <div style={styles.root}>
      <div>
        <strong>DSH Room</strong>
        <div style={styles.muted}>把当前 DSH Web 共享给完全信任的人。访客获得与本机相同的操作能力。</div>
      </div>
      {failure !== '' ? <div style={styles.error}>{failure}</div> : null}
      {!open ? (
        <div style={styles.card}>
          <div style={styles.muted}>房间关闭时不会监听任何端口。</div>
          <div style={{ ...styles.row, marginTop: '8px' }}>
            <button style={styles.primary} disabled={busy} onClick={() => void run('listen')}>开启房间</button>
          </div>
        </div>
      ) : (
        <>
          <div style={styles.card}>
            <div style={styles.row}>
              <span style={styles.muted}>监听地址</span>
              <code>{value === undefined ? '' : addressOf(value)}</code>
            </div>
            {value?.listener?.host === '127.0.0.1' ? (
              <div style={styles.muted}>
                访客先用 SSH 转发到本机端口，再打开连接：
                <br />
                <code>ssh -L 127.0.0.1:17443:127.0.0.1:{value.listener.port} 房主主机</code>
                <br />
                然后把邀请链接里的 127.0.0.1:{value.listener.port} 换成 127.0.0.1:17443。
              </div>
            ) : null}
            {value?.relay?.enabled === true ? (
              <div style={styles.muted}>中继已连接：{value.relay.authority}</div>
            ) : null}
            <div style={{ ...styles.row, marginTop: '8px' }}>
              <button style={styles.primary} disabled={busy} onClick={() => void run('invite')}>生成邀请链接</button>
              <button style={styles.ghost} disabled={busy} onClick={() => void run('close')}>关闭房间</button>
            </div>
            {inviteUrl !== '' ? (
              <div style={{ marginTop: '8px' }}>
                <div style={styles.muted}>一次性链接，5 分钟内有效：</div>
                <div style={styles.row}>
                  <input style={styles.input} readOnly value={inviteUrl} onFocus={event => event.currentTarget.select()} />
                  <button style={styles.ghost} onClick={() => void navigator.clipboard?.writeText(inviteUrl)}>复制</button>
                </div>
              </div>
            ) : null}
          </div>
          <div style={styles.card}>
            <div style={styles.muted}>等待批准 ({room?.pending.length ?? 0})</div>
            {(room?.pending ?? []).length === 0 ? <div style={styles.muted}>没有人正在等待。</div> : null}
            {(room?.pending ?? []).map(entry => (
              <div key={entry.id} style={{ ...styles.row, marginTop: '6px' }}>
                <span>{entry.label || entry.address}</span>
                <span style={styles.muted}>{new Date(entry.requestedAt).toLocaleTimeString()}</span>
                <button style={styles.primary} disabled={busy} onClick={() => void run('approve', { id: entry.id })}>批准</button>
                <button style={styles.danger} disabled={busy} onClick={() => void run('deny', { id: entry.id })}>拒绝</button>
              </div>
            ))}
          </div>
          <div style={styles.card}>
            <div style={styles.muted}>在线成员 ({room?.members.length ?? 0})</div>
            {(room?.members ?? []).length === 0 ? <div style={styles.muted}>还没有人加入。</div> : null}
            {(room?.members ?? []).map(entry => (
              <div key={entry.id} style={{ ...styles.row, marginTop: '6px' }}>
                <span>{entry.label || entry.address}</span>
                <span style={styles.muted}>{new Date(entry.lastSeenAt).toLocaleTimeString()}</span>
                <button style={styles.danger} disabled={busy} onClick={() => void run('kick', { id: entry.id })}>踢出</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: 'dsh-room',
    keepMounted: true,
    title: () => 'DSH Room',
    // The guide is what lists a page type in the right sidebar's tab picker.
    guide: [{ id: 'room', order: 46, title: () => 'DSH Room', description: () => '把当前 DSH 共享给完全信任的人' }],
  }), 'room: panel type')
  const body = Panel as ComponentType
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, body)), 'room: panel body')
  // A root settings entry works without a mounted conversation.
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dsh-room', order: 46, label: () => 'DSH Room' }, body)), 'room: settings entry')
}
