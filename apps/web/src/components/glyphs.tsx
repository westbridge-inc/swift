/**
 * [WEB-REDESIGN] The phone app's own drawings, on the web.
 *
 * The vertical pictograms (apps/mobile/src/kit/pictograms.tsx) and the dock's
 * tab glyphs (apps/mobile/src/kit/tab-glyphs.tsx) are drawn with
 * react-native-svg, which the browser cannot load, so their path data is
 * carried here verbatim — the same paths the owner's design file uses. One
 * hand on the 24-grid: 1.8 stroke, round caps and joins, one colour.
 */

const circ = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

const PICTOGRAMS = {
  food: ['M12.6 2.6 C12 3.4 13.1 3.9 12.5 4.8', circ(12, 7.8, 1.15), 'M5.2 15.7 A6.8 6.8 0 0 1 18.8 15.7', 'M3.6 15.7 H20.4', 'M6.2 18.9 H17.8'],
  groceries: ['M9 10 C9 6.2 15 6.2 15 10', 'M3.6 10 H20.4', 'M4.8 10 L6.1 17.9 A1.4 1.4 0 0 0 7.5 19 H16.5 A1.4 1.4 0 0 0 17.9 17.9 L19.2 10', 'M9.4 12.6 L9.9 16.4', 'M12 12.6 V16.4', 'M14.6 12.6 L14.1 16.4'],
  shops: ['M4 8.4 V6.2 H20 V8.4', 'M4 8.4 A2 2 0 0 0 8 8.4 A2 2 0 0 0 12 8.4 A2 2 0 0 0 16 8.4 A2 2 0 0 0 20 8.4', 'M5.4 11.4 V19.4 H18.6 V11.4', 'M13.6 19.4 V14.6 H16.4 V19.4'],
  taxi: ['M10.2 4.2 H13.8 V6.5 H10.2 Z', 'M6.4 11 L7.6 7.8 C7.9 7 8.6 6.5 9.4 6.5 H14.6 C15.4 6.5 16.1 7 16.4 7.8 L17.6 11', 'M4.8 17 V14.2 A3.2 3.2 0 0 1 8 11 H16 A3.2 3.2 0 0 1 19.2 14.2 V17 Z', circ(8.2, 17.4, 1.7), circ(15.8, 17.4, 1.7)],
  wheel: [circ(12, 12, 8.4), circ(12, 12, 2.4), 'M3.6 12 H9.6', 'M14.4 12 H20.4', 'M12 14.4 V20.4'],
  send: ['M9.6 7.2 H20.4 V18 H9.6 Z', 'M15 7.2 V11', 'M2.6 9.8 H6.6', 'M4 12.6 H7.4', 'M2.6 15.4 H6.6'],
  services: ['M14.2 6.9 A4.4 4.4 0 0 0 9 12.1 L4.7 16.4 A2.1 2.1 0 0 0 7.6 19.3 L11.9 15 A4.4 4.4 0 0 0 17.1 9.8 L14.4 12.5 L11.5 9.6 Z'],
  orders: ['M7 4.6 H17 V18.6 L15.33 17.4 L13.67 18.6 L12 17.4 L10.33 18.6 L8.67 17.4 L7 18.6 Z', 'M9.6 8.6 H14.4', 'M9.6 11.6 H13.2'],
  favourites: ['M12 19.2 C7.2 15.9 4.6 13.1 4.6 10.1 A3.9 3.9 0 0 1 12 8.4 A3.9 3.9 0 0 1 19.4 10.1 C19.4 13.1 16.8 15.9 12 19.2 Z'],
  scan: ['M4 8.6 V6 A2 2 0 0 1 6 4 H8.6', 'M15.4 4 H18 A2 2 0 0 1 20 6 V8.6', 'M20 15.4 V18 A2 2 0 0 1 18 20 H15.4', 'M8.6 20 H6 A2 2 0 0 1 4 18 V15.4', 'M9.2 9.2 H11.4 V11.4 H9.2 Z', 'M14.8 9.2 H12.6 V11.4 H14.8 Z', 'M9.2 14.8 H11.4 V12.6 H9.2 Z', 'M12.6 14 H14.8 M13.6 12.6 V14.8'],
  sedan: ['M3.8 15.4 V14.2 C3.8 13.3 4.5 12.6 5.4 12.6 H6.2 L7.6 9.9 C7.9 9.3 8.5 8.9 9.2 8.9 H13.1 C13.6 8.9 14.1 9.1 14.4 9.5 L16.9 12.6 H18.8 C19.7 12.6 20.4 13.3 20.4 14.2 V15.4', 'M11.6 9 V12.5', circ(7.7, 15.7, 1.7), circ(16.3, 15.7, 1.7), 'M9.4 15.6 H14.6'],
  estate: ['M3.8 15.4 V14.2 C3.8 13.3 4.5 12.6 5.4 12.6 H6 L7.2 9.8 C7.5 9.2 8.1 8.8 8.8 8.8 H15.4 C16 8.8 16.6 9.1 16.9 9.7 L18.4 12.6 H18.8 C19.7 12.6 20.4 13.3 20.4 14.2 V15.4', 'M11.2 8.9 V12.5', 'M15.5 8.9 L16.6 12.4', circ(7.7, 15.7, 1.7), circ(16.3, 15.7, 1.7), 'M9.4 15.6 H14.6'],
  van: ['M3.9 15.4 V10.2 C3.9 9.3 4.6 8.6 5.5 8.6 H14.9 C15.6 8.6 16.2 8.9 16.6 9.4 L19.8 13.3 C20.2 13.8 20.4 14.3 20.4 14.9 V15.4', 'M14.7 8.7 L17.7 12.6 H3.9', 'M9.8 8.7 V12.5', circ(7.5, 15.7, 1.7), circ(16.5, 15.7, 1.7), 'M9.2 15.6 H14.8'],
  bus: ['M3.8 15.2 V8.3 C3.8 7.4 4.5 6.7 5.4 6.7 H18.6 C19.5 6.7 20.2 7.4 20.2 8.3 V15.2', 'M3.8 11.4 H20.2', 'M8.8 6.8 V11.3', 'M15.2 6.8 V11.3', circ(7.3, 15.9, 1.7), circ(16.7, 15.9, 1.7), 'M9 15.4 H15'],
} as const;

