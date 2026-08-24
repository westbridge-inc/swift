/** @jsxImportSource react */
import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { color, radius, space } from '@swift/ui';
import { Pictogram, type PictogramName } from './pictograms';

type JourneyTint = { bg: string; ink: string };

/**
 * A compact A→B rail for paired journey controls. The endpoints inherit the
 * vertical identity while the dashed leg stays on the neutral border token, so
 * the same piece can serve Send today and a taxi destination review later.
 */
export function JourneyRail({
  start,
  end,
  pictogram,
  tint,
  style,
}: {
  start: React.ReactNode;
  end: React.ReactNode;
  pictogram: PictogramName;
  tint: JourneyTint;
  style?: ViewStyle;
}) {
  const railWidth = space['3xl'];
  const iconSize = space['3xl'];
  const line = {
    position: 'absolute',
    left: railWidth / 2,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    borderColor: color.border.strong,
  } as const;
  const decorative = {
    accessible: false,
    accessibilityElementsHidden: true,
    focusable: false,
    importantForAccessibility: 'no-hide-descendants' as const,
    pointerEvents: 'none' as const,
  };
  const dot = {
    width: space.sm,
    height: space.sm,
    borderRadius: radius.full,
    backgroundColor: tint.ink,
  } as const;

  return (
    <View style={style}>
      <View
        style={{ flexDirection: 'row', gap: space.md }}
      >
        <View
          {...decorative}
          style={{ width: railWidth, alignItems: 'center', justifyContent: 'center' }}
        >
          <View style={[line, { top: '50%', bottom: 0 }]} />
          <View style={dot} />
        </View>
        <View style={{ flex: 1 }}>{start}</View>
      </View>
      <View style={{ flexDirection: 'row', gap: space.md, height: space.md, zIndex: 1 }}>
        <View
          {...decorative}
          style={{ width: railWidth, alignItems: 'center', justifyContent: 'center' }}
        >
          <View style={[line, { top: 0, bottom: 0 }]} />
          <View
            style={{
              width: iconSize,
              height: iconSize,
              borderRadius: radius.md,
              backgroundColor: tint.bg,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Pictogram name={pictogram} size={20} color={tint.ink} />
          </View>
        </View>
        <View style={{ flex: 1 }} />
      </View>
      <View style={{ flexDirection: 'row', gap: space.md }}>
        <View
          {...decorative}
          style={{ width: railWidth, alignItems: 'center', justifyContent: 'center' }}
        >
          <View style={[line, { top: 0, bottom: '50%' }]} />
          <View style={dot} />
        </View>
        <View style={{ flex: 1 }}>{end}</View>
      </View>
    </View>
  );
}
