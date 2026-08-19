/** @jsxImportSource react */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { color, space } from '@swift/ui';
import { useMyRating, useProfile } from '../../../hooks/customer';
import { useAuthStore } from '../../../stores/authStore';
import { EmptyState, IconChip, PillButton, PopupCard, PopupTitle, Screen, SettingsRow, T } from '../../../kit';
import { RoleSwitcherSheet } from '../../../components/RoleSwitcherSheet';
import { API_URL, customerApi } from '../../../services/api';
import { openPayLink } from '../../../lib/payLink';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BrandSwitch } from '../../../kit/controls';

const GUTTER = space['2xl'];

// Kit Profile (49) + logout popup (51). Sections in the kit's icon-chip row
// language; every row lands on a real screen/flow. Dark mode (kit "Dart
// Mode") is omitted — the app ships light-only.
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
  const navigation = useNavigation<any>();
  const { isAuthenticated, promptLogin, logout, user, setIntent } = useAuthStore();
  const profile = useProfile<any>();
  const myRating = useMyRating();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [ratingInfo, setRatingInfo] = useState(false);

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

  const p = profile.data;
  const name = `${p?.firstName ?? user?.firstName ?? ''} ${p?.lastName ?? user?.lastName ?? ''}`.trim() || 'Swift member';
  const avatar = p?.avatar ?? user?.avatar;
  const orders = p?.customer?.totalOrders ?? 0;
  const unread = p?.unreadNotifications ?? 0;

  return (
    <Screen>
      <View style={{ height: 56, alignItems: 'center', justifyContent: 'center' }}>
        <T variant="heading">Profile</T>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: GUTTER, paddingBottom: space['3xl'] }}>
        {/* Centered identity (kit 49) */}
        <View style={{ alignItems: 'center', marginTop: space.md }}>
          <View>
            {avatar ? (
              <Image source={{ uri: avatar }} style={{ width: 120, height: 120, borderRadius: 60 }} />
            ) : (
              <View
                style={{
                  width: 120,
                  height: 120,
                  borderRadius: 60,
                  backgroundColor: color.brand[50],
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <T variant="display" tone="brand">
                  {(name[0] ?? 'S').toUpperCase()}
                </T>
              </View>
            )}
            <View
              style={{
                position: 'absolute',
                right: 0,
                bottom: 0,
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: color.brand[500],
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: 3,
                borderColor: color.surface.subtle,
              }}
            >
              <Feather name="camera" size={15} color={color.white} />
            </View>
          </View>
          <T variant="title" center style={{ marginTop: space.lg }}>
            {name}
          </T>
          <T variant="label" tone="muted" center style={{ marginTop: 2 }}>
            {orders} order{orders === 1 ? '' : 's'} with Swift
          </T>
        </View>

        {/* Profile section */}
        <T variant="label" tone="muted" style={{ marginTop: space['3xl'] }}>
          Profile
        </T>
        <View style={{ marginTop: space.sm }}>
          <SettingsRow icon="user" label="Personal Data" onPress={() => navigation.navigate('PersonalData')} />
          <SettingsRow icon="clipboard" label="My Orders" onPress={() => navigation.navigate('OrdersHistory')} />
          <SettingsRow icon="heart" label="Favorites" onPress={() => navigation.navigate('Favorites')} />
          <SettingsRow icon="map-pin" label="My Addresses" onPress={() => navigation.navigate('Addresses')} />
          <SettingsRow
            icon="shield"
            label="Identity Verification"
            sub="Unlocks bigger orders and rides"
            onPress={() => navigation.navigate('IdentityVerification')}
          />
          {/* Movement R9 — the customer's own aggregate (respect runs both ways) */}
          <SettingsRow
            icon="star"
            label="Your rating"
            sub={
              myRating.data?.displayRating != null
                ? `${myRating.data.displayRating.toFixed(1)} ${myRating.data.ratingBucket}`
                : 'New — builds as you order and ride'
            }
            onPress={() => setRatingInfo(true)}
          />
        </View>

        {/* Support section */}
        <T variant="label" tone="muted" style={{ marginTop: space['2xl'] }}>
          Support
        </T>
        <View style={{ marginTop: space.sm }}>
          <SettingsRow
            icon="bell"
            label="Notification"
            sub={unread > 0 ? `${unread} unread` : undefined}
            onPress={() => navigation.navigate('Notifications')}
          />
          <SettingsRow icon="user-plus" label="Invite Friends" onPress={() => navigation.navigate('InviteFriends')} />
          <SettingsRow icon="help-circle" label="FAQ" onPress={() => navigation.navigate('Faq')} />
          <SettingsRow icon="phone" label="Contact Us" onPress={() => navigation.navigate('ContactUs')} />
          <SettingsRow icon="file-text" label="Terms of Service" onPress={() => openPayLink(`${API_URL}/legal/terms`)} />
          <SettingsRow icon="shield" label="Privacy Policy" onPress={() => openPayLink(`${API_URL}/legal/privacy`)} />
          <MarketingConsentRow />
          <SettingsRow
            icon="refresh-ccw"
            label="Switch app"
            sub="Swift Driver · Swift Business"
            onPress={() => setSwitcherOpen(true)}
          />
        </View>

        <PillButton
          label="Log Out"
          icon="log-out"
          variant="soft"
          onPress={() => setConfirmLogout(true)}
          style={{ marginTop: space['2xl'] }}
        />
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
