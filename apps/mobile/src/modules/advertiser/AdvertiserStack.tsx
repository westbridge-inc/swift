/** @jsxImportSource react */
import React from 'react';
import { View } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { ErrorState, LoadingBlock, PillButton } from '../../kit';
import { useAdvertiserExitDialog } from './AdvertiserExitDialog';
import { useMyAdvertisers } from '../../hooks/advertiser';
import { useAdsEnabled } from '../../hooks/useAdsEnabled';
import { RolePickerScreen } from '../../screens/auth/RolePickerScreen';
import { AdvertiserRegisterScreen } from './screens/AdvertiserRegisterScreen';
import { AdvertiserHomeScreen } from './screens/AdvertiserHomeScreen';
import { NewCampaignScreen } from './screens/NewCampaignScreen';
import { CampaignDetailScreen } from './screens/CampaignDetailScreen';
import { AdvertiserBillingScreen } from './screens/AdvertiserBillingScreen';
import { AdvertiserTeamScreen } from './screens/AdvertiserTeamScreen';
import { PersonalDataScreen } from '../profile/screens/PersonalDataScreen';
import { GetHelpScreen } from '../profile/screens/GetHelpScreen';

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
  const adsEnabled = useAdsEnabled();
  return adsEnabled ? <EnabledAdvertiserStack /> : <RolePickerScreen />;
}

/** [UI-SWEEP U32] The advertiser's first read failed. `intent` persists, so a
 *  cold start reopens this same screen: Try again alone was a one-way door.
 *  The way out is the advertiser's own exit (log out and switch experience),
 *  as on its sign-up screen; the business stack keeps the same rule (MOB-038). */
function AdvertiserRootError({ onRetry }: { onRetry: () => void }) {
  const exitDialog = useAdvertiserExitDialog();
  return (
    <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
      <ErrorState onRetry={onRetry} style={{ paddingTop: 120 }} />
      <PillButton
        label="Log out and switch experience"
        icon="log-out"
        variant="outline"
        onPress={exitDialog.requestLogout}
        style={{ alignSelf: 'center', marginTop: space.xl }}
      />
      {exitDialog.logoutDialog}
    </View>
  );
}

function EnabledAdvertiserStack() {
  const me = useMyAdvertisers();

  if (me.isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: color.surface.subtle }}>
        <LoadingBlock style={{ paddingTop: 160 }} />
      </View>
    );
  }
  if (me.isError) return <AdvertiserRootError onRetry={() => me.refetch()} />;

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
          {/* [B-support] A REJECTED advertiser was told "Contact support to
              appeal" from a stack with no support screen. The ticket screen is
              role-agnostic; this registration is the whole fix's other half. */}
          <Stack.Screen name="GetHelp" component={GetHelpScreen} />
        </>
      )}
      <Stack.Screen name="PersonalData" component={PersonalDataScreen} />
    </Stack.Navigator>
  );
}
