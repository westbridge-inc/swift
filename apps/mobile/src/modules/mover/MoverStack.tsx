/** @jsxImportSource react */
import React from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { LoadingBlock, Screen, T } from '../../kit';
import { ConversationScreen } from '../chat/screens/ConversationScreen';
import { useActiveJob, useBroadcastLocation, useMoverKind, useVerificationStatus } from '../../hooks';
import { shouldTrackMoverLocation } from '../../lib/moverLocation';
import { useMoverPreview } from '../../stores/moverPreview';
import { useWentLive, WentLivePopup } from '../../components/onboarding/WentLive';
import { PREVIEW_COPY, useLeaveMoverPreview } from './preview';
import { MoverHomeScreen } from './screens/MoverHomeScreen';
import { ActiveJobScreen } from './screens/ActiveJobScreen';
import { EarningsScreen } from './screens/EarningsScreen';
import { ClaimsScreen } from './screens/ClaimsScreen';
import { JobHistoryScreen } from './screens/JobHistoryScreen';
import { MoverAccountScreen } from './screens/MoverAccountScreen';
import { MoverDocumentsScreen } from './screens/MoverDocumentsScreen';
import { MoverVehicleScreen } from './screens/MoverVehicleScreen';
import { WeeklyFeeRouteScreen } from '../billing/screens/WeeklyFeeRouteScreen';
import { MoverOnboardingScreen } from './screens/MoverOnboardingScreen';
// [B-support] The ticket screen is role-agnostic (generic create+list); the
// mover stack simply never registered it — an earner mid-shift had NO route
// to a human. Registration, not a rewrite.
import { GetHelpScreen } from '../profile/screens/GetHelpScreen';
// [E12 §7.1] The shift identity check — go-online's 428 and the mid-shift
// push both land here.
import { LivenessCheckScreen } from '../safety/screens/LivenessCheckScreen';
import { GuardianDriverConfirmScreen } from '../safety/screens/GuardianDriverConfirmScreen';

const Stack = createNativeStackNavigator();

// Verified movers land in the map-first ops home; unverified see onboarding.
// Polling means an admin approval flips this screen within seconds — and the
// flip itself gets its moment (the went-live popup), Uber-style.
function MoverRoot({ navigation }: any) {
  const preview = useMoverPreview((s) => s.preview);
  const { data: status, isLoading } = useVerificationStatus<any>('MOVER', undefined, { poll: true });
  const live = useWentLive(preview ? undefined : status ? !!status.roleVerified : undefined);

  // Preview (R3): the REAL dashboard home fed sample data — no verification
  // gate, no onboarding, no went-live popup. Opened from the documents, the
  // real status query is paused (not changed), so leaving lands on them again.
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

/** Own the single native tracking stream above verification and navigation.
 * A force-offlined mover can still have an assigned trip, so mounting this on
 * Home alone loses customer-visible GPS after a restart or verification flip. */
function MoverLocationSupervisor() {
  const preview = useMoverPreview((s) => s.preview);
  const { kind, profile } = useMoverKind();
  const active = useActiveJob(kind);
  useBroadcastLocation(
    kind,
    !preview && shouldTrackMoverLocation(!!profile?.isOnline, active.data),
  );
  return null;
}

/** A persistent, unmissable "Preview" strip while a mover explores the earner
 *  app read-only — tap to leave the preview the way it was entered: back to
 *  the documents, or back to the role picker. */
function MoverPreviewBanner() {
  const insets = useSafeAreaInsets();
  const { fromDocuments, leave } = useLeaveMoverPreview();
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, paddingTop: insets.top + 4, alignItems: 'center' }}>
      <Pressable
        testID="mover-preview-exit"
        accessibilityRole="button"
        accessibilityLabel={fromDocuments ? PREVIEW_COPY.backToDocuments : 'Exit driver preview'}
        accessibilityHint={fromDocuments ? 'Leave the preview and go back to your documents' : 'Return to the Swift role picker'}
        onPress={leave}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: color.brand[500], paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999 }}
        hitSlop={10}
      >
        <Feather name="eye" size={13} color={color.white} />
        <T variant="caption" style={{ color: color.white, fontWeight: '700' }}>
          {fromDocuments ? 'Preview · Back to documents' : 'Preview — tap to exit'}
        </T>
      </Pressable>
    </View>
  );
}

export function MoverStack() {
  const preview = useMoverPreview((s) => s.preview);
  return (
    <View style={{ flex: 1 }}>
      <MoverLocationSupervisor />
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {/* The preview and the real app never share a screen: entering or
            leaving the preview replaces every route with a fresh MoverRoot, so
            no sample screen outlives the preview (leaving from Earnings lands on
            the documents, not on a real Earnings) and nothing typed before it
            leaks in. */}
        <Stack.Group navigationKey={preview ? 'mover-preview' : 'mover-live'}>
          <Stack.Screen name="MoverRoot" component={MoverRoot} />
          <Stack.Screen name="ActiveJob" component={ActiveJobScreen} />
          <Stack.Screen name="Earnings" component={EarningsScreen} />
          {/* [DOC-1 §31.4] The guarantee claims a mover filed — status, evidence, settlement SLA. */}
          <Stack.Screen name="Claims" component={ClaimsScreen} />
          <Stack.Screen name="JobHistory" component={JobHistoryScreen} />
          <Stack.Screen name="Account" component={MoverAccountScreen} />
          <Stack.Screen name="MoverDocuments" component={MoverDocumentsScreen} />
          {/* [VEHICLES] Change the vehicle: offline until the new one's papers are approved. */}
          <Stack.Screen name="MoverVehicle" component={MoverVehicleScreen} />
          <Stack.Screen name="WeeklyFee" component={WeeklyFeeRouteScreen} />
          <Stack.Screen name="Conversation" component={ConversationScreen} />
          <Stack.Screen name="GetHelp" component={GetHelpScreen} />
          <Stack.Screen name="LivenessCheck" component={LivenessCheckScreen} />
          {/* [TST-001] The driver's half of a Trip Guardian check. The push that
              asks for it used to route to Delivery — a screen this stack never
              mounts — so a safety question had nowhere to be answered. */}
          <Stack.Screen name="GuardianDriverConfirm" component={GuardianDriverConfirmScreen} />
        </Stack.Group>
      </Stack.Navigator>
      {preview ? <MoverPreviewBanner /> : null}
    </View>
  );
}
