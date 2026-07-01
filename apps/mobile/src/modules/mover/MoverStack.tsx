import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Spinner } from '../../components/ui';
import { ChatScreen } from '../../screens/shared/ChatScreen';
import { useVerificationStatus } from '../../hooks';
import { MoverHomeScreen } from './screens/MoverHomeScreen';
import { ActiveJobScreen } from './screens/ActiveJobScreen';
import { EarningsScreen } from './screens/EarningsScreen';
import { MoverAccountScreen } from './screens/MoverAccountScreen';
import { MoverOnboardingScreen } from './screens/MoverOnboardingScreen';

const Stack = createNativeStackNavigator();

// Verified movers land in the map-first ops home; unverified see onboarding.
function MoverRoot({ navigation }: any) {
  const { data: status, isLoading } = useVerificationStatus<any>('MOVER');

  if (isLoading) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
        <View className="flex-1 items-center justify-center">
          <Spinner size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return status?.roleVerified ? <MoverHomeScreen navigation={navigation} /> : <MoverOnboardingScreen status={status} />;
}

export function MoverStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="MoverRoot" component={MoverRoot} />
      <Stack.Screen name="ActiveJob" component={ActiveJobScreen} />
      <Stack.Screen name="Earnings" component={EarningsScreen} />
      <Stack.Screen name="Account" component={MoverAccountScreen} />
      <Stack.Screen name="Chat" component={ChatScreen} />
    </Stack.Navigator>
  );
}
