/** @jsxImportSource react */
import React, { useState } from 'react';
import { View } from 'react-native';
import { space } from '@swift/ui';
import { ErrorState, LinkText, Screen, useLogoutConfirm } from '../../kit';
import { RoleSwitcherSheet } from '../../components/RoleSwitcherSheet';
import { LOGOUT_NOTHING_IN_HAND } from '../../lib/moverLogoutWords';

/**
 * [BUG-HUNT F11] No answer from the server is not "you have not signed up". With no signal a working rider used to see
 * "Start earning with Swift" and the vehicle form; the store side fixed this class in MOB-038 (VendorStack). Like there,
 * `intent` persists, so a cold start reopens this screen, and Switch app and Log out are the ways back out. With no
 * answer nothing is known about a job in hand, so the box stays the plain one.
 */
export function MoverNoAnswer({ onRetry }: { onRetry: () => void }) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const { requestLogout, logoutDialog } = useLogoutConfirm({ body: LOGOUT_NOTHING_IN_HAND });
  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: space.lg, paddingHorizontal: space['2xl'], height: 56 }}>
        <LinkText label="Switch app" onPress={() => setSwitcherOpen(true)} />
        <LinkText label="Log out" tone="muted" onPress={requestLogout} />
      </View>
      <ErrorState message="Swift can’t reach your account right now. Your jobs and earnings are safe: try again in a moment." onRetry={onRetry} />
      <RoleSwitcherSheet visible={switcherOpen} current="mover" onClose={() => setSwitcherOpen(false)} />
      {logoutDialog}
    </Screen>
  );
}
