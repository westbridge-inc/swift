import { View, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { Image } from 'expo-image';
import { color } from '@swift/ui';
import { Text, Heading, Button, PressableScale, elevation } from '../../../components/ui';
import { useMoverKind, useVerificationStatus, useEarningsSummary, useUploadVehiclePhoto } from '../../../hooks';
import { useAuthStore } from '../../../stores/authStore';
import { money } from '../../../lib/money';
import { mediaUrl } from '../../../lib/images';

export function MoverAccountScreen({ navigation }: any) {
  const { user, logout } = useAuthStore();
  const { kind, profile } = useMoverKind();
  const verified = (useVerificationStatus<any>('MOVER').data as any)?.roleVerified;
  const summaryQ = useEarningsSummary<any>(kind);
  const allTime = (summaryQ.data as any)?.allTime?.total ?? 0;
  const uploadVehiclePhoto = useUploadVehiclePhoto(kind);

  const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Your account';
  const initial = (user?.firstName ?? 'S').charAt(0).toUpperCase();
  const rating = profile?.averageRating;
  const isDriver = kind === 'DRIVER';
  const vehicle = profile
    ? [profile.vehicleColor, profile.vehicleMake, profile.vehicleModel].filter(Boolean).join(' ') ||
      (profile.vehicleType ? String(profile.vehicleType).toLowerCase() : '')
    : null;

  const pickVehiclePhoto = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    uploadVehiclePhoto.mutate({ uri: a.uri, name: a.fileName ?? 'vehicle.jpg', type: a.mimeType ?? 'image/jpeg' });
  };

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

        {/* Vehicle — customers see this photo when you accept (§5) */}
        {vehicle || profile ? (
          <View className="mt-md rounded-2xl bg-surface-base p-md" style={elevation.card}>
            <View className="flex-row items-center">
              {profile?.vehiclePhotoUrl ? (
                <Image
                  source={{ uri: mediaUrl(profile.vehiclePhotoUrl) ?? undefined }}
                  style={{ width: 64, height: 44, borderRadius: 8 }}
                  contentFit="cover"
                />
              ) : (
                <View className="h-9 w-9 items-center justify-center rounded-full bg-surface-subtle">
                  <MaterialCommunityIcons name={isDriver ? 'car-side' : 'bike-fast'} size={18} color={color.brand[500]} />
                </View>
              )}
              <View className="ml-md flex-1">
                <Text className="text-sm font-bold text-text-primary">{vehicle || 'Your vehicle'}</Text>
                <Text className="text-xs text-text-muted">{profile?.licensePlate ?? ''}</Text>
              </View>
              <PressableScale onPress={pickVehiclePhoto} disabled={uploadVehiclePhoto.isPending} hitSlop={8}>
                <Text className="text-sm font-semibold text-brand-600">
                  {uploadVehiclePhoto.isPending ? 'Uploading…' : profile?.vehiclePhotoUrl ? 'Change photo' : 'Add photo'}
                </Text>
              </PressableScale>
            </View>
            {!profile?.vehiclePhotoUrl ? (
              <Text className="mt-xs text-xs text-text-muted">
                Add a clear photo of your vehicle — customers see it the moment you accept.
              </Text>
            ) : null}
            {uploadVehiclePhoto.isError ? (
              <Text className="mt-xs text-xs text-error">Upload failed — try a different photo.</Text>
            ) : null}
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
