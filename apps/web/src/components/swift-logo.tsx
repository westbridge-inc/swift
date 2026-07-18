// The Swift mark — a swift in flight — as a web SVG, matching the mobile
// SwiftMark (apps/mobile/src/components/SwiftLogo.tsx) with the real brand
// colours (#803B3B / #5C2A2C). Use the logo, never a bare "Swift" string.

export function SwiftMark({ size = 28, tint = '#803B3B', accent = '#5C2A2C' }: { size?: number; tint?: string; accent?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <g transform="translate(-1.5,-6)">
        <path d="M97 20 C76 30 60 40 50 52 C44 44 30 36 6 36 C26 42 38 52 44 64 C40 74 34 82 28 92 C42 80 50 70 54 60 C62 56 76 46 97 20 Z" fill={tint} />
        <path d="M50 52 C62 56 76 46 97 20 C76 30 60 40 50 52 Z" fill={accent} />
      </g>
    </svg>
  );
}

/** Mark + wordmark lockup. `reversed` = white, for use on the brand-red surface. */
export function SwiftLogo({ mark = 26, reversed = false, className = '' }: { mark?: number; reversed?: boolean; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <SwiftMark size={mark} tint={reversed ? '#ffffff' : '#803B3B'} accent={reversed ? 'rgba(255,255,255,0.65)' : '#5C2A2C'} />
      <span className="text-xl font-extrabold tracking-tight" style={{ color: reversed ? '#ffffff' : 'var(--swift-red)' }}>Swift</span>
    </span>
  );
}
