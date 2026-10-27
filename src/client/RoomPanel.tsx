/** Remote workbench rendered only inside Harness slots. */
import React, { useEffect, useState } from 'react'
import type { AuditEntry, DirectoryEntry, Failure, RemoteRoomApi, RoomMode, RoomSnapshot } from './contracts.ts'
import { fileAddress } from './contracts.ts'
import type { ClientSnapshot } from './state.ts'
import type { Translate } from './locale.ts'
import { failureOf } from './bridge.ts'
import { styles } from './styles.ts'
import { Terminal } from './Terminal.tsx'
export interface RoomPanelProps {
  t: Translate
  useRoomState: <T>(selector: (state: ClientSnapshot) => T) => T
  api: RemoteRoomApi
  mutate: <T>(operation: Promise<T>) => Promise<T>
  refresh: () => Promise<void>
  useTabInfo?: () => { tab: { actions: { openResource(address: string, options?: { params?: { line?: number }; preferNewPane?: boolean }): void } } }
  openFile?: (address: string) => void
  canOpenFiles?: boolean
}
export function ErrorNotice({ error, t }: { error: Failure; t: Translate }) {
  return <div className="rr-error" role="alert"><strong>{t('error')}</strong><div>{error.message}</div><code>{error.code}</code></div>
}
function Badge({ room, t }: { room: RoomSnapshot; t: Translate }) {
  return <div className="rr-badges"><span className="rr-badge">{t(room.role === 'host' ? 'hostLabel' : 'guestLabel')}</span><span className="rr-badge" data-state={room.phase}>{t(room.phase)}</span>{room.mode ? <span className="rr-badge">{t(room.mode === 'read-only' ? 'readonly' : room.mode === 'workspace-write' ? 'workspacewrite' : 'danger')}</span> : null}</div>
}
function CreateForm({ api, mutate, t }: Pick<RoomPanelProps, 'api' | 'mutate' | 't'>) {
  const [relay, setRelay] = useState('')
  const [root, setRoot] = useState('')
  const [mode, setMode] = useState<RoomMode>('read-only')
  const [invitation, setInvitation] = useState('')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Failure>()
  return <section className="rr-card"><h2><span className="rr-number">01</span>{t('host')}</h2><form className="rr-form" onSubmit={event => {
    event.preventDefault(); setBusy(true); setError(undefined); setInvitation(''); setCopied(false)
    void mutate(api.create({ relay: relay.trim(), root: root.trim(), mode })).then(result => setInvitation(result.invitation), cause => setError(failureOf(cause))).finally(() => setBusy(false))
  }}>
    <label className="rr-label">{t('relay')}<input className="rr-input" type="url" inputMode="url" autoComplete="off" spellCheck={false} value={relay} required placeholder="wss://relay.example.com" onChange={event => setRelay(event.target.value)} /></label>
    <label className="rr-label">{t('root')}<input className="rr-input" autoComplete="off" spellCheck={false} value={root} required placeholder="/srv/project" onChange={event => setRoot(event.target.value)} /></label>
    <label className="rr-label">{t('mode')}<select className="rr-input" value={mode} onChange={event => setMode(event.target.value as RoomMode)}><option value="read-only">{t('readonly')}</option><option value="workspace-write">{t('workspacewrite')}</option><option value="danger-full-access">{t('danger')}</option></select></label>{mode === 'danger-full-access' ? <p className="rr-notice">{t('execUnavailable')}</p> : null}
    <button className="rr-btn" data-primary="true" disabled={busy} type="submit">{busy ? t('busy') : t('create')}<span aria-hidden="true">↗</span></button>
  </form><p className="rr-notice">{t('boundary')}</p>{error ? <ErrorNotice error={error} t={t} /> : null}
  {invitation ? <div className="rr-invite"><label className="rr-label">{t('invitation')}<textarea className="rr-input" readOnly value={invitation} onFocus={event => event.currentTarget.select()} /></label><p className="rr-notice">{t('invitationHint')}</p><button className="rr-btn" type="button" onClick={() => { void (navigator.clipboard ? navigator.clipboard.writeText(invitation) : Promise.reject(new Error('clipboard unavailable'))).then(() => setCopied(true), () => setError({ code: 'clipboard/unavailable', message: t('selectInvitation') })) }}>{copied ? t('copied') : t('copy')}</button></div> : null}</section>
}
function JoinForm({ api, mutate, t }: Pick<RoomPanelProps, 'api' | 'mutate' | 't'>) {
  const [invitation, setInvitation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Failure>()
  return <section className="rr-card"><h2><span className="rr-number">02</span>{t('guest')}</h2><form className="rr-form" onSubmit={event => {
    event.preventDefault(); setBusy(true); setError(undefined)
    void mutate(api.join(invitation.trim())).then(() => setInvitation(''), cause => setError(failureOf(cause))).finally(() => setBusy(false))
  }}><label className="rr-label">{t('invitation')}<textarea className="rr-input" value={invitation} required autoComplete="off" spellCheck={false} onChange={event => setInvitation(event.target.value)} /></label><button className="rr-btn" disabled={busy || !invitation.trim()} data-primary="true" type="submit">{busy ? t('busy') : t('join')}<span aria-hidden="true">→</span></button></form><p className="rr-notice">{t('invitationHint')}</p>{error ? <ErrorNotice error={error} t={t} /> : null}</section>
}
function Files({ room, api, open, t }: { room: RoomSnapshot; api: RemoteRoomApi; open?: (address: string) => void; t: Translate }) {
  const [trail, setTrail] = useState<string[]>([room.root ?? '.'])
  const path = trail[trail.length - 1] ?? '.'
  const [entries, setEntries] = useState<DirectoryEntry[]>()
  const [error, setError] = useState<Failure>()
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const request = new AbortController(); setEntries(undefined); setError(undefined)
    void api.list({ roomId: room.id, epoch: room.epoch, path }, request.signal).then(setEntries, cause => { if (!request.signal.aborted) setError(failureOf(cause)) })
    return () => request.abort()
  }, [api, room.id, room.epoch, path, revision])
  const sorted = entries ? [...entries].sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name)) : []
  return <section><div className="rr-treehead"><strong>{t('files')}</strong><div className="rr-buttons"><button className="rr-btn" disabled={trail.length < 2} onClick={() => setTrail(value => value.slice(0, -1))}>{t('parent')}</button><button className="rr-btn" onClick={() => setRevision(n => n + 1)}>{t('refresh')}</button></div></div><p className="rr-path">{path}</p>
    {!open ? <p className="rr-notice">{t('sessionOnly')}</p> : null}{error ? <ErrorNotice error={error} t={t} /> : null}{entries === undefined && !error ? <p role="status" className="rr-notice">{t('loading')}</p> : null}
    {entries?.length === 0 ? <p className="rr-notice">{t('noFiles')}</p> : null}<ul className="rr-tree">{sorted.map(entry => <li key={entry.name}><button type="button" disabled={entry.type !== 'directory' && (entry.type !== 'file' || !open)} title={entry.name} onClick={() => {
      const next = entry.target.displayPath
      if (entry.type === 'directory') setTrail(value => [...value, next])
      else if (entry.type === 'file') open?.(fileAddress({ roomId: room.id, epoch: room.epoch, path: next }))
    }}><span className="rr-tree-icon" aria-hidden="true">{entry.type === 'directory' ? '▸' : entry.type === 'file' ? '·' : '–'}</span><span className="rr-tree-name">{entry.name}</span>{entry.size !== undefined ? <span className="rr-size">{entry.size.toLocaleString()} B</span> : null}</button></li>)}</ul></section>
}
function Audit({ room, api, t }: { room: RoomSnapshot; api: RemoteRoomApi; t: Translate }) {
  const [entries, setEntries] = useState<AuditEntry[]>()
  const [error, setError] = useState<Failure>()
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (room.phase !== 'authorized') return
    const request = new AbortController(); setError(undefined)
    void api.audit(room.id, request.signal).then(value => { if (!request.signal.aborted) setEntries(value) }, cause => { if (!request.signal.aborted) setError(failureOf(cause)) })
    return () => request.abort()
  }, [room.id, room.epoch, room.phase, api, revision])
  return <section className="rr-section"><div className="rr-sectionhead"><h3>{t('audit')}</h3><button className="rr-btn" disabled={room.phase !== 'authorized'} onClick={() => setRevision(value => value + 1)}>{t('refresh')}</button></div>{error ? <ErrorNotice error={error} t={t} /> : null}{!entries && !error ? <p className="rr-notice" role="status">{t(room.phase === 'authorized' ? 'loading' : 'noPermission')}</p> : null}{entries?.length === 0 ? <p className="rr-notice">{t('noAudit')}</p> : null}<ul className="rr-audit">{entries?.map(entry => <li key={entry.seq}><time>{new Date(entry.time).toLocaleString()}</time>{entry.operation} · {entry.status} {entry.path ?? ''}{entry.outcome ? ` · ${entry.outcome.operation ?? ''} ${entry.outcome.beforeBytes ?? 0} → ${entry.outcome.afterBytes} B` : ''}{entry.code ? ` · ${entry.code}` : ''}</li>)}</ul></section>
}
function RoomRow({ room, api, mutate, open, t, connected }: { room: RoomSnapshot; api: RemoteRoomApi; mutate: RoomPanelProps['mutate']; open?: (address: string) => void; t: Translate; connected: boolean }) {
  const [expanded, setExpanded] = useState(room.phase === 'authorized' || room.phase === 'pending')
  const [visited, setVisited] = useState(room.phase === 'authorized' || room.phase === 'pending')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Failure>()
  const run = (operation: () => Promise<RoomSnapshot>): void => { setBusy(true); setError(undefined); void mutate(operation()).catch(cause => setError(failureOf(cause))).finally(() => setBusy(false)) }
  return <article className="rr-room"><button type="button" className="rr-roomhead" aria-expanded={expanded} onClick={() => { setVisited(true); setExpanded(value => !value) }}><span className="rr-roomname">{expanded ? '−' : '+'} {room.id}</span><Badge room={room} t={t} /></button>{visited ? <div className="rr-roomcontent" hidden={!expanded}><p className="rr-path">{room.root ?? t('source')}<br />{t('epoch')}: {room.epoch}</p>
    {room.error ? <ErrorNotice error={{ code: 'remote-room/connection', message: room.error }} t={t} /> : null}{error ? <ErrorNotice error={error} t={t} /> : null}
    {room.role === 'host' && room.phase === 'pending' ? <><p className="rr-notice">{t('approveHint')}</p><button type="button" className="rr-btn" data-primary="true" disabled={busy} onClick={() => run(() => api.approve(room.id))}>{busy ? t('busy') : t('approve')}</button></> : null}
    <div className="rr-buttons">{room.role === 'host' && room.phase === 'authorized' ? <button className="rr-btn" disabled={busy} data-danger="true" onClick={() => { if (window.confirm(t('confirmRevoke'))) run(() => api.revoke(room.id)) }}>{t('revoke')}</button> : null}{room.phase !== 'closed' ? <button className="rr-btn" disabled={busy} onClick={() => { if (window.confirm(t('confirmClose'))) run(() => api.close(room.id)) }}>{t('close')}</button> : null}</div>
    {room.mode === 'danger-full-access' ? <Terminal room={room} api={api} connected={connected && expanded} t={t} /> : null}
    {room.phase === 'authorized' ? <Files key={`${room.id}:${room.epoch}`} room={room} api={api} open={open} t={t} /> : <p className="rr-notice">{t('awaiting')}</p>}<Audit room={room} api={api} t={t} />
  </div> : null}</article>
}
export function RoomPanel(props: RoomPanelProps) {
  const { api, mutate, refresh, t, useRoomState } = props
  const snapshot = useRoomState(state => state)
  const info = props.useTabInfo?.()
  const open = info ? (address: string) => info.tab.actions.openResource(address, { preferNewPane: true }) : props.canOpenFiles ? props.openFile : undefined
  const [error, setError] = useState<Failure>()
  const workbench = info !== undefined
  const forms = <div className="rr-grid"><CreateForm api={api} mutate={mutate} t={t} /><JoinForm api={api} mutate={mutate} t={t} /></div>
  return <div className="rr" data-workbench={workbench}><style>{styles}</style><main className="rr-shell"><header className="rr-mast"><div><div className="rr-kicker">{t('source')} / DSH</div><h1>{t('title')}</h1><p className="rr-subtitle">{t('subtitle')}</p></div><div className="rr-connection" role="status"><span className="rr-dot" data-live={snapshot.connected} />{t(snapshot.connected ? 'connected' : 'disconnected')}</div></header>
    {snapshot.failure ? <ErrorNotice error={snapshot.failure} t={t} /> : null}{error ? <ErrorNotice error={error} t={t} /> : null}
    {!workbench ? forms : null}<section className="rr-section"><div className="rr-sectionhead"><h2>{t('rooms')}<span className="rr-count">{String(snapshot.state.rooms.length).padStart(2, '0')}</span></h2><button className="rr-btn" onClick={() => { setError(undefined); void refresh().catch(cause => setError(failureOf(cause))) }}>{t('refresh')}</button></div>
    {snapshot.state.rooms.length === 0 ? <div className="rr-empty"><strong>{t('empty')}</strong>{t('emptyHint')}</div> : snapshot.state.rooms.map(room => <RoomRow key={room.id} room={room} api={api} mutate={mutate} open={open} t={t} connected={snapshot.connected} />)}</section>{workbench ? <details className="rr-connect"><summary>{t('manageConnections')}</summary>{forms}</details> : null}<footer className="rr-footer">{t('localSafe')}</footer>
  </main></div>
}
