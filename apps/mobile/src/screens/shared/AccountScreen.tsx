import { View, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, Card, Button, Badge, elevation } from '../../components/ui';
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
          <View className="flex-row items-center rounded-2xl bg-brand-500 p-lg" style={elevation.floating}>
            <View className="h-16 w-16 items-center justify-center rounded-full bg-surface-base">
              <Text className="text-xl font-bold text-brand-600">{initials}</Text>
            </View>
            <View className="ml-md flex-1">
              <Text className="text-xl font-bold text-white" numberOfLines={1}>{firstName || 'Your account'} {lastName}</Text>
              {phone ? <Text className="mt-xs text-sm text-white" style={{ opacity: 0.85 }}>{phone}</Text> : null}
            </View>
          </View>

          {profile?.customer ? (
            <View className="mt-md flex-row" style={{ gap: 12 }}>
              <Card className="flex-1 items-center">
                <Text className="text-xl font-bold">{profile.customer.totalOrders ?? 0}</Text>
                <Text className="mt-xs text-xs text-text-secondary">Orders</Text>
              </Card>
              <Card className="flex-1 items-center">
                <Text className="text-base font-bold">{profile.customer.referralCode ?? '—'}</Text>
                <Text className="mt-xs text-xs text-text-secondary">Referral code</Text>
              </Card>
            </View>
          ) : null}

          <View className="mb-sm mt-xl flex-row items-center justify-between">
            <Heading size="lg">Saved addresses</Heading>
            <Pressable onPress={() => navigation?.navigate?.('AddAddress')} hitSlop={8} className="flex-row items-center">
              <Feather name="plus" size={16} color={color.brand[500]} />
              <Text className="ml-1 text-sm font-semibold text-brand-600">Add</Text>
            </Pressable>
          </View>
          {list.length === 0 ? (
            <Pressable onPress={() => navigation?.navigate?.('AddAddress')}>
              <Card className="flex-row items-center">
                <MaterialCommunityIcons name="map-marker-plus-outline" size={20} color={color.brand[500]} />
                <Text className="ml-sm text-text-secondary">Add your first address</Text>
              </Card>
            </Pressable>
          ) : (
            list.map((a) => (
              <Card key={a.id} className="mb-sm flex-row items-center">
                <MaterialCommunityIcons name="map-marker-outline" size={20} color={color.text.muted} />
                <View className="ml-sm flex-1">
                  <Text className="text-base font-semibold">{a.label || a.addressLine1}</Text>
                  <Text className="mt-xs text-sm text-text-secondary" numberOfLines={1}>
                    {a.addressLine1}{a.city ? `, ${a.city}` : ''}
                  </Text>
                </View>
                {a.isDefault ? <Badge label="Default" tone="success" /> : null}
              </Card>
            ))
          )}

          <Pressable onPress={() => navigation?.navigate?.('IdentityVerification')}>
            <Card className="mt-xl flex-row items-center">
              <MaterialCommunityIcons name="shield-check-outline" size={22} color={color.brand[500]} />
              <View className="ml-md flex-1">
                <Text className="text-base font-semibold">Verify your identity</Text>
                <Text className="mt-xs text-xs text-text-secondary">Lifts the limit on larger orders &amp; rides.</Text>
              </View>
              <Feather name="chevron-right" size={20} color={color.text.muted} />
            </Card>
          </Pressable>

          <View className="mt-md flex-row items-center rounded-2xl bg-brand-50 px-lg py-md">
            <MaterialCommunityIcons name="cash" size={20} color={color.success} />
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
