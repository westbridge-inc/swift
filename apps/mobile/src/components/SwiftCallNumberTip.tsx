import React from 'react';
import { View } from 'react-native';
import { space } from '@swift/ui';
import { T } from '../kit';
import { useCallConfig } from '../hooks/useCallParty';
import { saveNumberTip } from '../lib/callBridge';

/**
 * [O-1 · owner 24 Oct] "Save Swift's call number": Guyana phones show only a number for an incoming
 * call, so a call from Swift is easier to answer once the number is saved. Shown only while calls go
 * through Swift; renders nothing while the bridge is off (the launch state). The number is selectable
 * (long-press to copy): the app adds no clipboard or contacts module (no native change).
 */
export function SwiftCallNumberTip() {
  const config = useCallConfig();
  const tip = config?.enabled ? saveNumberTip(config.callerId) : null;
  if (!tip) return null;
  return (
    <View style={{ marginTop: space.sm }}>
      <T variant="label" tone="muted" selectable accessibilityRole="text">
        {tip}
      </T>
    </View>
  );
}
