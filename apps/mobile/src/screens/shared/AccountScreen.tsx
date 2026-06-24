import { View, ScrollView, Share } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color } from '@swift/ui';
import { Text, Heading, Badge, SettingsGroup, SettingsRow } from '../../components/ui';
import { useAuthStore } from '../../stores/authStore';
import { useProfile, useAddresses } from '../../hooks';

export function AccountScreen({ navigation }: any) {
  const { user, logout } = useAuthStore();
  const { data: profile } = useProfile<any>();
  const { data: addresses } = useAddresses<any[]>();

  const firstName = profile?.firstName ?? user?.firstName ?? '';
  const lastName = profile?.lastName ?? user?.lastName ?? '';
  const phone = profile?.phone ?? user?.phone ?? '';
  const initials = `${(firstName[0] || '').toUpperCase()}${(lastName[0] || '').toUpperCase()}` || '?';
  const fullName = `${firstName} ${lastName}`.trim() || 'Your account';
  const list = addresses ?? [];
  const orders = profile?.customer?.totalOrders ?? 0;
  const referralCode: string | undefined = profile?.customer?.referralCode;
  const referredCount: number = profile?.customer?.referredCount ?? 0;

  const invite = () => {
    if (!referralCode) return;
    Share.share({
      message: `Join me on Swift — Guyana's everyday app for food, groceries, rides and more. Use my code ${referralCode} when you sign up.`,
    }).catch(() => {});
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
      <View className="px-lg pb-sm pt-md">
        <Heading size="2xl">Account</Heading>
      </View>
      <ScrollView className="flex-1" contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        {/* Profile */}
        <SettingsGroup>
          <View className="flex-row items-center px-md py-md">
            <View className="h-14 w-14 items-center justify-center rounded-full bg-brand-500">
              <Text className="text-lg font-bold text-white">{initials}</Text>
            </View>
            <View className="ml-md flex-1">
              <Text className="text-lg font-bold text-text-primary" numberOfLines={1}>{fullName}</Text>
              {phone ? <Text className="mt-0.5 text-sm text-text-secondary">{phone}</Text> : null}
            </View>
          </View>
        </SettingsGroup>

        {/* Activity */}
        <SettingsGroup header="Activity">
          <SettingsRow
            icon="clipboard-text-outline"
            label="Your orders"
            value={String(orders)}
            onPress={() => navigation?.navigate?.('Orders')}
          />
          <SettingsRow
            icon="heart-outline"
            label="Saved places"
            onPress={() => navigation?.navigate?.('Favorites')}
          />
          {referralCode ? (
            <SettingsRow
              icon="gift-outline"
              label="Invite friends"
              sublabel={
                referredCount > 0
                  ? `${referredCount} ${referredCount === 1 ? 'friend has' : 'friends have'} joined with your code`
                  : 'Share your referral code'
              }
              onPress={invite}
            />
          ) : null}
        </SettingsGroup>

        {/* Saved addresses */}
        <SettingsGroup header="Saved addresses">
          {list.map((a) => (
            <SettingsRow
              key={a.id}
              icon="map-marker-outline"
              label={a.label || a.addressLine1}
              sublabel={`${a.addressLine1}${a.city ? `, ${a.city}` : ''}`}
              right={a.isDefault ? <Badge label="Default" tone="success" /> : undefined}
            />
          ))}
          <SettingsRow icon="plus" iconColor={color.brand[500]} label="Add address" onPress={() => navigation?.navigate?.('AddAddress')} />
        </SettingsGroup>

        {/* Account */}
        <SettingsGroup header="Account">
          <SettingsRow
            icon="shield-check-outline"
            label="Verify your identity"
            sublabel="Lifts the limit on larger orders & rides"
            onPress={() => navigation?.navigate?.('IdentityVerification')}
          />
          <SettingsRow icon="bell-outline" label="Notifications" onPress={() => navigation?.navigate?.('Notifications')} />
          <SettingsRow icon="cash" label="Payment" sublabel="Cash only — pay on delivery or completion" />
        </SettingsGroup>

        {/* Log out */}
        <SettingsGroup>
          <SettingsRow icon="logout" label="Log out" danger onPress={logout} />
        </SettingsGroup>

        <Text className="mb-md mt-xs text-center text-xs text-text-muted">Swift · Guyana · v1.0</Text>
      </ScrollView>
    </SafeAreaView>
  );
}
