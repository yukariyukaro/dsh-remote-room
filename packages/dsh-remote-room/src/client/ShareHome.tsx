/** First screen: pick one folder, choose what the guest may do, get an invitation. */
import { useState } from 'react'
import type { RoomMode, ShareScope, ShareSettingsView, SettingsPatch } from './contracts.ts'
import type { Translate } from './locale.ts'
import { Callout, Card, CardHead, Field } from './ui.tsx'
import {
  IconFolderOpenOutlineRegular, IconLinkOutlineRegular, IconShareOutlineRegular, IconGlobeOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'

const MODES: readonly RoomMode[] = ['read-only', 'workspace-write', 'danger-full-access']
const SCOPES: readonly ShareScope[] = ['public', 'lan']

export interface ShareHomeProps {
  t: Translate
  initialRoot: string
  settings?: ShareSettingsView
  busy: boolean
  pickDirectory?: () => Promise<string | null>
  onCreate(input: { root: string; mode: RoomMode; scope: ShareScope }): void
  onJoin(invitation: string): void
  onSettings(patch: SettingsPatch): void
}

export function ShareHome({ t, initialRoot, settings, busy, pickDirectory, onCreate, onJoin, onSettings }: ShareHomeProps): JSX.Element {
  const [root, setRoot] = useState(initialRoot)
  const [mode, setMode] = useState<RoomMode>('workspace-write')
  const [scope, setScope] = useState<ShareScope>(settings?.scope ?? 'public')
  const [relay, setRelay] = useState(settings?.relayUrl || settings?.defaultRelay || '')
  const [manual, setManual] = useState(initialRoot === '')
  const [joining, setJoining] = useState(false)
  const [invitation, setInvitation] = useState('')
  const [picking, setPicking] = useState(false)
  const [editingRelay, setEditingRelay] = useState(relay === '')
  const [pickerNote, setPickerNote] = useState('')
  // The host is enough to recognise a deployment; the full URL stays behind the edit affordance.
  const relayHost = ((): string => { try { return new URL(relay).host } catch { return relay } })()

  /** Always answers: a click must never look dead, even when no OS chooser is reachable. */
  const choose = (): void => {
    setPickerNote('')
    setManual(value => !value)
  }
  const browse = (): void => {
    if (!pickDirectory) { setManual(true); setPickerNote(t('pickerUnavailable')); return }
    setPicking(true); setPickerNote('')
    void pickDirectory().then(
      found => { if (found) { setRoot(found); onSettings({ lastRoot: found }) } else { setManual(true); setPickerNote(t('pickerUnavailable')) } },
      () => { setManual(true); setPickerNote(t('pickerUnavailable')) },
    ).finally(() => setPicking(false))
  }
  const hint = mode === 'read-only' ? t('readOnlyHint') : mode === 'workspace-write' ? t('workspaceWriteHint') : t('fullAccessHint')
  const scopeHint = scope === 'lan' ? t('scopeHintLan') : t('scopeHintPublic')
  const relayMissing = scope === 'public' && relay.trim() === ''

  return (
    <div className="rr-stage">
      <header className="rr-hero">
        <h1>{t('shareHeading')}</h1>
        <p>{t('shareLede')}</p>
      </header>

      <Card>
        <CardHead title={t('directory')} accessory={
          <div className="rr-actions">
            {pickDirectory
              ? <button type="button" className="rr-btn" data-variant="ghost" disabled={busy || picking} onClick={browse}>
                <IconFolderOpenOutlineRegular size={16} />{picking ? t('preparing') : t('browse')}
              </button>
              : null}
            <button type="button" className="rr-btn" data-variant="ghost" disabled={busy} aria-expanded={manual} onClick={choose}>
              {manual ? t('collapse') : t('change')}
            </button>
          </div>
        } />
        {pickerNote ? <p className="rr-hint" role="status">{pickerNote}</p> : null}
        {manual
          ? <input className="rr-input rr-mono" value={root} placeholder={t('pathPlaceholder')} spellCheck={false} autoComplete="off"
            onChange={event => setRoot(event.target.value)} onBlur={() => { if (root.trim() !== '') onSettings({ lastRoot: root.trim() }) }} />
          : <p className="rr-path" data-empty={root === ''}>{root === '' ? t('noDirectory') : root}</p>}
        <button type="button" className="rr-link" onClick={() => setManual(value => !value)}>{t('manualPath')}</button>
        {manual ? <p className="rr-hint">{t('manualPathHint')}</p> : null}
      </Card>

      <Card>
        <CardHead title={t('permission')} />
        <div className="rr-choice" role="radiogroup" aria-label={t('permission')}>
          {MODES.map(value => (
            <button key={value} type="button" role="radio" aria-checked={mode === value} className="rr-option"
              data-active={mode === value} data-danger={value === 'danger-full-access'} onClick={() => setMode(value)}>
              {value === 'read-only' ? t('readOnly') : value === 'workspace-write' ? t('workspaceWrite') : t('fullAccess')}
            </button>
          ))}
        </div>
        <Callout tone={mode === 'danger-full-access' ? 'danger' : 'neutral'}>{hint}</Callout>
      </Card>

      <Card>
        <CardHead title={t('scopeLabel')} />
        <div className="rr-choice" role="radiogroup" aria-label={t('scopeLabel')}>
          {SCOPES.map(value => (
            <button key={value} type="button" role="radio" aria-checked={scope === value} className="rr-option"
              data-active={scope === value} onClick={() => { setScope(value); onSettings({ scope: value }) }}>
              {value === 'lan' ? t('scopeLan') : t('scopePublic')}
            </button>
          ))}
        </div>
        <Callout tone="neutral">{scopeHint}</Callout>
        {scope === 'public'
          ? relay !== '' && !editingRelay
            ? <div className="rr-summary">
              <IconGlobeOutlineRegular size={14} />
              <span className="rr-summary-label">{t('relayLabel')}</span>
              <code className="rr-summary-value" title={relay}>{relayHost}</code>
              <button type="button" className="rr-link" onClick={() => setEditingRelay(true)}>{t('change')}</button>
            </div>
            : <Field label={t('relayLabel')} hint={relayMissing ? t('relayMissingHint') : t('relayHint')}>
              <div className="rr-inline">
                <input className="rr-input rr-mono" value={relay} placeholder={t('relayPlaceholder')} spellCheck={false} autoComplete="off"
                  aria-label={t('relayLabel')} onChange={event => setRelay(event.target.value)} onBlur={() => onSettings({ relayUrl: relay.trim() })} />
                <button type="button" className="rr-btn" onClick={() => { onSettings({ relayUrl: relay.trim() }); setEditingRelay(false) }}>{t('saveRelay')}</button>
              </div>
            </Field>
          : null}
      </Card>

      <button type="button" className="rr-primary" disabled={busy || root.trim() === '' || (scope === 'public' && relay.trim() === '')}
        onClick={() => onCreate({ root: root.trim(), mode, scope, ...(scope === 'public' ? { relay: relay.trim() } : {}) })}>
        <IconShareOutlineRegular size={18} />{busy ? t('preparing') : t('startShare')}
      </button>
      <p className="rr-hint rr-center">{t('shareNote')}</p>

      <Card className="rr-join">
        <CardHead title={t('joinHeading')} accessory={
          <button type="button" className="rr-btn" data-variant="ghost" onClick={() => setJoining(value => !value)} aria-expanded={joining}>
            <IconLinkOutlineRegular size={16} />{joining ? t('change') : t('joinAction')}
          </button>
        } />
        {joining
          ? <>
            <textarea className="rr-input rr-mono rr-invite" value={invitation} placeholder={t('invitationPlaceholder')} spellCheck={false}
              onChange={event => setInvitation(event.target.value)} rows={3} />
            <div className="rr-inline rr-end">
              <button type="button" className="rr-btn" disabled={invitation.trim() === ''} onClick={() => onJoin(invitation.trim())}>{t('join')}</button>
            </div>
            <p className="rr-hint">{t('joinHint')}</p>
          </>
          : <p className="rr-hint">{t('joinHint')}</p>}
      </Card>

      <footer className="rr-foot"><IconGlobeOutlineRegular size={14} />{t('scopeFootnote')}</footer>
    </div>
  )
}
