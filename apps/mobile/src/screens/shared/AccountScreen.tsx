import { View, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text, Heading, Card, Button, Badge } from '../../components/ui';
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
  const list = addresses ?? [];

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-base">
      <View className="px-lg pb-sm pt-md">
        <Heading size="2xl">Account</Heading>
      </View>
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        <View className="px-lg">
          <Card className="flex-row items-center">
            <View className="h-14 w-14 items-center justify-center rounded-full bg-brand-500">
              <Text className="text-lg font-semibold text-white">{initials}</Text>
            </View>
            <View className="ml-md flex-1">
              <Text className="text-lg font-semibold">
                {firstName || 'Your account'} {lastName}
              </Text>
              {phone ? <Text className="mt-xs text-sm text-text-secondary">{phone}</Text> : null}
            </View>
          </Card>

          {profile?.customer ? (
            <View className="mt-md flex-row" style={{ gap: 12 }}>
              <Card className="flex-1 items-center">
                <Text className="text-xl font-semibold">{profile.customer.totalOrders ?? 0}</Text>
                <Text className="mt-xs text-xs text-text-secondary">Orders</Text>
              </Card>
              <Card className="flex-1 items-center">
                <Text className="text-base font-semibold">{profile.customer.referralCode ?? '—'}</Text>
                <Text className="mt-xs text-xs text-text-secondary">Referral code</Text>
              </Card>
            </View>
          ) : null}

          <Heading size="lg" className="mb-sm mt-xl">
            Saved addresses
          </Heading>
          {list.length === 0 ? (
            <Card>
              <Text className="text-text-secondary">No saved addresses yet.</Text>
            </Card>
          ) : (
            list.map((a) => (
              <Card key={a.id} className="mb-sm">
                <View className="flex-row items-center justify-between">
                  <View className="flex-1 pr-md">
                    <Text className="text-base font-semibold">{a.label || a.addressLine1}</Text>
                    <Text className="mt-xs text-sm text-text-secondary" numberOfLines={1}>
                      {a.addressLine1}
                      {a.city ? `, ${a.city}` : ''}
                    </Text>
                  </View>
                  {a.isDefault ? <Badge label="Default" tone="success" /> : null}
                </View>
              </Card>
            ))
          )}

          <Pressable onPress={() => navigation?.navigate?.('IdentityVerification')}>
            <Card className="mt-xl flex-row items-center justify-between">
              <View className="flex-1 pr-md">
                <Text className="text-base font-semibold">Verify your identity</Text>
                <Text className="mt-xs text-xs text-text-secondary">Lifts the limit on larger orders &amp; rides.</Text>
              </View>
              <Text className="text-xl text-brand-500">›</Text>
            </Card>
          </Pressable>

          <View className="mt-md flex-row items-start rounded-lg bg-brand-50 px-lg py-md">
            <Text className="text-base">💵</Text>
            <Text className="ml-sm flex-1 text-sm text-brand-700">
              Swift is cash-only for now — pay on delivery or completion. No cards, no platform fees.
            </Text>
          </View>

          <Button label="Log out" variant="outline" className="mt-xl" onPress={logout} />
          <Text className="mt-md text-center text-xs text-text-muted">Swift · Guyana</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
