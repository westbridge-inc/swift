/** @jsxImportSource react */
import React from 'react';
import { View } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Feather } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { ErrorState, LoadingBlock } from '../../kit';
import { useMyAdvertisers } from '../../hooks/advertiser';
import { AdvertiserRegisterScreen } from './screens/AdvertiserRegisterScreen';
import { AdvertiserHomeScreen } from './screens/AdvertiserHomeScreen';
import { NewCampaignScreen } from './screens/NewCampaignScreen';
import { CampaignDetailScreen } from './screens/CampaignDetailScreen';
import { AdvertiserBillingScreen } from './screens/AdvertiserBillingScreen';
import { AdvertiserTeamScreen } from './screens/AdvertiserTeamScreen';

// The advertiser surface (ads-platform spec §14) — role-routed like the vendor
// and mover dashboards. Gated-preview pattern (§14.1): register → explore +
// draft while PENDING_REVIEW; checkout stays server-locked until APPROVED (the
// UI mirrors the lock, the API enforces it).

const Stack = createNativeStackNavigator();
const Tabs = createBottomTabNavigator();

const TAB_ICON: Record<string, React.ComponentProps<typeof Feather>['name']> = {
  AdvHome: 'home',
  AdvBilling: 'file-text',
  AdvTeam: 'user',
};

function AdvertiserTabs() {
  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: color.brand[500],
        tabBarInactiveTintColor: color.text.muted,
        tabBarIcon: ({ color: c, size }) => <Feather name={TAB_ICON[route.name] ?? 'circle'} size={size} color={c} />,
      })}
    >
      <Tabs.Screen name="AdvHome" component={AdvertiserHomeScreen} options={{ title: 'Campaigns' }} />
      <Tabs.Screen name="AdvBilling" component={AdvertiserBillingScreen} options={{ title: 'Billing' }} />
      <Tabs.Screen name="AdvTeam" component={AdvertiserTeamScreen} options={{ title: 'Account' }} />
    </Tabs.Navigator>
  );
}

export function AdvertiserStack() {
  const me = useMyAdvertisers();

  if (me.isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
        <LoadingBlock style={{ paddingTop: 160 }} />
      </View>
    );
  }
  if (me.isError) {
    return (
      <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
        <ErrorState onRetry={() => me.refetch()} style={{ paddingTop: 120 }} />
      </View>
    );
  }

  const hasAdvertiser = (me.data ?? []).length > 0;
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {!hasAdvertiser ? (
        <Stack.Screen name="AdvRegister" component={AdvertiserRegisterScreen} />
      ) : (
        <>
          <Stack.Screen name="AdvTabs" component={AdvertiserTabs} />
          <Stack.Screen name="NewCampaign" component={NewCampaignScreen} />
          <Stack.Screen name="CampaignDetail" component={CampaignDetailScreen} />
        </>
      )}
    </Stack.Navigator>
  );
}