export type PictogramName = keyof typeof PICTOGRAMS;

export function Pictogram({ name, size = 28, color = 'currentColor' }: { name: PictogramName; size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ display: 'block', flexShrink: 0 }}>
      {PICTOGRAMS[name].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

const TABS = {
  home: { body: ['M4.6 10.4 L12 4.2 L19.4 10.4 V19 A1.4 1.4 0 0 1 18 20.4 H6 A1.4 1.4 0 0 1 4.6 19 Z'], inner: ['M9.8 20.4 V14.6 A1 1 0 0 1 10.8 13.6 H13.2 A1 1 0 0 1 14.2 14.6 V20.4'] },
  activity: { body: ['M7 4.2 H17 V19 L15.33 17.8 L13.67 19 L12 17.8 L10.33 19 L8.67 17.8 L7 19 Z'], inner: ['M9.6 8.4 H14.4', 'M9.6 11.4 H13.2'] },
  market: { body: ['M3.6 8.4 L5.6 4.2 H18.4 L20.4 8.4 Z', 'M5.4 10 H18.6 V19.2 A1.2 1.2 0 0 1 17.4 20.4 H6.6 A1.2 1.2 0 0 1 5.4 19.2 Z'], inner: ['M10.2 20.4 V15.2 A1 1 0 0 1 11.2 14.2 H12.8 A1 1 0 0 1 13.8 15.2 V20.4'] },
  cart: { body: ['M5.6 8.2 H18.4 L17.6 19 A1.6 1.6 0 0 1 16 20.4 H8 A1.6 1.6 0 0 1 6.4 19 Z'], inner: ['M9 10.2 V7.4 A3 3 0 0 1 15 7.4 V10.2'] },
  profile: { body: [circ(12, 8.2, 3.6), 'M4.8 20.4 C5.4 16.6 8.3 14.6 12 14.6 C15.7 14.6 18.6 16.6 19.2 20.4 Z'], inner: [] as string[] },
} as const;

export type TabGlyphName = keyof typeof TABS;

/** A dock/rail glyph: outlined when idle, filled in the tab colour when on. */
export function TabGlyph({ name, on, size = 24 }: { name: TabGlyphName; on: boolean; size?: number }) {
  const glyph = TABS[name];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ display: 'block', flexShrink: 0 }}>
      {glyph.body.map((d) => <path key={d} d={d} fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />)}
      {glyph.inner.map((d) => <path key={d} d={d} fill="none" stroke={on ? 'var(--swift-white)' : 'currentColor'} strokeWidth={1.8} strokeLinecap="round" />)}
    </svg>
  );
}

/** The vertical a store or item belongs to, for its placeholder drawing. */
export function verticalPictogram(vendorType: string | null | undefined): PictogramName {
  switch (vendorType) {
    case 'SUPERMARKET': case 'PHARMACY': return 'groceries';
    case 'STORE': return 'shops';
    case 'SERVICE': return 'services';
    default: return 'food';
  }
}
