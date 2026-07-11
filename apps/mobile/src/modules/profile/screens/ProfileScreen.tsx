/** @jsxImportSource react */
import React, { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { color, space } from '@swift/ui';
import { useProfile } from '../../../hooks/customer';
import { useAuthStore } from '../../../stores/authStore';
import { EmptyState, IconChip, PillButton, PopupCard, Screen, SettingsRow, T } from '../../../kit';
import { RoleSwitcherSheet } from '../../../components/RoleSwitcherSheet';

const GUTTER = space['2xl'];

// Kit Profile (49) + logout popup (51). Sections in the kit's icon-chip row
// language; every row lands on a real screen/flow. Dark mode (kit "Dart
// Mode") is omitted — the app ships light-only.
export function ProfileScreen() {
  const navigation = useNavigation<any>();
  const { isAuthenticated, promptLogin, logout, user } = useAuthStore();
  const profile = useProfile<any>();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  if (!isAuthenticated) {
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
      <PopupCard visible={confirmLogout} onClose={() => setConfirmLogout(false)}>
        <IconChip icon="log-out" size={56} />
        <T variant="heading" center style={{ marginTop: space.md }}>
          Log out of Swift?
        </T>
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
