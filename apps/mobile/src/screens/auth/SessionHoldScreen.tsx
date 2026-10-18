import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, space } from '@swift/ui';
import { SwiftMark } from '../../components/SwiftLogo';
import { PillButton, T, useLogoutConfirm } from '../../kit';

/**
 * [MOB-007 · owner ruling 16 Oct 2026] The hold a signed-in CUSTOMER sees if the
 * session ever carries no account (the store's hydration law says it never
 * should). It never opens the app and never asks for anything but a fresh
 * sign-in: customers take no photos, so this is not the camera screen earners
 * hold on. "Sign out" is the way back.
 */
export function SessionHoldScreen() {
  const { requestLogout, logoutDialog } = useLogoutConfirm({
    title: 'Sign out of Swift?',
    body: 'Your account stays — sign back in to continue.',
    confirmLabel: 'Sign out',
  });

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.surface.base }} edges={['top', 'bottom']}>
      <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: space.lg }}>
        <View style={{ marginBottom: space.sm, alignItems: 'center' }}><SwiftMark size={34} /></View>
        <T variant="title" center>We couldn’t load your account</T>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm }}>
          To continue, sign out and sign back in.
        </T>
        <PillButton label="Sign out" onPress={requestLogout} style={{ marginTop: space.lg }} />
      </View>
      {logoutDialog}
    </SafeAreaView>
  );
}
