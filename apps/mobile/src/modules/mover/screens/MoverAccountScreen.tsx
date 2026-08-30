/** @jsxImportSource react */
import React from 'react';
import { ScrollView, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { Image } from 'expo-image';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { color, space } from '@swift/ui';
import { Card, Header, LinkText, PillButton, Screen, SettingsRow, T, TonePill } from '../../../kit';
import { MmgPayLinkCard } from '../../../components/MmgPayLinkCard';
import { driverApi } from '../../../services/api';
import { Stars } from '../../../kit/controls';
import { useMoverKind, useVerificationStatus, useEarningsSummary, useMoverSubscription, useUploadVehiclePhoto, useMoverStanding } from '../../../hooks';
import { StandingCard } from '../../../components/StandingCard';
import {
  AuthSessionBoundaryError,
  requireAuthSessionForPrincipal,
  requireAuthSessionSnapshot,
  useAuthStore,
} from '../../../stores/authStore';
import { RoleSwitcherSheet } from '../../../components/RoleSwitcherSheet';
import { useStepUp } from '../../../hooks/useStepUp';
import { isStepUpDismissed, serverMessage } from '../../../lib/stepUp';
import { toast } from '../../../kit/toast';
import { money } from '../../../lib/money';
import { mediaUrl } from '../../../lib/images';
import { BillingStatusBlock } from '../../../components/billing/BillingSurfaces';
import { useMoverPreview } from '../../../stores/moverPreview';

export function MoverAccountScreen({ navigation }: any) {
  const preview = useMoverPreview((state) => state.preview);
  const { user, logout } = useAuthStore();
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  const { kind, profile } = useMoverKind();
  const standingQ = useMoverStanding<any>(kind);
  const verified = (useVerificationStatus<any>('MOVER').data as any)?.roleVerified;
  const summaryQ = useEarningsSummary<any>(kind);
  const subQ = useMoverSubscription(kind);
  const allTime = (summaryQ.data as any)?.allTime?.total ?? 0;
  const uploadVehiclePhoto = useUploadVehiclePhoto(kind);
  const qc = useQueryClient();
  // [ALG-34] The MMG pay link is where the money goes: the server asks this
  // session to confirm it holds the phone (the code sheet), then STAGES the
  // change behind a cool-off with the old link live.
  const stepUp = useStepUp();
  const [mmgError, setMmgError] = React.useState<string | null>(null);
  const saveMmgLink = useMutation({
    mutationFn: stepUp.withStepUp((mmgPayUrl: string | null) => driverApi.updateProfile({ mmgPayUrl })),
    onMutate: () => setMmgError(null),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mover', 'driverProfile'] }),
    onError: (e: unknown) => {
      if (!isStepUpDismissed(e)) setMmgError(serverMessage(e, 'That link could not be saved. Check it and try again.'));
    },
  });
  const cancelPendingMmgLink = useMutation({
    mutationFn: () => driverApi.cancelPendingMmgLink(),
    onSuccess: () => {
      toast.success('Change cancelled', 'Your current link stays. Other devices were signed out.');
      void qc.invalidateQueries({ queryKey: ['mover', 'driverProfile'] });
    },
    onError: (e: unknown) => toast.error('Could not cancel', serverMessage(e, 'Try again in a moment.')),
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
    try {
      const owner = preview ? null : requireAuthSessionSnapshot();
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (owner) requireAuthSessionForPrincipal(owner);
      if (!perm.granted) return;
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 });
      if (owner) requireAuthSessionForPrincipal(owner);
      if (res.canceled || !res.assets?.[0]) return;
      const a = res.assets[0];
      uploadVehiclePhoto.mutate({
        uri: a.uri,
        name: a.fileName ?? 'vehicle.jpg',
        type: a.mimeType ?? 'image/jpeg',
        authSession: owner ?? undefined,
      });
    } catch (photoError) {
      if (!(photoError instanceof AuthSessionBoundaryError)) throw photoError;
    }
  };

  return (
    <Screen>
      <Header title="Account" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space['2xl'], paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
        {/* Profile */}
        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
          <View style={{ width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: color.brand[500] }}>
            <T variant="title" tone="onBrand">
              {initial}
            </T>
          </View>
          <View style={{ flex: 1 }}>
            <T variant="heading" numberOfLines={1}>
              {name}
            </T>
            <T variant="label" tone="muted" style={{ marginTop: 2 }}>
              {user?.phone ?? ''}
            </T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: 6 }}>
              <TonePill label={isDriver ? 'Driver' : 'Rider'} tone="neutral" />
              {rating ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                  <Stars value={Number(rating)} size={12} />
                  <T variant="caption" weight="bold" tone="muted">
                    {Number(rating).toFixed(1)}
                  </T>
                </View>
              ) : null}
              {verified ? <TonePill label="Verified" tone="success" /> : null}
            </View>
          </View>
        </Card>

        {/* Movement R9 — Standing (daily-folded; today's ratings never show) */}
        {standingQ.data ? (
          <View style={{ marginTop: space.md }}>
            <StandingCard data={standingQ.data} />
          </View>
        ) : null}

        {/* Vehicle — customers see this photo when you accept (§5) */}
        {vehicle || profile ? (
          <Card style={{ marginTop: space.md }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              {profile?.vehiclePhotoUrl ? (
                <Image source={{ uri: mediaUrl(profile.vehiclePhotoUrl) ?? undefined }} style={{ width: 64, height: 44, borderRadius: 8 }} contentFit="cover" />
              ) : (
                <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: color.brand[50] }}>
                  <MaterialCommunityIcons name={isDriver ? 'car-side' : 'bike-fast'} size={20} color={color.brand[600]} />
                </View>
              )}
              <View style={{ flex: 1, marginLeft: space.md }}>
                <T variant="label" weight="bold" numberOfLines={1}>
                  {vehicle || 'Your vehicle'}
                </T>
                <T variant="caption" tone="muted">
                  {profile?.licensePlate ?? ''}
                </T>
              </View>
              <LinkText
                label={uploadVehiclePhoto.isPending ? 'Uploading…' : profile?.vehiclePhotoUrl ? 'Change photo' : 'Add photo'}
                onPress={pickVehiclePhoto}
              />
            </View>
            {!profile?.vehiclePhotoUrl ? (
              <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
                Add a clear photo of your vehicle — customers see it the moment you accept.
              </T>
            ) : null}
            {uploadVehiclePhoto.isError ? (
              <T variant="caption" tone="error" style={{ marginTop: space.sm }}>
                Upload failed — try a different photo.
              </T>
            ) : null}
          </Card>
        ) : null}

        {isDriver ? (
          <MmgPayLinkCard
            who="rides"
            value={profile?.mmgPayUrl}
            pending={profile?.mmgPayUrlPending ? { url: profile.mmgPayUrlPending, applyAt: profile.mmgPayUrlApplyAt ?? null } : null}
            saving={saveMmgLink.isPending}
            cancelling={cancelPendingMmgLink.isPending}
            error={mmgError}
            onSave={(u) => saveMmgLink.mutate(u)}
            onCancelPending={() => cancelPendingMmgLink.mutate()}
          />
        ) : null}

        {/* Ops rows */}
        <Card style={{ marginTop: space.md, paddingVertical: space.sm }}>
          <SettingsRow icon="dollar-sign" label="Earnings" sub={`${money(allTime)} all-time · 100% yours`} onPress={() => navigation?.navigate?.('Earnings')} />
          <SettingsRow icon="clock" label="Job history" sub="Every completed and cancelled job" onPress={() => navigation?.navigate?.('JobHistory')} />
          <SettingsRow icon="file-text" label="Documents" sub="Licences, insurance and renewals" onPress={() => navigation?.navigate?.('MoverDocuments')} />
          <SettingsRow
            icon="credit-card"
            label="Weekly fee"
            // Dual-display law (USD pricing ③): when the platform prices in
            // USD, the server sends the composed line ("US$25.00 / week ·
            // GY$5,200 this week"); until then it's null and the local-only
            // line renders exactly as before.
            sub={sub ? (sub.usdDisplay?.line ?? `${money(sub.customRate ?? sub.weeklyRate)}/week`) : 'Not active yet'}
            right={<TonePill label={subPill.label} tone={subPill.tone} />}
          />
          <SettingsRow
            icon="hash"
            label="My Swift Number"
            sub="Pay the weekly fee at any MMG agent"
            onPress={() => navigation?.navigate?.('MySwiftNumber')}
          />
          <SettingsRow icon="life-buoy" label="Get help" sub="A human answers — safety, pay, account" onPress={() => navigation?.navigate?.('GetHelp')} />
          <SettingsRow icon="refresh-cw" label="Switch app" sub="Swift · Swift Business" onPress={() => setSwitcherOpen(true)} />
        </Card>

        {/* Honest billing status — wallet balance, grace deadline, or the
            paused block. Silent on a healthy account (the row above is the way
            in). */}
        <BillingStatusBlock sub={sub} onPay={() => navigation?.navigate?.('MySwiftNumber')} compact />

        {/* The model */}
        <Card style={{ marginTop: space.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <MaterialCommunityIcons name="check-decagram" size={16} color={color.success} />
            <T variant="body" weight="semibold">
              You keep 100%
            </T>
          </View>
          <T variant="caption" tone="muted" style={{ marginTop: 4 }}>
            Swift only charges a flat weekly fee — no commission on any fare, ever. You&apos;re paid in cash, on every job.
          </T>
        </Card>

        <PillButton label="Log out" variant="outline" style={{ marginTop: space.xl }} onPress={logout} />
      </ScrollView>

      <RoleSwitcherSheet visible={switcherOpen} current="mover" onClose={() => setSwitcherOpen(false)} />
      {stepUp.sheet}
    </Screen>
  );
}
