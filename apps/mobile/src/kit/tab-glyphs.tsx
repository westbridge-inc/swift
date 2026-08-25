/** @jsxImportSource react */
import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';
import { color as tokenColor } from '@swift/ui';

/**
 * The tab bar's four glyphs, drawn by the pictogram hand (24-grid, 1.8
 * stroke): outline at rest, FILLED when active — the icon law's one filled
 * exception (9.6). The Activity glyph is the orders receipt; the whole bar
 * finally speaks the same language as the service rail.
 */
// 'activity' is KEPT even though the customer tab bar no longer uses it — the
// glyph is not deleted (FG-2) and other surfaces may still want it.
export type TabGlyphName = 'home' | 'activity' | 'market' | 'cart' | 'profile';

const S = { strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export function TabGlyph({
  name,
  focused,
  color,
  size = 24,
}: {
  name: TabGlyphName;
  focused: boolean;
  color: string;
  size?: number;
}) {
  const paint = focused
    ? { fill: color, stroke: color, ...S }
    : { fill: 'none', stroke: color, ...S };

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === 'home' && (
        <>
          <Path
            {...paint}
            d="M4.6 10.4 L12 4.2 L19.4 10.4 V19 A1.4 1.4 0 0 1 18 20.4 H6 A1.4 1.4 0 0 1 4.6 19 Z"
          />
          {focused ? (
            <Path d="M9.8 20.4 V14.6 A1 1 0 0 1 10.8 13.6 H13.2 A1 1 0 0 1 14.2 14.6 V20.4" fill="none" stroke={tokenColor.white} strokeWidth={1.8} strokeLinecap="round" />
          ) : (
            <Path d="M9.8 20.4 V14.6 A1 1 0 0 1 10.8 13.6 H13.2 A1 1 0 0 1 14.2 14.6 V20.4" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
          )}
        </>
      )}
      {name === 'activity' && (
        <>
          <Path
            {...paint}
            d="M7 4.2 H17 V19 L15.33 17.8 L13.67 19 L12 17.8 L10.33 19 L8.67 17.8 L7 19 Z"
          />
          <Path d="M9.6 8.4 H14.4" fill="none" stroke={focused ? tokenColor.white : color} strokeWidth={1.8} strokeLinecap="round" />
          <Path d="M9.6 11.4 H13.2" fill="none" stroke={focused ? tokenColor.white : color} strokeWidth={1.8} strokeLinecap="round" />
        </>
      )}
      {/* MARKET [MKT-2] — a storefront: an awning, a body, a doorway.
          First attempt drew the awning as a thin stroke over a filled body, and
          at 25px focused it collapsed into a maroon blob — the stroke had
          nothing to sit against. So the awning is its own SHAPE above the body
          with a gap between them, and the doorway is a cutout, which is what
          makes it read as a shop rather than a box at tab size. */}
      {name === 'market' && (
        <>
          {/* awning */}
          <Path {...paint} d="M3.6 8.4 L5.6 4.2 H18.4 L20.4 8.4 Z" />
          {/* body */}
          <Path {...paint} d="M5.4 10 H18.6 V19.2 A1.2 1.2 0 0 1 17.4 20.4 H6.6 A1.2 1.2 0 0 1 5.4 19.2 Z" />
          {/* doorway — reversed out when focused, drawn in when not */}
          <Path
            d="M10.2 20.4 V15.2 A1 1 0 0 1 11.2 14.2 H12.8 A1 1 0 0 1 13.8 15.2 V20.4"
            fill="none"
            stroke={focused ? tokenColor.white : color}
            strokeWidth={1.8}
            strokeLinecap="round"
          />
        </>
      )}
      {name === 'cart' && (
        <>
          <Path
            {...paint}
            d="M5.6 8.2 H18.4 L17.6 19 A1.6 1.6 0 0 1 16 20.4 H8 A1.6 1.6 0 0 1 6.4 19 Z"
          />
          <Path d="M9 10.2 V7.4 A3 3 0 0 1 15 7.4 V10.2" fill="none" stroke={focused ? tokenColor.white : color} strokeWidth={1.8} strokeLinecap="round" />
        </>
      )}
      {name === 'profile' && (
        <>
          <Circle cx={12} cy={8.2} r={3.6} {...paint} />
          <Path
            {...paint}
            d="M4.8 20.4 C5.4 16.6 8.3 14.6 12 14.6 C15.7 14.6 18.6 16.6 19.2 20.4 Z"
          />
        </>
      )}
    </Svg>
  );
}
