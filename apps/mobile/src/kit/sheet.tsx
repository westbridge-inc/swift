/** @jsxImportSource react */
import React, { useCallback, useMemo, useRef } from 'react';
import { View, useWindowDimensions } from 'react-native';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { color, radius, space } from '@swift/ui';
import { T } from './text';

/**
 * SHEET — the one bottom sheet.
 *
 * Generalized from `RideSheet`, which was written for the ride flow and read
 * as ride-specific in its name and its defaults, so nothing else adopted it:
 * the taxi and cockpit screens each reached for `@gorhom/bottom-sheet`
 * directly. A primitive nobody can see themselves in is a primitive nobody
 * uses, and three hand-rolled sheets is how three sheet behaviours diverge.
 *
 * Three detents (peek / half / full) with a spring settle, and a height
 * callback so a map camera can pad WITH the sheet instead of hiding content
 * behind it. The sheet is the constant across a whole flow — its content morphs
 * per state, and that continuity is what makes six states feel like one screen.
 *
 * The top radius is `radius.sheet` (28), not the card's 20: a sheet is a
 * surface rising over the screen, and at card radius it reads as a tall card
 * rather than something that came from the bottom edge.
 *
 * The maroon header is OPTIONAL and off by default. Brand at the top of a sheet
 * is a claim that this sheet is a moment — a payment, a confirmed ride — and
 * most sheets are not. Two maroon elements per screen is the law; a header
 * spends one of them.
 */

export type SheetDetent = 'peek' | 'half' | 'full';

const DETENTS: Record<SheetDetent, string> = { peek: '18%', half: '44%', full: '86%' };
const ORDER: SheetDetent[] = ['peek', 'half', 'full'];

export interface SheetProps {
  detents?: SheetDetent[];
  initialDetent?: SheetDetent;
  /** Fired with the detent name AND its pixel height — feed rideCamera.onSheetHeight. */
  onDetentChange?: (detent: SheetDetent, heightPx: number) => void;
  scrollable?: boolean;
  /** Optional brand header. Present = this sheet is the moment on this screen. */
  title?: string;
  /** Sits under the title, in the header's own ink. */
  subtitle?: string;
  children: React.ReactNode;
}

export function Sheet({
  detents = ORDER,
  initialDetent = 'half',
  onDetentChange,
  scrollable = true,
  title,
  subtitle,
  children,
}: SheetProps) {
  const { height: windowH } = useWindowDimensions();
  const sheetRef = useRef<BottomSheet>(null);
  const active = useMemo(() => detents.filter((d) => ORDER.includes(d)), [detents]);
  const snapPoints = useMemo(() => active.map((d) => DETENTS[d]), [active]);
  const initialIndex = Math.max(0, active.indexOf(initialDetent));

  const handleChange = useCallback(
    (index: number) => {
      const detent = active[Math.max(0, Math.min(index, active.length - 1))]!;
      const pct = parseFloat(DETENTS[detent]) / 100;
      onDetentChange?.(detent, Math.round(windowH * pct));
    },
    [active, onDetentChange, windowH],
  );

  const Body = scrollable ? BottomSheetScrollView : React.Fragment;
  const bodyProps = scrollable
    ? { contentContainerStyle: { paddingHorizontal: space['2xl'], paddingBottom: space['3xl'] } }
    : {};

  return (
    <BottomSheet
      ref={sheetRef}
      index={initialIndex}
      snapPoints={snapPoints}
      onChange={handleChange}
      enableDynamicSizing={false}
      backgroundStyle={{
        backgroundColor: title ? color.brand[500] : color.surface.base,
        borderTopLeftRadius: radius.sheet,
        borderTopRightRadius: radius.sheet,
      }}
      // The grab handle has to be visible against whichever ground it sits on.
      handleIndicatorStyle={{ backgroundColor: title ? color.surface.onBrand : color.border.strong, width: 36 }}
    >
      {title ? (
        <View
          accessible
          accessibilityRole="header"
          accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
          style={{ paddingHorizontal: space['2xl'], paddingBottom: space.lg }}
        >
          <T variant="heading" weight="semibold" tone="onBrand">
            {title}
          </T>
          {subtitle ? (
            <T variant="caption" tone="onBrand" style={{ marginTop: 2, opacity: 0.85 }}>
              {subtitle}
            </T>
          ) : null}
        </View>
      ) : null}
      {/* With a brand header the sheet's ground is maroon, so the body carries
          its own paper — content is never asked to read on the brand. */}
      <View style={title ? { flex: 1, backgroundColor: color.surface.base, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, overflow: 'hidden' } : { flex: 1 }}>
        <Body {...(bodyProps as object)}>{children}</Body>
      </View>
    </BottomSheet>
  );
}
