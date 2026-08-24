/** @jsxImportSource react */
import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, radius, space } from '@swift/ui';
import { haptic } from '../../../lib/haptics';
import { useMyRating, useProfile } from '../../../hooks/customer';
import { useAuthStore } from '../../../stores/authStore';
import { Card, EmptyState, ErrorState, GradientMasthead, IconChip, LoadingBlock, PillButton, PopupCard, PopupTitle, Screen, SettingsRow, T } from '../../../kit';
import Svg, { Circle } from 'react-native-svg';
import Animated, { FadeInDown, ReduceMotion } from 'react-native-reanimated';
import { RoleSwitcherSheet } from '../../../components/RoleSwitcherSheet';
import { API_URL, customerApi } from '../../../services/api';
import { openPayLink } from '../../../lib/payLink';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BrandSwitch } from '../../../kit/controls';

const GUTTER = space['2xl'];

// Kit Profile (49) + logout popup (51). Sections in the kit's icon-chip row
// language; every row lands on a real screen/flow. Dark mode (kit "Dart
// Mode") is omitted — the app ships light-only.
/** [design-100x Flow-8 signature] THE TRUST HALO — a segmented ring around
 *  the avatar where every lit segment is a REAL account fact (phone verified ·
 *  selfie on file · first order placed). Never decorative: unlit segments are
 *  the honest to-do list, and the caption names the next one. */
