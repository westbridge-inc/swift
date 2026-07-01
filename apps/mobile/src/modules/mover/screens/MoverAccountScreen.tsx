import { View, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { Text, Heading, Button, PressableScale, elevation } from '../../../components/ui';
import { useMoverKind, useVerificationStatus, useEarningsSummary } from '../../../hooks';
import { useAuthStore } from '../../../stores/authStore';
import { money } from '../../../lib/money';

export function MoverAccountScreen({ navigation }: any) {
  const { user, logout } = useAuthStore();
  const { kind, profile } = useMoverKind();
  const verified = (useVerificationStatus<any>('MOVER').data as any)?.roleVerified;
  const summaryQ = useEarningsSummary<any>(kind);
  const allTime = (summaryQ.data as any)?.allTime?.total ?? 0;

  const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Your account';
  const initial = (user?.firstName ?? 'S').charAt(0).toUpperCase();
  const rating = profile?.averageRating;
  const isDriver = kind === 'DRIVER';
  const vehicle = isDriver && profile ? [profile.vehicleColor, profile.vehicleMake, profile.vehicleModel].filter(Boolean).join(' ') : null;

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
      <View className="flex-row items-center px-lg py-sm">
        <PressableScale onPress={() => navigation?.goBack?.()} hitSlop={8} className="mr-sm">
          <Feather name="chevron-left" size={24} color={color.text.primary} />
        </PressableScale>
        <Heading size="xl">Account</Heading>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>
        {/* Profile */}
        <View className="flex-row items-center rounded-3xl bg-surface-base p-lg" style={elevation.card}>
          <View className="h-14 w-14 items-center justify-center rounded-full" style={{ backgroundColor: color.brand[500] }}>
            <Text className="font-display text-xl font-extrabold text-white">{initial}</Text>
          </View>
          <View className="ml-md flex-1">
            <Heading size="lg" numberOfLines={1}>{name}</Heading>
            <Text className="text-sm text-text-muted">{user?.phone ?? ''}</Text>
            <View className="mt-1 flex-row items-center" style={{ gap: 10 }}>
              <View className="flex-row items-center rounded-full bg-surface-subtle px-2 py-0.5">
                <MaterialCommunityIcons name={isDriver ? 'car' : 'bike-fast'} size={12} color={color.text.secondary} />
                <Text className="ml-1 text-[11px] font-bold text-text-secondary">{isDriver ? 'Driver' : 'Rider'}</Text>
              </View>
              {rating ? (
                <View className="flex-row items-center">
                  <MaterialCommunityIcons name="star" size={13} color="#F5A623" />
                  <Text className="ml-0.5 text-[11px] font-bold text-text-secondary">{Number(rating).toFixed(1)}</Text>
                </View>
              ) : null}
              {verified ? (
                <View className="flex-row items-center">
                  <MaterialCommunityIcons name="check-decagram" size={13} color={color.success} />
                  <Text className="ml-0.5 text-[11px] font-bold text-success">Verified</Text>
                </View>
              ) : null}
            </View>
          </View>
        </View>

        {/* Vehicle (driver) */}
        {vehicle ? (
          <View className="mt-md flex-row items-center rounded-2xl bg-surface-base p-md" style={elevation.card}>
            <View className="h-9 w-9 items-center justify-center rounded-full bg-surface-subtle">
              <MaterialCommunityIcons name="car-side" size={18} color={color.brand[500]} />
            </View>
            <View className="ml-md flex-1">
              <Text className="text-sm font-bold text-text-primary">{vehicle}</Text>
              <Text className="text-xs text-text-muted">{profile?.licensePlate ?? 'Your vehicle'}</Text>
            </View>
          </View>
        ) : null}

        {/* Earnings link */}
        <PressableScale className="mt-md" onPress={() => navigation?.navigate?.('Earnings')}>
          <View className="flex-row items-center rounded-2xl bg-surface-base p-md" style={elevation.card}>
            <View className="h-9 w-9 items-center justify-center rounded-full bg-surface-subtle">
              <MaterialCommunityIcons name="cash-multiple" size={18} color={color.brand[500]} />
            </View>
            <View className="ml-md flex-1">
              <Text className="text-sm font-bold text-text-primary">Earnings</Text>
              <Text className="text-xs text-text-muted">{money(allTime)} all-time · 100% yours</Text>
            </View>
            <Feather name="chevron-right" size={18} color={color.text.muted} />
          </View>
        </PressableScale>

        {/* The model */}
        <View className="mt-md rounded-2xl bg-surface-base p-lg" style={elevation.card}>
          <View className="flex-row items-center">
            <MaterialCommunityIcons name="check-decagram" size={16} color={color.success} />
            <Text className="ml-2 text-sm font-bold text-text-primary">You keep 100%</Text>
          </View>
          <Text className="mt-1 text-xs leading-4 text-text-secondary">
            Swift only charges a flat weekly fee — no commission on any fare, ever. You&apos;re paid in cash, on every job.
          </Text>
        </View>

        <Button label="Log out" variant="outline" className="mt-lg" onPress={logout} />
      </ScrollView>
    </SafeAreaView>
  );
}
