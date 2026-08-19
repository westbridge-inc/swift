/** @jsxImportSource react */
import React from 'react';
import { Linking, View, type ViewStyle } from 'react-native';
import { space } from '@swift/ui';
import type { LocationStatus } from '../lib/deviceLocation';
import { Card, IconChip, PillButton, T } from '../kit';

/**
 * The foreground-location primer [first-open SO-5 / rides S-96]. It never
 * blocks the route card below it: search, saved places and pin-drop remain the
 * equal fallback when permission is declined.
 */
export function LocationPrimerCard({
  status,
  onRequest,
  style,
}: {
  status: LocationStatus;
  onRequest: () => void;
  style?: ViewStyle;
}) {
  if (status === 'granted') return null;

  const denied = status === 'denied';
  const unavailable = status === 'unavailable';
  const actionLabel = denied ? 'Open settings' : unavailable ? 'Try location again' : 'Use my location';

  return (
    <Card style={{ gap: space.md, ...(style as object) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <IconChip icon="crosshair" />
        <View style={{ flex: 1 }}>
          <T variant="bodyStrong">Set pickup faster</T>
          <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
            {denied
              ? 'Turn on location to set your pickup automatically — or drop a pin.'
              : 'Use your location to set your pickup automatically — or drop a pin.'}
          </T>
        </View>
      </View>
      <PillButton
        label={actionLabel}
        icon={denied ? 'settings' : 'navigation'}
        variant="soft"
        size="md"
        loading={status === 'resolving'}
        onPress={() => {
          if (denied) void Linking.openSettings();
          else onRequest();
        }}
      />
    </Card>
  );
}