function TrustHalo({ size, stroke, facts, children }: {
  size: number; stroke: number; facts: boolean[]; children: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const seg = c / facts.length;
  const gap = 8;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
        {facts.map((on, i) => (
          <Circle
            key={i}
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={on ? color.success : color.brand[100]}
            strokeWidth={stroke}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${seg - gap} ${c - seg + gap}`}
            strokeDashoffset={-i * seg}
          />
        ))}
      </Svg>
      {children}
    </View>
  );
}

/** [DCR-1 NR1-03] Marketing messages toggle — the row the served consent
 *  text promises ("Account -> Marketing messages"). The switch reflects the
 *  ledger's current state; a flip is a new append-only consent row. */
function MarketingConsentRow() {
  const qc = useQueryClient();
  const consent = useQuery({
    queryKey: ['consent'],
    queryFn: async () => (await customerApi.getConsent()).data.data as {
      consents: { documentType: string; state: string | null }[];
    },
    staleTime: 60_000,
  });
  const marketingState = consent.data?.consents.find((c) => c.documentType === 'marketing_consent')?.state;
  const granted = marketingState === 'granted' || marketingState === 're_granted';
  const toggle = useMutation({
    mutationFn: (next: boolean) => customerApi.setMarketingConsent(next),
    onSettled: () => qc.invalidateQueries({ queryKey: ['consent'] }),
  });
  return (
    <SettingsRow
      icon="gift"
      label="Marketing messages"
      sub={granted ? 'On — offers and promos' : 'Off — service messages only'}
      onPress={() => openPayLink(`${API_URL}/legal/marketing`)}
      right={
        <BrandSwitch
          value={toggle.isPending ? !granted : granted}
          disabled={consent.isLoading || toggle.isPending}
          onChange={(next) => toggle.mutate(next)}
        />
      }
    />
  );
}

export function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const { isAuthenticated, promptLogin, logout, user, setIntent } = useAuthStore();
  const profile = useProfile<any>();
  const myRating = useMyRating();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [ratingInfo, setRatingInfo] = useState(false);
  const [avatarBroken, setAvatarBroken] = useState(false);
  // [F-022-18] a failure latch must clear when the URL changes (new selfie).
  const avatarKey = (profile.data as { avatar?: string } | undefined)?.avatar ?? user?.avatar ?? '';
  React.useEffect(() => { setAvatarBroken(false); }, [avatarKey]);

  if (!isAuthenticated) {
    // A guest is never trapped [first-open 2.2 / SPS-F-0024]: every other
    // surface can leave (MoverStack, VendorStack, advertiserExit all
    // setIntent(null)) — the customer surface must too. "Back to the welcome
    // screen" re-opens the trio; "Switch app" is the same sheet members get,
    // whose un-owned cards read as join invitations.
    return (
      <Screen>
        <View style={{ height: 56, alignItems: 'center', justifyContent: 'center' }}>
          <T variant="heading">Profile</T>
        </View>
        <EmptyState
          icon="user"
          title="You’re browsing as a guest"
          body="Sign in to see your orders, addresses and favorites."
          actionLabel="Sign In"
          onAction={promptLogin}
        />
        <View style={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}>
          <SettingsRow
            icon="refresh-ccw"
            label="Switch app"
            sub="Swift Driver · Swift Business"
            onPress={() => setSwitcherOpen(true)}
          />
          <SettingsRow
            icon="arrow-left"
            label="Back to the welcome screen"
            sub="Choose again how you’ll use Swift"
            onPress={() => setIntent(null)}
          />
        </View>
        <RoleSwitcherSheet visible={switcherOpen} current="customer" onClose={() => setSwitcherOpen(false)} />
      </Screen>
    );
  }

  if (profile.isLoading) {
    return (
      <Screen>
        <LoadingBlock />
      </Screen>
    );
  }
  if (profile.isError) {
    // [REPORT-022 F-022-19] An API failure must never trap the session: the
    // account controls that don't depend on profile data stay reachable.
    return (
      <Screen>
        <ErrorState onRetry={() => profile.refetch()} />
        <View style={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'], gap: space.md }}>
          <PillButton label="Switch app" variant="soft" onPress={() => setSwitcherOpen(true)} />
          <PillButton label="Log out" icon="log-out" variant="soft" onPress={() => setConfirmLogout(true)} />
        </View>
        <RoleSwitcherSheet visible={switcherOpen} current="customer" onClose={() => setSwitcherOpen(false)} />
        <PopupCard visible={confirmLogout} onClose={() => setConfirmLogout(false)}>
          <IconChip icon="log-out" size={56} />
          <PopupTitle variant="heading" center style={{ marginTop: space.md }}>
            Log out of Swift?
          </PopupTitle>
          <View style={{ alignSelf: 'stretch', gap: space.md, marginTop: space.xl }}>
            <PillButton label="Log out" size="md" onPress={() => { setConfirmLogout(false); logout(); }} />
            <PillButton label="Stay signed in" variant="soft" size="md" onPress={() => setConfirmLogout(false)} />
          </View>
        </PopupCard>
      </Screen>
    );
  }

  const p = profile.data;
  const name = `${p?.firstName ?? user?.firstName ?? ''} ${p?.lastName ?? user?.lastName ?? ''}`.trim() || 'Swift member';
  const rawAvatar = p?.avatar ?? user?.avatar;
  // [F-022-17] the API may return a relative path — normalize before Image.
  const avatar = rawAvatar && !/^https?:\/\//.test(rawAvatar) ? `${API_URL}${rawAvatar}` : rawAvatar;
  const orders = p?.customer?.totalOrders ?? 0;
  const unread = p?.unreadNotifications ?? 0;
  const memberSince = p?.createdAt ? new Date(p.createdAt).getFullYear() : null;
  // THE TRUST HALO's facts — every segment is real, unlit = the honest to-do.
  const facts: { on: boolean; label: string }[] = [
    { on: true, label: 'Phone verified' },
    { on: !!p?.selfieCapturedAt, label: 'Selfie on file' },
    { on: orders > 0, label: 'First order placed' },
  ];
  const nextFact = facts.find((f) => !f.on);

  return (
    <Screen bleed>
      <ScrollView contentContainerStyle={{ paddingBottom: space['3xl'] }} showsVerticalScrollIndicator={false}>
        {/* [Flow-8] Identity masthead: the person, grounded in the brand wash. */}
        <GradientMasthead style={{ paddingTop: insets.top + space.lg, paddingBottom: space['3xl'] + 44, paddingHorizontal: GUTTER }}>
          <T variant="micro" tone="onBrand">PROFILE</T>
          <T variant="title" tone="onBrand" numberOfLines={1} style={{ marginTop: 2 }}>
            {name}
          </T>
          {memberSince ? (
            <T variant="caption" tone="onBrand" style={{ marginTop: 2 }}>
              With Swift since {memberSince} · {orders} order{orders === 1 ? '' : 's'}
            </T>
          ) : null}
        </GradientMasthead>

        {/* Avatar + trust halo, overlapping the hem. The camera chip is a REAL
            action (>=44 hit target) — it opens Personal data. */}
        <Animated.View
          entering={FadeInDown.duration(320).reduceMotion(ReduceMotion.System)}
          style={{ alignItems: 'center', marginTop: -64 }}
        >
          <TrustHalo size={128} stroke={5} facts={facts.map((f) => f.on)}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Edit your photo and personal data"
              hitSlop={12}
              onPress={() => navigation.navigate('PersonalData')}
            >
              {avatar && !avatarBroken ? (
                <Image
                  source={{ uri: avatar }}
                  onError={() => setAvatarBroken(true)}
                  style={{ width: 104, height: 104, borderRadius: 52, backgroundColor: color.brand[50] }}
                />
              ) : (
                <View style={{ width: 104, height: 104, borderRadius: 52, backgroundColor: color.brand[50], alignItems: 'center', justifyContent: 'center' }}>
                  <T variant="display" tone="brand">{(name[0] ?? 'S').toUpperCase()}</T>
                </View>
              )}
              <View style={{ position: 'absolute', right: -2, bottom: -2, width: 34, height: 34, borderRadius: 17, backgroundColor: color.brand[500], alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: color.surface.subtle }}>
                <Feather name="camera" size={14} color={color.white} />
              </View>
            </Pressable>
          </TrustHalo>
          <T variant="caption" tone="muted" style={{ marginTop: space.sm }}>
            {nextFact ? `${facts.filter((f) => f.on).length} of ${facts.length} — next: ${nextFact.label.toLowerCase()}` : 'Account complete'}
          </T>
        </Animated.View>

        <View style={{ paddingHorizontal: GUTTER }}>
          {/* YOUR ACCOUNT */}
          <T variant="micro" tone="muted" style={{ marginTop: space['2xl'], marginBottom: space.sm }}>YOUR ACCOUNT</T>
          <Card>
            <SettingsRow icon="user" label="Personal data" onPress={() => navigation.navigate('PersonalData')} />
            <SettingsRow icon="clipboard" label="My orders" onPress={() => navigation.navigate('OrdersHistory')} />
            <SettingsRow icon="heart" label="Favourites" onPress={() => navigation.navigate('Favorites')} />
            <SettingsRow icon="map-pin" label="My addresses" onPress={() => navigation.navigate('Addresses')} />
            <SettingsRow
              icon="shield"
              label="Identity verification"
              sub="Unlocks bigger orders and rides"
              onPress={() => navigation.navigate('IdentityVerification')}
            />
            <SettingsRow
              icon="star"
              label="Your rating"
              sub={myRating.data?.displayRating != null
                ? `${myRating.data.displayRating.toFixed(1)} · ${myRating.data.ratingBucket}`
                : 'No rating yet'}
              onPress={() => setRatingInfo(true)}
            />
          </Card>

          {/* PRIVACY */}
          <T variant="micro" tone="muted" style={{ marginTop: space.xl, marginBottom: space.sm }}>PRIVACY</T>
          <Card>
            <MarketingConsentRow />
            <SettingsRow
              icon="slash"
              label="Blocked accounts"
              sub="Review or unblock accounts"
              onPress={() => navigation.navigate('BlockedUsers')}
            />
            <SettingsRow icon="file-text" label="Terms of service" onPress={() => openPayLink(`${API_URL}/legal/terms`)} />
            <SettingsRow icon="shield" label="Privacy policy" onPress={() => openPayLink(`${API_URL}/legal/privacy`)} />
          </Card>

          {/* HELP */}
          <T variant="micro" tone="muted" style={{ marginTop: space.xl, marginBottom: space.sm }}>HELP</T>
          <Card>
            <SettingsRow
              icon="bell"
              label="Notifications"
              sub={unread > 0 ? `${unread} unread` : undefined}
              onPress={() => navigation.navigate('Notifications')}
            />
            <SettingsRow icon="user-plus" label="Invite friends" onPress={() => navigation.navigate('InviteFriends')} />
            <SettingsRow icon="help-circle" label="FAQ" onPress={() => navigation.navigate('Faq')} />
            <SettingsRow icon="phone" label="Contact us" onPress={() => navigation.navigate('ContactUs')} />
          </Card>

          {/* Role switching sits apart from support — it changes WHO you are
              here. It was ONE MORE IDENTICAL ROW [F-263]: earning on Swift or
              opening a business is the largest thing a person can do in this
              app, and it read exactly like "FAQ". It gets the weight of the
              decision it is. */}
          <Pressable
            onPress={() => { haptic.select(); setSwitcherOpen(true); }}
            accessibilityRole="button"
            accessibilityLabel="Switch app. Drive with Swift or sell on Swift."
            style={{ marginTop: space.xl }}
          >
            {({ pressed }) => (
              <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg, opacity: pressed ? 0.85 : 1 }}>
                <View style={{ width: 48, height: 48, borderRadius: radius.lg, backgroundColor: color.brand[600], alignItems: 'center', justifyContent: 'center' }}>
                  <Feather name="refresh-ccw" size={22} color={color.white} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <T variant="title">Earn with Swift</T>
                  <T variant="caption" tone="muted">
                    Drive, deliver, or sell — switch to Swift Driver or Swift Business.
                  </T>
                </View>
                <Feather name="chevron-right" size={20} color={color.text.muted} />
              </Card>
            )}
          </Pressable>

          {/* Quiet [F-263]: a filled pill made LOG OUT the loudest element on
              the whole screen — the one thing a person is least likely to want
              and most likely to hit by accident. It is a way out, not an
              invitation. The confirm sheet still carries the real decision. */}
          <PillButton
            label="Log out"
            icon="log-out"
            variant="soft"
            onPress={() => setConfirmLogout(true)}
            style={{ marginTop: space['2xl'] }}
          />
        </View>
      </ScrollView>

      {/* Logout confirm (kit 51) */}
      {/* Movement R9 — why customers have a rating (aggregate-only honesty) */}
      <PopupCard visible={ratingInfo} onClose={() => setRatingInfo(false)}>
        <IconChip icon="star" size={56} />
        <PopupTitle variant="heading" center style={{ marginTop: space.md }}>
          {myRating.data?.displayRating != null ? `${myRating.data.displayRating.toFixed(1)} ${myRating.data.ratingBucket}` : 'No rating yet'}
        </PopupTitle>
        <T variant="label" tone="muted" center style={{ marginTop: space.sm }}>
          Drivers and riders rate their trips with you, the same way you rate them — respect runs both ways.
          Swift only ever shows the average, never who rated what.
        </T>
        <View style={{ alignSelf: 'stretch', marginTop: space.xl }}>
          <PillButton label="Got it" size="md" onPress={() => setRatingInfo(false)} />
        </View>
      </PopupCard>

      <PopupCard visible={confirmLogout} onClose={() => setConfirmLogout(false)}>
        <IconChip icon="log-out" size={56} />
        <PopupTitle variant="heading" center style={{ marginTop: space.md }}>
          Log out of Swift?
        </PopupTitle>
        <T variant="label" tone="muted" center style={{ marginTop: space.sm }}>
          Your cart and session leave this device; your account keeps everything.
        </T>
        <View style={{ alignSelf: 'stretch', gap: space.md, marginTop: space.xl }}>
          <PillButton
            label="Log Out"
            size="md"
            onPress={() => {
              setConfirmLogout(false);
              logout();
            }}
          />
          <PillButton label="Stay signed in" variant="soft" size="md" onPress={() => setConfirmLogout(false)} />
        </View>
      </PopupCard>

      <RoleSwitcherSheet visible={switcherOpen} current="customer" onClose={() => setSwitcherOpen(false)} />
    </Screen>
  );
}
