/** Waiting screen: the invitation and the one decision the owner makes. */
import { useState } from 'react'
import type { RoomSnapshot } from './contracts.ts'
import type { Translate } from './locale.ts'
import { Callout, Card, CardHead, Pill } from './ui.tsx'
import { IconCopyOutlineRegular, IconCheckCircleOutlineRegular, IconWarningTriangleOutlineRegular, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

export interface InviteCardProps {
  t: Translate
  room: RoomSnapshot
  invitation: string
  busy: boolean
  onApprove(): void
  onReject(): void
  onClose(): void
}

export function InviteCard({ t, room, invitation, busy, onApprove, onReject, onClose }: InviteCardProps): JSX.Element {
  const [copied, setCopied] = useState(false)
  const waiting = room.phase === 'pending'
  const copy = (): void => {
    if (!navigator.clipboard) return
    void navigator.clipboard.writeText(invitation).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    }, () => {})
  }
  return (
    <div className="rr-stage">
      <header className="rr-hero rr-hero-room">
        <div className="rr-herotext">
          <h1>{room.name ?? t('title')}</h1>
          <p>{t('host')} · {room.root}</p>
        </div>
        <Pill tone={waiting ? 'warning' : 'neutral'}>{waiting ? t('statusPending') : t('statusConnecting')}</Pill>
      </header>

      {waiting
        ? <Card className="rr-request">
          <CardHead title={t('requestTitle')} accessory={<IconWarningTriangleOutlineRegular size={18} />} />
          <p className="rr-body">{t('requestHint')}</p>
          <Callout>{room.mode === 'read-only' ? t('readOnlyHint') : room.mode === 'danger-full-access' ? t('fullAccessHint') : t('workspaceWriteHint')}</Callout>
          <div className="rr-actions">
            <button type="button" className="rr-btn" data-variant="primary" disabled={busy} onClick={onApprove}>
              <IconCheckCircleOutlineRegular size={16} />{t('approve')}
            </button>
            <button type="button" className="rr-btn" disabled={busy} onClick={onReject}>{t('reject')}</button>
          </div>
        </Card>
        : <Card>
          <CardHead title={t('waitingTitle')} />
          <p className="rr-body">{t('waitingHint')}</p>
          <div className="rr-invitebox">
            <textarea className="rr-invite rr-mono" readOnly rows={3} value={invitation} onFocus={event => event.currentTarget.select()} aria-label={t('invitation')} />
            <button type="button" className="rr-btn" onClick={copy}>
              <IconCopyOutlineRegular size={16} />{copied ? t('copied') : t('copy')}
            </button>
          </div>
          <span className="rr-sr" role="status" aria-live="polite">{copied ? t('copyAnnounce') : ''}</span>
        </Card>}

      <button type="button" className="rr-btn rr-end" disabled={busy} onClick={onClose}>
        <IconCloseOutlineRegular size={16} />{t('endShare')}
      </button>
    </div>
  )
}
