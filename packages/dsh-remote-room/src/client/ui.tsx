/** Small presentation atoms shared by the share flow; every visible string is passed in. */
import type { ReactNode } from 'react'
import type { Failure } from './contracts.ts'
import type { Translate } from './locale.ts'

export function ErrorNotice({ error, t }: { error: Failure; t: Translate }): JSX.Element {
  return <div className="rr-errorline" role="alert"><strong>{t('errorTitle')}</strong><span>{error.message}</span></div>
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger'

export function Card({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <section className={className ? `rr-card ${className}` : 'rr-card'}>{children}</section>
}

export function CardHead({ title, accessory }: { title: ReactNode; accessory?: ReactNode }): JSX.Element {
  return <div className="rr-cardhead"><h2>{title}</h2>{accessory}</div>
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): JSX.Element {
  return (
    <label className="rr-field">
      <span className="rr-fieldlabel">{label}</span>
      {children}
      {hint ? <span className="rr-fieldhint">{hint}</span> : null}
    </label>
  )
}

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }): JSX.Element {
  return <span className="rr-pill" data-tone={tone}>{children}</span>
}

export function Callout({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }): JSX.Element {
  return <p className="rr-callout" data-tone={tone} role={tone === 'danger' ? 'alert' : undefined}>{children}</p>
}

export function Spinner({ label }: { label: string }): JSX.Element {
  return <span className="rr-spinner" role="status" aria-label={label} />
}

export function Empty({ title, hint }: { title: string; hint?: string }): JSX.Element {
  return <div className="rr-empty"><strong>{title}</strong>{hint ? <span>{hint}</span> : null}</div>
}
