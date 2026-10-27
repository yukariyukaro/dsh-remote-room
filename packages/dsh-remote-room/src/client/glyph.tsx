/** Product glyph for the remote-room tab and guide entry: a workspace delivered into a room. */
export interface RoomGlyphProps { size?: number; className?: string }

export function RoomGlyph({ size = 16, className }: RoomGlyphProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} role="img" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.4" y="2.6" width="7.2" height="10.8" rx="1.9" />
      <path d="M14 8H11.2" />
      <path d="m12.7 6.4-1.5 1.6 1.5 1.6" />
    </svg>
  )
}
