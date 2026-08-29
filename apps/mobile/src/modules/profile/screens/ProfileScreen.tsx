/** @jsxImportSource react */
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, radius, space } from '@swift/ui';
import { haptic } from '../../../lib/haptics';
import { useMyRating, useProfile } from '../../../hooks/customer';
import { useAuthStore } from '../../../stores/authStore';
import { EmptyState, ErrorState, IconChip, LoadingBlock, PillButton, PopupCard, PopupTitle, Screen, SettingsRow, T, TrustHalo } from '../../../kit';
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
// (TrustHalo now lives in the kit [Wave 3 part 2 deferral] — promoted verbatim
// once #807 released this file.)

/** CONTENT SITS ON OPEN PAPER — read off the rendered design slides.
 *
 *  Account used to stack four white `Card` chassis down the page, so a screen
 *  that is nothing but a list of destinations read as four floating objects
 *  with shadows. In the design there is no card here at all: the rows sit
 *  directly on the paper and a HAIRLINE is all that separates neighbours. A
 *  card chassis is earned by exactly one thing in this app — a live
 *  interruption with a countdown — and a settings list is not that.
 *
 *  Nothing is wrapped, nothing is padded away: the group only draws the lines
 *  BETWEEN its children, so the first and last rows breathe against the
 *  section eyebrow and the next one. */
