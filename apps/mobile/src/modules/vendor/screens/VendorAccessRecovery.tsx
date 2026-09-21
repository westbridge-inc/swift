/** @jsxImportSource react */
import React from 'react';
import { View } from 'react-native';
import { space } from '@swift/ui';
import { IconChip, LinkText, PillButton, Screen, T } from '../../../kit';

type Props = {
  onRetry: () => void;
  onOpenSwift: () => void;
  onChooseExperience: () => void;
  onSignOut: () => void;
};

/**
 * A revoked or stale business membership is an authorization boundary, not a
 * dead end. The server still refuses the store; this screen only gives the
 * person safe ways out of the business shell.
 */
export function VendorAccessRecovery({ onRetry, onOpenSwift, onChooseExperience, onSignOut }: Props) {
  return (
    <Screen>
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: space['3xl'],
          gap: space.md,
        }}
      >
        <IconChip icon="shield" size={72} tone="error" />
        <T variant="heading" center style={{ marginTop: space.sm }}>
          This business isn’t available
        </T>
        <T variant="label" tone="muted" center style={{ maxWidth: 300 }}>
          Your account no longer has access to this store. Its orders and data remain protected.
        </T>
        <PillButton
          label="Open Swift"
          onPress={onOpenSwift}
          size="md"
          style={{ marginTop: space.md }}
        />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xl, marginTop: space.sm }}>
          <LinkText label="Try store again" onPress={onRetry} tone="muted" />
        </View>
        <LinkText label="Choose another experience" onPress={onChooseExperience} tone="muted" />
        <LinkText label="Sign out" onPress={onSignOut} tone="muted" />
      </View>
    </Screen>
  );
}
