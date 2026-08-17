/** @jsxImportSource react */
import React from 'react';
import { View } from 'react-native';
import { space } from '@swift/ui';
import { IconChip, PillButton, PopupCard, PopupTitle, T } from '../../kit';
import { useAuthStore } from '../../stores/authStore';
import { logoutAndSwitchExperience } from './advertiserExit';

export function AdvertiserExitDialog({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const setIntent = useAuthStore((state) => state.setIntent);
  const logout = useAuthStore((state) => state.logout);

  return (
    <PopupCard visible={visible} onClose={onClose}>
      <View style={{ alignSelf: 'stretch', alignItems: 'center' }}>
        <IconChip icon="log-out" size={56} />
        <PopupTitle variant="heading" center style={{ marginTop: space.md }}>
          Switch away from advertising?
        </PopupTitle>
        <T variant="label" tone="muted" center style={{ marginTop: space.sm }}>
          You&apos;ll log out on this device and return to Swift&apos;s experience picker. Your campaigns, team, and
          billing history stay saved.
        </T>
        <View style={{ alignSelf: 'stretch', gap: space.md, marginTop: space.xl }}>
          <PillButton
            label="Log out and switch experience"
            icon="log-out"
            size="md"
            onPress={() => {
              onClose();
              logoutAndSwitchExperience({ setIntent, logout });
            }}
          />
          <PillButton label="Stay in advertising" variant="soft" size="md" onPress={onClose} />
        </View>
      </View>
    </PopupCard>
  );
}
