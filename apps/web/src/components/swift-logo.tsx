// The Swift mark — a swift in flight — as a web SVG, matching the mobile
// SwiftMark. Colours and typography come from the canonical token bridge.

export function SwiftMark({
  size = 28,
  tint = 'var(--swift-red)',
  accent = 'var(--swift-red-600)',
}: {
  size?: number;
  tint?: string;
  accent?: string;
}) {
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
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--swift-space-xs)' }}>
      <SwiftMark
        size={mark}
        tint={reversed ? 'var(--swift-white)' : 'var(--swift-red)'}
        accent={reversed ? 'var(--swift-on-brand-muted)' : 'var(--swift-red-600)'}
      />
      <span
        style={{
          color: reversed ? 'var(--swift-white)' : 'var(--swift-red)',
          fontFamily: 'var(--swift-font-display)',
          fontSize: 'var(--swift-type-title)',
          lineHeight: 'var(--swift-leading-title)',
        }}
      >
        Swift
      </span>
    </span>
  );
}
