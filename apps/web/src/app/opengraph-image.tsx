import { ImageResponse } from 'next/og';
import { launch } from '@/site.config';
import { brandPalette } from '@/lib/design-tokens';

/**
 * [SITE-1.1 Part 5] The link preview card.
 *
 * Generated rather than shipped as a file: it is drawn from the same brand
 * tokens as the site and from the launch config, so it can never advertise a
 * market Swift does not serve. No external asset, no font download, no
 * dependency — which also means it cannot break the build.
 *
 * Deliberately quiet: the Indian Red ground, the wordmark, one true sentence.
 * A preview card that tries to sell is the tell of a template.
 */

export const alt = 'Swift — food, groceries, shops, couriers and rides';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Read from the token source, never re-typed. The UI barrier enforces this:
// a literal brand hex outside packages/ui is how a third design system starts.
const { brand: BRAND, brandDeep: BRAND_DEEP, paper: PAPER, blush: BLUSH } = brandPalette;

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: `linear-gradient(135deg, ${BRAND} 0%, ${BRAND_DEEP} 100%)`,
          padding: '72px 80px',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          {/* The Swift bird, inline — the same path the site's logo uses. */}
          <svg width="64" height="64" viewBox="0 0 100 100" fill="none">
            <path
              d="M97 20 C76 30 60 40 50 52 C44 44 30 36 6 36 C26 42 38 52 44 64 C40 74 34 82 28 92 C42 80 50 70 54 60 C62 56 76 46 97 20 Z"
              fill={PAPER}
            />
            <path d="M50 52 C62 56 76 46 97 20 C76 30 60 40 50 52 Z" fill={BLUSH} />
          </svg>
          <span style={{ fontSize: 52, fontWeight: 800, color: PAPER, letterSpacing: '-0.02em' }}>
            Swift
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span
            style={{
              fontSize: 68,
              fontWeight: 800,
              color: PAPER,
              lineHeight: 1.08,
              letterSpacing: '-0.03em',
              maxWidth: 940,
            }}
          >
            Everything your day needs. One app. Zero commission.
          </span>
          <span style={{ fontSize: 30, color: BLUSH, marginTop: 26 }}>
            Food · groceries · shops · parcels · rides · trades — {launch.markets[0]}
          </span>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <span style={{ fontSize: 26, color: BLUSH }}>swiftgy.com</span>
          <span style={{ fontSize: 26, color: BLUSH }}>
            Businesses and movers keep 100%
          </span>
        </div>
      </div>
    ),
    size,
  );
}
