/** @jsxImportSource react */
import React from 'react';
import Svg, { Path } from 'react-native-svg';

/**
 * The two filled/outline glyphs the one-icon-family rule can't get from
 * Feather (stroke-only font): rating stars and the favourite heart. Drawn on
 * the same 24-grid / 1.8-stroke language as the pictogram set, so ratings and
 * favourites read as the same hand.
 */
const STAR = 'M12 3.2 L14.7 8.9 L20.9 9.7 L16.4 14 L17.5 20.2 L12 17.2 L6.5 20.2 L7.6 14 L3.1 9.7 L9.3 8.9 Z';
const HEART =
  'M12 19.2 C7.2 15.9 4.6 13.1 4.6 10.1 A3.9 3.9 0 0 1 12 8.4 A3.9 3.9 0 0 1 19.4 10.1 C19.4 13.1 16.8 15.9 12 19.2 Z';

function Glyph({ d, size, color, filled }: { d: string; size: number; color: string; filled: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d={d}
        fill={filled ? color : 'none'}
        stroke={color}
        strokeWidth={filled ? 0 : 1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function StarGlyph({ size = 14, color, filled = true }: { size?: number; color: string; filled?: boolean }) {
  return <Glyph d={STAR} size={size} color={color} filled={filled} />;
}

export function HeartGlyph({ size = 18, color, filled = false }: { size?: number; color: string; filled?: boolean }) {
  return <Glyph d={HEART} size={size} color={color} filled={filled} />;
}