function RowGroup({ children }: { children: React.ReactNode }) {
  const rows = React.Children.toArray(children);
  return (
    <View>
      {rows.map((row, i) => (
        <React.Fragment key={i}>
          {i > 0 ? (
            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: color.border.subtle }} />
          ) : null}
          {row}
        </React.Fragment>
      ))}
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
      // A consent state you READ and flip in place — the switch is the
      // affordance, so the row goes plain. Chips mark destinations.
      plain
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
        {/* THE CHROME IS PAPER, NOT BRAND — read off the rendered design
            slides. Account opened on a full-bleed maroon slab with the
            person's name reversed out of it in white, and the avatar hanging
            off the curved hem below. There is no such slab in the design: the
            top of this screen is the same warm paper as the rest of it, the
            NAME is the ink display-face line, and the avatar simply sits
            BESIDE it. An identity banner announces the brand; this announces
            the person, which is whose screen it is.

            `GradientMasthead` is NOT deleted and is still exported from the kit (FG-2), but this screen was the last caller: it now has ZERO call sites app-wide and is dead code awaiting a founder decision. Logged as an FG-2 deletion candidate — not removed here. */}
        <Animated.View
          entering={FadeInDown.duration(320).reduceMotion(ReduceMotion.System)}
          style={{ paddingTop: insets.top + space.lg, paddingHorizontal: GUTTER }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
            {/* The camera chip is a REAL action (>=44 hit target with hitSlop)
                — it opens Personal data. It loses its maroon fill: on paper a
                control is white with a hairline edge, and maroon is spent on
                the one brand moment further down. */}
            <TrustHalo size={80} stroke={4} facts={facts.map((f) => f.on)}>
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
                    style={{ width: 64, height: 64, borderRadius: radius.full, backgroundColor: color.brand[50] }}
                  />
                ) : (
                  <View style={{ width: 64, height: 64, borderRadius: radius.full, backgroundColor: color.brand[50], alignItems: 'center', justifyContent: 'center' }}>
                    <T variant="title" tone="brand">{(name[0] ?? 'S').toUpperCase()}</T>
                  </View>
                )}
                <View style={{ position: 'absolute', right: -2, bottom: -2, width: 26, height: 26, borderRadius: radius.full, backgroundColor: color.surface.base, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: color.border.subtle }}>
                  <Feather name="camera" size={13} color={color.text.primary} />
                </View>
              </Pressable>
            </TrustHalo>
            <View style={{ flex: 1 }}>
              {/* Account's ONE display-face line — the person's name, in INK. */}
              <T variant="title" numberOfLines={1}>
                {name}
              </T>
              {memberSince ? (
                <T variant="caption" tone="muted" numberOfLines={1} style={{ marginTop: 2 }}>
                  With Swift since {memberSince} · {orders} order{orders === 1 ? '' : 's'}
                </T>
              ) : null}
            </View>
          </View>
          <T variant="caption" tone="muted" style={{ marginTop: space.md }}>
            {nextFact ? `${facts.filter((f) => f.on).length} of ${facts.length} — next: ${nextFact.label.toLowerCase()}` : 'Account complete'}
          </T>
        </Animated.View>

        <View style={{ paddingHorizontal: GUTTER }}>
          {/* THE CHIP MARKS A DESTINATION, NOT A LABEL. Every row here used
              to carry the same pale square, which made the chip wallpaper and
              flattened the whole list. Now: a row that takes you SOMEWHERE
              keeps its chip; a row that is a fact you read (your rating), a
              consent you flip in place, or a legal document you open gets no
              chip at all. Fewer chips, so a chip means something. */}

          {/* YOUR ACCOUNT */}
          <T variant="micro" tone="muted" style={{ marginTop: space['2xl'], marginBottom: space.sm }}>YOUR ACCOUNT</T>
          <RowGroup>
            <SettingsRow icon="user" label="Personal data" onPress={() => navigation.navigate('PersonalData')} />
            <SettingsRow icon="clipboard" label="My orders" onPress={() => navigation.navigate('OrdersHistory')} />
            <SettingsRow icon="heart" label="Favourites" onPress={() => navigation.navigate('Favorites')} />
            <SettingsRow icon="map-pin" label="My addresses" onPress={() => navigation.navigate('Addresses')} />
            <SettingsRow
              icon="users"
              label="Emergency contacts"
              // [S15] The people an SOS actually texts. The fan-out in
              // sos.service.ts has always reached VERIFIED contacts — and
              // there was no door in the app to add one, so the list was
              // empty for everybody and the alert reached nobody who knows
              // them. No count/status in the `sub` until the screen is open:
              // the profile payload does not carry it, and a guessed
              // "2 contacts" would be the UI lying about who gets called.
              sub="Who Swift texts if you raise an alert"
              onPress={() => navigation.navigate('EmergencyContacts')}
            />
            <SettingsRow
              icon="user-x"
              label="Blocked people"
              // [STORE-002] The block list has to be reachable from somewhere
              // calm. Blocking happens in the moment, inside a chat; UNDOING it
              // happens later, and a block nobody can find again is a trap for
              // the person who placed it. No count in `sub` for the same reason
              // as the row above — the profile payload does not carry one, and
              // a guessed number would be the UI lying about who is cut off.
              sub="People who cannot message or be matched with you"
              onPress={() => navigation.navigate('BlockedUsers')}
            />
            <SettingsRow
              icon="shield"
              label="Identity verification"
              // No status chip here on purpose: /customer/profile carries no
              // review state for a customer's ID submission, and a chip that
              // guessed "Pending" from a local flag would be the UI lying.
              // Registered as a FINDING — when the server returns the
              // submission status, it lands here and nowhere else.
              sub="Unlocks bigger orders and rides"
              onPress={() => navigation.navigate('IdentityVerification')}
            />
            <SettingsRow
              icon="star"
              // A fact about you, not a place — the value IS the row.
              plain
              label="Your rating"
              sub={myRating.data?.displayRating != null
                ? `${myRating.data.displayRating.toFixed(1)} · ${myRating.data.ratingBucket}`
                : 'No rating yet'}
              onPress={() => setRatingInfo(true)}
            />
          </RowGroup>

          {/* PRIVACY — reference and legal, so the whole section reads plain. */}
          <T variant="micro" tone="muted" style={{ marginTop: space.xl, marginBottom: space.sm }}>PRIVACY</T>
          <RowGroup>
            <MarketingConsentRow />
            <SettingsRow icon="file-text" plain label="Terms of service" onPress={() => openPayLink(`${API_URL}/legal/terms`)} />
            <SettingsRow icon="shield" plain label="Privacy policy" onPress={() => openPayLink(`${API_URL}/legal/privacy`)} />
          </RowGroup>

          {/* HELP */}
          <T variant="micro" tone="muted" style={{ marginTop: space.xl, marginBottom: space.sm }}>HELP</T>
          <RowGroup>
            <SettingsRow
              icon="bell"
              label="Notifications"
              sub={unread > 0 ? `${unread} unread` : undefined}
              onPress={() => navigation.navigate('Notifications')}
            />
            <SettingsRow icon="user-plus" label="Invite friends" onPress={() => navigation.navigate('InviteFriends')} />
            <SettingsRow icon="help-circle" label="FAQ" onPress={() => navigation.navigate('Faq')} />
            <SettingsRow icon="phone" label="Contact us" onPress={() => navigation.navigate('ContactUs')} />
          </RowGroup>

          {/* THE ONE BRAND MOMENT. Role switching sits apart from support — it
              changes WHO you are here. It was ONE MORE IDENTICAL ROW [F-263]:
              earning on Swift or opening a business is the largest thing a
              person can do in this app, and it read exactly like "FAQ".

              With the maroon slab gone from the top of the screen, maroon is
              free to mean something again — and this is the only place on
              Account that earns it. It is not a white card with a maroon
              square inside it any more; the whole block IS the brand, so the
              eye lands on it once, on a page that is otherwise ink on paper.
              The glyph chip rides the on-brand chrome tint, not a second
              colour. */}
          <Pressable
            onPress={() => { haptic.select(); setSwitcherOpen(true); }}
            accessibilityRole="button"
            accessibilityLabel="Switch app. Drive with Swift or sell on Swift."
            style={{ marginTop: space['3xl'] }}
          >
            {({ pressed }) => (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space.lg,
                  padding: space.lg,
                  borderRadius: radius.lg,
                  backgroundColor: pressed ? color.brand[600] : color.brand[500],
                }}
              >
                <View style={{ width: 44, height: 44, borderRadius: radius.full, backgroundColor: color.surface.onBrand, alignItems: 'center', justifyContent: 'center' }}>
                  <Feather name="refresh-ccw" size={20} color={color.white} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <T variant="title" tone="onBrand">Earn with Swift</T>
                  <T variant="caption" tone="onBrand">
                    Drive, deliver, or sell — switch to Swift Driver or Swift Business.
                  </T>
                </View>
                <Feather name="chevron-right" size={20} color={color.white} />
              </View>
            )}
          </Pressable>

          {/* Quiet [F-263]: a filled pill made LOG OUT the loudest element on
              the whole screen — the one thing a person is least likely to want
              and most likely to hit by accident. It is a way out, not an
              invitation. Now that the brand belongs to the switcher above, it
              drops the brand tint entirely and becomes a paper control with a
              hairline edge. The confirm sheet still carries the real decision. */}
          <PillButton
            label="Log out"
            icon="log-out"
            variant="outline"
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
