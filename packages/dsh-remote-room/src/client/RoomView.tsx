/** Connected view: the shared tree, its previews, and the audit trail behind a disclosure. */
import { useEffect, useState } from 'react'
import type { AuditEntry, DirectoryEntry, Failure, RemoteRoomApi, RoomSnapshot } from './contracts.ts'
import { fileAddress } from './contracts.ts'
import type { Translate } from './locale.ts'
import { failureOf } from './bridge.ts'
import { Callout, Empty, Pill } from './ui.tsx'
import { Terminal } from './Terminal.tsx'
import {
  FileTypeIcon, IconFolderOpenOutlineRegular, IconRefreshOutlineRegular, IconShieldOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'

export interface RoomViewProps {
  t: Translate
  room: RoomSnapshot
  api: RemoteRoomApi
  connected: boolean
  busy: boolean
  open?: (address: string) => void
  onClose(): void
}

function Tree({ t, room, api, open }: Pick<RoomViewProps, 't' | 'room' | 'api' | 'open'>): JSX.Element {
  const [trail, setTrail] = useState<string[]>([room.root ?? '.'])
  const path = trail[trail.length - 1] ?? '.'
  const [entries, setEntries] = useState<DirectoryEntry[]>()
  const [failure, setFailure] = useState<Failure>()
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const request = new AbortController(); setFailure(undefined)
    void api.list({ roomId: room.id, epoch: room.epoch, path }, request.signal)
      .then(setEntries, cause => { if (!request.signal.aborted) setFailure(failureOf(cause)) })
    return () => request.abort()
  }, [api, room.id, room.epoch, path, revision])
  const sorted = entries ? [...entries].sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name)) : []
  return (
    <div className="rr-tree">
      <div className="rr-treebar">
        <button type="button" className="rr-crumb" disabled={trail.length < 2} onClick={() => setTrail(value => value.slice(0, -1))}>{t('parent')}</button>
        <span className="rr-treebar-path" title={path}>{path}</span>
        <button type="button" className="rr-btn" data-variant="ghost" aria-label={t('refresh')} onClick={() => setRevision(n => n + 1)}>
          <IconRefreshOutlineRegular size={16} />
        </button>
      </div>
      {failure ? <Callout tone="danger">{failure.message}</Callout> : null}
      {!entries && !failure ? <p className="rr-hint">{t('loading')}</p> : null}
      {entries?.length === 0 ? <Empty title={t('emptyDirectory')} /> : null}
      <ul className="rr-rows">
        {sorted.map(entry => (
          <li key={entry.name}>
            <button type="button" className="rr-row" disabled={entry.type === 'other' || (entry.type === 'file' && !open)}
              onClick={() => {
                const next = entry.target.displayPath
                if (entry.type === 'directory') setTrail(value => [...value, next])
                else if (entry.type === 'file') open?.(fileAddress({ roomId: room.id, epoch: room.epoch, path: next }))
              }}>
              {entry.type === 'directory'
                ? <IconFolderOpenOutlineRegular size={17} />
                : <FileTypeIcon path={entry.name} size={17} />}
              <span className="rr-rowname">{entry.name}</span>
              {entry.size !== undefined ? <span className="rr-rowsize">{entry.size.toLocaleString()} B</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Audit({ t, room, api }: Pick<RoomViewProps, 't' | 'room' | 'api'>): JSX.Element {
  const [entries, setEntries] = useState<AuditEntry[]>()
  useEffect(() => {
    const request = new AbortController()
    void api.audit(room.id, request.signal).then(value => { if (!request.signal.aborted) setEntries(value) }, () => {})
    return () => request.abort()
  }, [api, room.id, room.epoch])
  return (
    <details className="rr-audit">
      <summary>{t('audit')}</summary>
      {entries === undefined ? <p className="rr-hint">{t('loading')}</p> : null}
      {entries?.length === 0 ? <p className="rr-hint">{t('noAudit')}</p> : null}
      <ul>{entries?.map(entry => <li key={entry.seq}><time>{new Date(entry.time).toLocaleTimeString()}</time>{entry.operation}{entry.path ? ` · ${entry.path}` : ''}</li>)}</ul>
    </details>
  )
}

export function RoomView({ t, room, api, connected, busy, open, onClose }: RoomViewProps): JSX.Element {
  const danger = room.mode === 'danger-full-access'
  return (
    <div className="rr-stage">
      <header className="rr-hero rr-hero-room">
        <div className="rr-herotext">
          <h1>{room.name ?? t('title')}</h1>
          <p>{room.role === 'host' ? t('host') : t('guest')} · {room.root}</p>
        </div>
        <div className="rr-statusrow">
          <span className="rr-dot" data-live={connected} />
          <Pill tone={connected ? 'success' : 'warning'}>{t('statusAuthorized')}</Pill>
        </div>
      </header>
      {danger ? <Callout tone="danger"><IconShieldOutlineRegular size={14} />{t('dangerWarning')}</Callout> : null}
      <Tree t={t} room={room} api={api} open={open} />
      {danger ? <Terminal room={room} api={api} connected={connected && true} t={t} /> : null}
      <Audit t={t} room={room} api={api} />
      <button type="button" className="rr-btn rr-end" disabled={busy} onClick={onClose}>{t('endShare')}</button>
    </div>
  )
}
