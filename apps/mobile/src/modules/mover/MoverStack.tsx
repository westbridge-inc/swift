/** @jsxImportSource react */
import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { LoadingBlock, Screen } from '../../kit';
import { ChatScreen } from '../../screens/shared/ChatScreen';
import { useVerificationStatus } from '../../hooks';
import { useWentLive, WentLivePopup } from '../../components/onboarding/WentLive';
import { MoverHomeScreen } from './screens/MoverHomeScreen';
import { ActiveJobScreen } from './screens/ActiveJobScreen';
import { EarningsScreen } from './screens/EarningsScreen';
import { JobHistoryScreen } from './screens/JobHistoryScreen';
import { MoverAccountScreen } from './screens/MoverAccountScreen';
import { MoverDocumentsScreen } from './screens/MoverDocumentsScreen';
import { MoverOnboardingScreen } from './screens/MoverOnboardingScreen';

const Stack = createNativeStackNavigator();

// Verified movers land in the map-first ops home; unverified see onboarding.
// Polling means an admin approval flips this screen within seconds — and the
// flip itself gets its moment (the went-live popup), Uber-style.
function MoverRoot({ navigation }: any) {
  const { data: status, isLoading } = useVerificationStatus<any>('MOVER', undefined, { poll: true });
  const live = useWentLive(status ? !!status.roleVerified : undefined);

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

export function MoverStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="MoverRoot" component={MoverRoot} />
      <Stack.Screen name="ActiveJob" component={ActiveJobScreen} />
      <Stack.Screen name="Earnings" component={EarningsScreen} />
      <Stack.Screen name="JobHistory" component={JobHistoryScreen} />
      <Stack.Screen name="Account" component={MoverAccountScreen} />
      <Stack.Screen name="MoverDocuments" component={MoverDocumentsScreen} />
      <Stack.Screen name="Chat" component={ChatScreen} />
    </Stack.Navigator>
  );
}
