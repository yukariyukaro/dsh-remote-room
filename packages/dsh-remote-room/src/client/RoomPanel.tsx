/** Share shell: decides which one of three screens the owner is looking at. */
import { useEffect, useState } from 'react'
import type { Failure, RemoteRoomApi, RoomSnapshot, ShareSettingsView, SettingsPatch } from './contracts.ts'
import type { ClientSnapshot } from './state.ts'
import type { Translate } from './locale.ts'
import { failureOf } from './bridge.ts'
import { styles } from './styles.ts'
import { Callout, Card, Pill } from './ui.tsx'
import { ShareHome } from './ShareHome.tsx'
import { InviteCard } from './InviteCard.tsx'
import { RoomView } from './RoomView.tsx'

export interface RoomPanelProps {
  t: Translate
  useRoomState: <T>(selector: (state: ClientSnapshot) => T) => T
  api: RemoteRoomApi
  mutate: <T>(operation: Promise<T>) => Promise<T>
  refresh: () => Promise<void>
  pickDirectory?: () => Promise<string | null>
  useTabInfo?: () => { tab: { actions: { openResource(address: string, options?: { params?: { line?: number }; preferNewPane?: boolean }): void } } }
  openFile?: (address: string) => void
  canOpenFiles?: boolean
  sessionId?: string
  useSessions?: <T>(selector: (sessions: { byId: Record<string, { cwd?: string }> }) => T) => T
}

const LIVE = new Set(['connecting', 'authenticating', 'pending', 'authorized'])

export function RoomPanel(props: RoomPanelProps): JSX.Element {
  const { api, mutate, refresh, t, useRoomState } = props
  const snapshot = useRoomState(state => state)
  const info = props.useTabInfo?.()
  const cwd = props.useSessions?.(sessions => props.sessionId ? sessions.byId[props.sessionId]?.cwd : undefined)
  const [settings, setSettings] = useState<ShareSettingsView>()
  const [invitation, setInvitation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Failure>()

  useEffect(() => {
    const request = new AbortController()
    void api.settings(request.signal).then(value => { if (!request.signal.aborted) setSettings(value) }, () => {})
    return () => request.abort()
  }, [api])

  const room: RoomSnapshot | undefined = [...snapshot.state.rooms].reverse().find(value => LIVE.has(value.phase))
  const open = info ? (address: string) => info.tab.actions.openResource(address, { preferNewPane: true }) : props.canOpenFiles ? props.openFile : undefined

  const run = (operation: () => Promise<void>): void => {
    setBusy(true); setError(undefined)
    void operation().catch(cause => setError(failureOf(cause))).finally(() => setBusy(false))
  }
  const save = (patch: SettingsPatch): void => {
    void mutate(api.updateSettings(patch)).then(setSettings, cause => setError(failureOf(cause)))
  }

  let body: JSX.Element
  if (!room && settings === undefined) {
    // Preferences carry the remembered relay and directory; render once, not twice with a stale first pass.
    body = <div className="rr-stage"><p className="rr-hint">{t('loading')}</p></div>
  } else if (!room) {
    // The active workspace is the default directory; a remembered pick only fills the gap.
    body = <ShareHome t={t} initialRoot={cwd || settings?.lastRoot || ''} settings={settings} busy={busy}
      pickDirectory={props.pickDirectory} onSettings={save}
      onCreate={input => run(async () => { const result = await mutate(api.create(input)); setInvitation(result.invitation) })}
      onJoin={invitationUrl => run(async () => { await mutate(api.join(invitationUrl)); await refresh() })} />
  } else if (room.role === 'host') {
    body = room.phase === 'authorized'
      ? <RoomView t={t} room={room} api={api} connected={snapshot.connected} busy={busy} open={open}
        onClose={() => run(async () => { await mutate(api.close(room.id)) })} />
      : <InviteCard t={t} room={room} invitation={invitation} busy={busy}
        onApprove={() => run(async () => { await mutate(api.approve(room.id)) })}
        onReject={() => run(async () => { await mutate(api.close(room.id)) })}
        onClose={() => run(async () => { await mutate(api.close(room.id)) })} />
  } else if (room.phase === 'authorized') {
    body = <RoomView t={t} room={room} api={api} connected={snapshot.connected} busy={busy} open={open}
      onClose={() => run(async () => { await mutate(api.close(room.id)) })} />
  } else {
    body = (
      <div className="rr-stage">
        <header className="rr-hero rr-hero-room">
          <div className="rr-herotext"><h1>{room.name ?? t('title')}</h1><p>{room.root ?? ''}</p></div>
          <Pill tone="warning">{t('statusPending')}</Pill>
        </header>
        <Card>
          <p className="rr-body">{t('waitingGuestHint')}</p>
          <Callout>{room.mode === 'read-only' ? t('readOnlyHint') : room.mode === 'danger-full-access' ? t('fullAccessHint') : t('workspaceWriteHint')}</Callout>
        </Card>
        <button type="button" className="rr-btn rr-end" disabled={busy}
          onClick={() => run(async () => { await mutate(api.close(room.id)) })}>{t('endShare')}</button>
      </div>
    )
  }

  return (
    <div className="rr">
      <style>{styles}</style>
      {snapshot.connected ? null : <div className="rr-bannerline" role="status">{t('disconnected')}</div>}
      {snapshot.failure ? <Callout tone="danger">{snapshot.failure.message}</Callout> : null}
      {error ? (
        <div className="rr-errorline" role="alert">
          <strong>{t('errorTitle')}</strong><span>{error.message}</span>
          <button type="button" className="rr-btn" data-variant="ghost" onClick={() => { setError(undefined); void refresh() }}>{t('retry')}</button>
        </div>
      ) : null}
      {body}
    </div>
  )
}
