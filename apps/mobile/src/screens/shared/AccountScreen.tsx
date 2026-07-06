import { useState } from 'react';
import { View, ScrollView, Share } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { color } from '@swift/ui';
import { Text, Heading, Badge, Button, ConfirmDialog, SettingsGroup, SettingsRow } from '../../components/ui';
import { useAuthStore } from '../../stores/authStore';
import { useProfile, useAddresses } from '../../hooks';
import { mediaUrl } from '../../lib/images';

export function AccountScreen({ navigation }: any) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (!isAuthenticated) return <GuestAccount />;
  return <SignedInAccount navigation={navigation} />;
}

/** Guests can browse everything; the Account tab is their door to signing in. */
function GuestAccount() {
  const promptLogin = useAuthStore((s) => s.promptLogin);
  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-surface-subtle">
      <View className="px-lg pb-sm pt-md">
        <Heading size="2xl">Account</Heading>
      </View>
      <View className="flex-1 items-center justify-center px-2xl">
        <View className="h-16 w-16 items-center justify-center rounded-full" style={{ backgroundColor: color.brand[50] }}>
          <MaterialCommunityIcons name="account-circle-outline" size={34} color={color.brand[500]} />
        </View>
        <Heading size="xl" className="mt-lg text-center">Sign in to Swift</Heading>
        <Text className="mt-xs text-center text-text-secondary">
          Browse freely — create an account to order, save places, and track deliveries.
        </Text>
        <View className="mt-xl w-full">
          <Button label="Sign in or create account" onPress={promptLogin} />
        </View>
        <Text className="mt-md text-center text-xs text-text-muted">No platform fees, ever. Cash on delivery.</Text>
      </View>
    </SafeAreaView>
  );
}

function SignedInAccount({ navigation }: any) {
  const { user, logout } = useAuthStore();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const { data: profile } = useProfile<any>();
  const { data: addresses } = useAddresses<any[]>();

  const firstName = profile?.firstName ?? user?.firstName ?? '';
  const lastName = profile?.lastName ?? user?.lastName ?? '';
  const phone = profile?.phone ?? user?.phone ?? '';
  const avatar = profile?.avatar ?? user?.avatar ?? null;
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
            {avatar ? (
              <Image
                source={{ uri: mediaUrl(avatar) ?? undefined }}
                style={{ width: 56, height: 56, borderRadius: 28 }}
                contentFit="cover"
              />
            ) : (
              <View className="h-14 w-14 items-center justify-center rounded-full 0" style={{ backgroundColor: color.brand[50] }}>
                <Text className="text-lg font-bold text-white">{initials}</Text>
              </View>
            )}
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
          <SettingsRow icon="logout" label="Log out" danger onPress={() => setConfirmLogout(true)} />
        </SettingsGroup>

        <Text className="mb-md mt-xs text-center text-xs text-text-muted">Swift · Guyana · v1.0</Text>
      </ScrollView>
      <ConfirmDialog
        open={confirmLogout}
        title="Log out?"
        body="You'll sign back in with your phone number."
        confirmLabel="Log out"
        destructive
        onConfirm={() => {
          setConfirmLogout(false);
          logout();
        }}
        onClose={() => setConfirmLogout(false)}
      />
    </SafeAreaView>
  );
}
