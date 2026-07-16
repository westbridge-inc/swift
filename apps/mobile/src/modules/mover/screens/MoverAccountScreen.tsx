/** @jsxImportSource react */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { Image } from 'expo-image';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { space } from '@swift/ui';
import { LinkText, PillButton, T, TonePill } from '../../../kit';
import { MmgPayLinkCard } from '../../../components/MmgPayLinkCard';
import { driverApi } from '../../../services/api';
import { Stars } from '../../../kit/controls';
import { useMoverKind, useVerificationStatus, useEarningsSummary, useMoverSubscription, useUploadVehiclePhoto } from '../../../hooks';
import { useAuthStore } from '../../../stores/authStore';
import { RoleSwitcherSheet } from '../../../components/RoleSwitcherSheet';
import { money } from '../../../lib/money';
import { mediaUrl } from '../../../lib/images';
import { dk, DCard, DRow, DHeader } from '../dark';

/** The earner account, in the app's dark language (Phase E-lite) — the
 *  reference's profile screen: identity, vehicle, stats, doors. */

export function MoverAccountScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuthStore();
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  const { kind, profile } = useMoverKind();
  const verified = (useVerificationStatus<any>('MOVER').data as any)?.roleVerified;
  const summaryQ = useEarningsSummary<any>(kind);
  const subQ = useMoverSubscription(kind);
  const allTime = (summaryQ.data as any)?.allTime?.total ?? 0;
  const uploadVehiclePhoto = useUploadVehiclePhoto(kind);
  const qc = useQueryClient();
  const saveMmgLink = useMutation({
    mutationFn: (mmgPayUrl: string | null) => driverApi.updateProfile({ mmgPayUrl }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mover', 'driverProfile'] }),
  });

  const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || 'Your account';
  const initial = (user?.firstName ?? 'S').charAt(0).toUpperCase();
  const rating = profile?.averageRating;
  const isDriver = kind === 'DRIVER';
  const vehicle = profile
    ? [profile.vehicleColor, profile.vehicleMake, profile.vehicleModel].filter(Boolean).join(' ') ||
      (profile.vehicleType ? String(profile.vehicleType).toLowerCase() : '')
    : null;
  const sub = subQ.data;
  const subPill = !sub
    ? { label: 'Inactive', tone: 'brand' as const }
    : sub.isTrialActive
      ? { label: 'Free trial', tone: 'brand' as const }
      : sub.isInGracePeriod
        ? { label: 'Grace', tone: 'error' as const }
        : sub.status === 'ACTIVE'
          ? { label: 'Active', tone: 'success' as const }
          : { label: String(sub.status ?? '').toLowerCase() || 'Inactive', tone: 'neutral' as const };

  const pickVehiclePhoto = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    uploadVehiclePhoto.mutate({ uri: a.uri, name: a.fileName ?? 'vehicle.jpg', type: a.mimeType ?? 'image/jpeg' });
  };

  return (
    <View style={{ flex: 1, backgroundColor: dk.bg, paddingTop: insets.top }}>
      <DHeader title="Account" onBack={() => navigation?.goBack?.()} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
        {/* Profile */}
        <DCard style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <View style={{ width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: dk.accent }}>
            <T variant="title" style={{ color: '#fff' }}>
              {initial}
            </T>
          </View>
          <View style={{ flex: 1 }}>
            <T variant="heading" numberOfLines={1} style={{ color: dk.text }}>
              {name}
            </T>
            <T variant="label" style={{ color: dk.muted, marginTop: 2 }}>
              {user?.phone ?? ''}
            </T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: 6 }}>
              <TonePill label={isDriver ? 'Driver' : 'Rider'} tone="neutral" dark />
              {rating ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                  <Stars value={Number(rating)} size={12} />
                  <T variant="caption" weight="bold" style={{ color: dk.muted }}>
                    {Number(rating).toFixed(1)}
                  </T>
                </View>
              ) : null}
              {verified ? <TonePill label="Verified" tone="success" dark /> : null}
            </View>
          </View>
        </DCard>

        {/* Vehicle — customers see this photo when you accept (§5) */}
        {vehicle || profile ? (
          <DCard style={{ marginTop: space.md }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              {profile?.vehiclePhotoUrl ? (
                <Image source={{ uri: mediaUrl(profile.vehiclePhotoUrl) ?? undefined }} style={{ width: 64, height: 44, borderRadius: 8 }} contentFit="cover" />
              ) : (
                <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: dk.cardSoft }}>
                  <MaterialCommunityIcons name={isDriver ? 'car-side' : 'bike-fast'} size={20} color={dk.accent} />
                </View>
              )}
              <View style={{ flex: 1, marginLeft: space.md }}>
                <T variant="label" weight="bold" numberOfLines={1} style={{ color: dk.text }}>
                  {vehicle || 'Your vehicle'}
                </T>
                <T variant="caption" style={{ color: dk.muted }}>
                  {profile?.licensePlate ?? ''}
                </T>
              </View>
              <LinkText
                label={uploadVehiclePhoto.isPending ? 'Uploading…' : profile?.vehiclePhotoUrl ? 'Change photo' : 'Add photo'}
                onPress={pickVehiclePhoto}
              />
            </View>
            {!profile?.vehiclePhotoUrl ? (
              <T variant="caption" style={{ color: dk.muted, marginTop: space.sm }}>
                Add a clear photo of your vehicle — customers see it the moment you accept.
              </T>
            ) : null}
            {uploadVehiclePhoto.isError ? (
              <T variant="caption" tone="error" style={{ marginTop: space.sm }}>
                Upload failed — try a different photo.
              </T>
            ) : null}
          </DCard>
        ) : null}

        {isDriver ? (
          <MmgPayLinkCard
            who="rides"
            dark
            value={profile?.mmgPayUrl}
            saving={saveMmgLink.isPending}
            onSave={(u) => saveMmgLink.mutate(u)}
          />
        ) : null}

        {/* Ops rows */}
        <DCard style={{ marginTop: space.md, paddingVertical: space.sm }}>
          <DRow icon="dollar-sign" label="Earnings" sub={`${money(allTime)} all-time · 100% yours`} onPress={() => navigation?.navigate?.('Earnings')} />
          <DRow icon="clock" label="Job history" sub="Every completed and cancelled job" onPress={() => navigation?.navigate?.('JobHistory')} />
          <DRow icon="file-text" label="Documents" sub="Licences, insurance and renewals" onPress={() => navigation?.navigate?.('MoverDocuments')} />
          <DRow
            icon="credit-card"
            label="Weekly fee"
            sub={sub ? `${money(sub.customRate ?? sub.weeklyRate)}/week` : 'Not active yet'}
            right={<TonePill label={subPill.label} tone={subPill.tone} dark />}
          />
          <DRow icon="refresh-cw" label="Switch app" sub="Swift · Swift Business" onPress={() => setSwitcherOpen(true)} />
        </DCard>

        {/* The model */}
        <DCard style={{ marginTop: space.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <MaterialCommunityIcons name="check-decagram" size={16} color={dk.success} />
            <T variant="body" weight="semibold" style={{ color: dk.text }}>
              You keep 100%
            </T>
          </View>
          <T variant="caption" style={{ color: dk.muted, marginTop: 4 }}>
            Swift only charges a flat weekly fee — no commission on any fare, ever. You&apos;re paid in cash, on every job.
          </T>
        </DCard>

        <PillButton label="Log out" variant="outline" style={{ marginTop: space.xl }} onPress={logout} />
      </ScrollView>

      <RoleSwitcherSheet visible={switcherOpen} current="mover" onClose={() => setSwitcherOpen(false)} />
    </View>
  );
}
