import React, { useCallback, useMemo, useRef } from 'react';
import { useWindowDimensions } from 'react-native';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { color, radius, space } from '@swift/ui';

// The ONE ride sheet [rides spec 3.4]: three detents (peek / half / full),
// spring settle, and a height callback so the map camera pads WITH the sheet
// and content never hides behind it. The sheet is the constant across the
// whole ride flow — its content morphs per state; that continuity is what
// makes six states feel like one experience.

export type RideDetent = 'peek' | 'half' | 'full';
const DETENTS: Record<RideDetent, string> = { peek: '18%', half: '44%', full: '86%' };
const ORDER: RideDetent[] = ['peek', 'half', 'full'];

export interface RideSheetProps {
  detents?: RideDetent[];
  initialDetent?: RideDetent;
  /** Fired with the detent name AND its pixel height — feed rideCamera.onSheetHeight. */
  onDetentChange?: (detent: RideDetent, heightPx: number) => void;
  scrollable?: boolean;
  children: React.ReactNode;
}

export function RideSheet({ detents = ORDER, initialDetent = 'half', onDetentChange, scrollable = true, children }: RideSheetProps) {
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
      backgroundStyle={{ backgroundColor: color.surface.base, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl }}
      handleIndicatorStyle={{ backgroundColor: color.border.strong, width: 36 }}
    >
      <Body {...(bodyProps as object)}>{children}</Body>
    </BottomSheet>
  );
}
