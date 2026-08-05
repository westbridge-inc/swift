/** @jsxImportSource react */
import React from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { LoadingBlock, Screen, T } from '../../kit';
import { ChatScreen } from '../../screens/shared/ChatScreen';
import { useVerificationStatus } from '../../hooks';
import { useMoverPreview } from '../../stores/moverPreview';
import { useAuthStore } from '../../stores/authStore';
import { useWentLive, WentLivePopup } from '../../components/onboarding/WentLive';
import { MoverHomeScreen } from './screens/MoverHomeScreen';
import { ActiveJobScreen } from './screens/ActiveJobScreen';
import { EarningsScreen } from './screens/EarningsScreen';
import { JobHistoryScreen } from './screens/JobHistoryScreen';
import { MoverAccountScreen } from './screens/MoverAccountScreen';
import { MoverDocumentsScreen } from './screens/MoverDocumentsScreen';
import { MoverSwiftNumberScreen } from './screens/MoverSwiftNumberScreen';
import { MoverOnboardingScreen } from './screens/MoverOnboardingScreen';

const Stack = createNativeStackNavigator();

// Verified movers land in the map-first ops home; unverified see onboarding.
// Polling means an admin approval flips this screen within seconds — and the
// flip itself gets its moment (the went-live popup), Uber-style.
function MoverRoot({ navigation }: any) {
  const preview = useMoverPreview((s) => s.preview);
  const { data: status, isLoading } = useVerificationStatus<any>('MOVER', undefined, { poll: true });
  const live = useWentLive(preview ? undefined : status ? !!status.roleVerified : undefined);

  // Preview (R3): a prospective mover lands straight on the REAL dashboard home
  // fed sample data — no verification gate, no onboarding, no went-live popup.
  if (preview) return <MoverHomeScreen navigation={navigation} />;

  if (isLoading) {
    return (
      <Screen>
        <LoadingBlock />
      </Screen>
    );
  }

  return (
    <>
      {status?.roleVerified ? <MoverHomeScreen navigation={navigation} /> : <MoverOnboardingScreen status={status} />}
      <WentLivePopup visible={live.celebrate} onClose={live.dismiss} kind="mover" />
    </>
  );
}

/** A persistent, unmissable "Preview" strip while a prospective mover explores
 *  the earner app read-only — tap to leave preview and return to the role picker. */
function MoverPreviewBanner() {
  const insets = useSafeAreaInsets();
  const exitPreview = useMoverPreview((s) => s.exitPreview);
  const setIntent = useAuthStore((s) => s.setIntent);
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, paddingTop: insets.top + 4, alignItems: 'center' }}>
      <Pressable
        onPress={() => {
          exitPreview();
          setIntent(null); // back to "How will you use Swift?"
        }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: color.brand[500], paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999 }}
        hitSlop={10}
      >
        <Feather name="eye" size={13} color={color.white} />
        <T variant="caption" style={{ color: color.white, fontWeight: '700' }}>
          Preview — tap to exit
        </T>
      </Pressable>
    </View>
  );
}

export function MoverStack() {
  const preview = useMoverPreview((s) => s.preview);
  return (
    <View style={{ flex: 1 }}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="MoverRoot" component={MoverRoot} />
        <Stack.Screen name="ActiveJob" component={ActiveJobScreen} />
        <Stack.Screen name="Earnings" component={EarningsScreen} />
        <Stack.Screen name="JobHistory" component={JobHistoryScreen} />
        <Stack.Screen name="Account" component={MoverAccountScreen} />
        <Stack.Screen name="MoverDocuments" component={MoverDocumentsScreen} />
        <Stack.Screen name="MySwiftNumber" component={MoverSwiftNumberScreen} />
        <Stack.Screen name="Chat" component={ChatScreen} />
      </Stack.Navigator>
      {preview ? <MoverPreviewBanner /> : null}
    </View>
  );
}
