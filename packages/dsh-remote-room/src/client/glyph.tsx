/** Product glyph for the remote-room tab and guide entry: a shared room with an outgoing link. */
export interface RoomGlyphProps { size?: number; className?: string }

export function RoomGlyph({ size = 16, className }: RoomGlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} role="img" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.9" y="3.4" width="8.2" height="9.2" rx="1.9" />
      <path d="M6 8h3.4a1.7 1.7 0 0 1 1.7 1.7v.6a1.7 1.7 0 0 1-1.7 1.7H7.2" />
      <path d="m11.5 4.9 1.9 1.9-1.9 1.9" />
      <path d="M13.4 6.8H9.6" />
    </svg>
  )
}
