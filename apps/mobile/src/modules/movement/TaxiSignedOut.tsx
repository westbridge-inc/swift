/** @jsxImportSource react */
import React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space } from '@swift/ui';
import { CircleChip, EmptyState } from '../../kit';

/**
 * [Q4] The taxi door for a visitor with no session — a guest, or someone whose
 * session just ended. Every ride read (active ride, supply, availability,
 * presence, queue) needs an account, so the booking screen behind this door
 * would only poll five endpoints into 401s and look like it was loading
 * forever. Here the visitor is told what taxi needs and gets one way in.
 */
export function TaxiSignedOut({ navigation, onSignIn }: { navigation?: any; onSignIn: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle, paddingTop: insets.top + space['3xl'] }}>
      <View style={{ position: 'absolute', top: insets.top + space.sm, left: space['2xl'] }}>
        <CircleChip icon="chevron-left" label="Go back" onPress={() => navigation?.goBack?.()} />
      </View>
      <EmptyState
        icon="navigation"
        title="Sign in to book a ride"
        body="Your driver needs to know who they are picking up, and your trips stay on your account."
        actionLabel="Sign in"
        onAction={onSignIn}
      />
    </View>
  );
}
