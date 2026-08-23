/** @jsxImportSource react */
import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { color, radius, space, withAlpha } from '@swift/ui';
import { useAuthStore } from '../../stores/authStore';
import { useMoverPreview } from '../../stores/moverPreview';
import { useVendorPreview } from '../../stores/vendorPreview';
import { DEFAULT_COUNTRY } from '../../lib/markets';
import { SwiftMark } from '../../components/SwiftLogo';
import { Card, GradientMasthead, Pictogram, Screen, T, type PictogramName } from '../../kit';
import { VERTICAL_TINT } from '../../kit/vertical-tint';
import { PressableScale } from '../../components/ui';
import { haptic } from '../../lib/haptics';

// FIRST OPEN [first-open spec 2.1]: one screen, the TRIO, zero carousel —
// the same three cards, pictograms and copy family as the in-app switcher
// (one binary presenting as three apps). This screen exists ONLY for people
// the server doesn't know yet; "Already have an account? Sign in" routes by
// the account and skips the question forever (SO-4). Driver vehicle kind is
// chosen inside the driver application, not here.
// `tint` is the vertical's own identity colour [F-263 ramp]: the flagship keeps
// the house red, the driver takes the road's amber, business takes the shops
// plum. Three cards that look like three services, not three list rows.
const TRIO: {
  intent: 'customer' | 'mover' | 'vendor';
  pictogram: PictogramName;
  tint: PictogramName;
  title: string;
  sub: string;
  hint: string;
}[] = [
  {
    intent: 'customer',
    pictogram: 'groceries',
    tint: 'food',
    title: 'Swift',
    sub: 'Order food, groceries, rides and more',
    hint: 'Continue to customer browsing',
  },
  {
    intent: 'mover',
    pictogram: 'wheel',
    tint: 'taxi',
    title: 'Swift Driver',
    sub: 'Deliveries and taxi trips — you keep 100%',
    hint: 'Continue to driver setup',
  },
  {
    intent: 'vendor',
    pictogram: 'shops',
    tint: 'shops',
    title: 'Swift Business',
    sub: 'Run your store, menu and orders',
    hint: 'Continue to business setup',
  },
];

/** A funnel row inside the "just looking" card: icon, label, chevron. */
function QuietRow({
  icon,
  label,
  hint,
  testID,
  first = false,
  onPress,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  label: string;
  hint: string;
  testID: string;
  first?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={{
        // 44 is the floor, not the look: the row sits at 52 for the card's
        // rhythm and never below the touch-target minimum.
        minHeight: 44,
        height: 52,
        maxWidth: '100%',
        justifyContent: 'center',
        paddingHorizontal: space.lg,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: color.border.subtle,
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
    >
      {({ pressed }) => (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, opacity: pressed ? 0.6 : 1 }}>
          <View
            style={{
              width: 30,
              height: 30,
              borderRadius: 15,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: color.brand[50],
            }}
          >
            <Feather name={icon} size={15} color={color.brand[600]} />
          </View>
          <T variant="label" weight="semibold" style={{ flex: 1, flexShrink: 1 }}>
            {label}
          </T>
          <Feather name="chevron-right" size={17} color={color.text.muted} />
        </View>
      )}
    </Pressable>
  );
}

export function RolePickerScreen() {
  const insets = useSafeAreaInsets();
  const setIntent = useAuthStore((s) => s.setIntent);
  const setMoverPreset = useAuthStore((s) => s.setMoverPreset);
  const setCountry = useAuthStore((s) => s.setCountry);
  const countryCode = useAuthStore((s) => s.countryCode);
  const promptLogin = useAuthStore((s) => s.promptLogin);
  const enterPreview = useMoverPreview((s) => s.enterPreview);
  const enterVendorPreview = useVendorPreview((s) => s.enterPreview);

  const pick = (intent: 'customer' | 'mover' | 'vendor') => {
    haptic.select();
    setMoverPreset(null); // the driver application picks the vehicle kind
    // Customer picks role → straight to browsing. Seed a market so Home is
    // never empty; useCustomerCountry then refines it from device location.
    if (intent === 'customer' && !countryCode) setCountry(DEFAULT_COUNTRY);
    setIntent(intent);
  };

  return (
    <Screen bleed testID="role-picker-screen">
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1, paddingBottom: space['2xl'] + insets.bottom }}
        showsVerticalScrollIndicator={false}
      >
        {/* FIRST IMPRESSION: this screen used to open on plain white with a
            small mark in the corner, which read as a settings page rather than
            as Swift. It now opens the way every other Swift surface does — the
            brand wash under the 28dp curve — so the app introduces itself
            before it asks a question. Same mark, reversed for the red. */}
        <GradientMasthead
          style={{
            paddingTop: insets.top + space['2xl'],
            paddingHorizontal: space['2xl'],
            paddingBottom: space['3xl'],
          }}
        >
          <SwiftMark size={48} tint={color.white} accent={withAlpha(color.white, 0.7)} />
          <T variant="title" tone="onBrand" style={{ marginTop: space.xl }}>
            Welcome to Swift
          </T>
          <T variant="body" tone="onBrand" style={{ marginTop: space.sm, opacity: 0.92 }}>
            One account — pick where you&apos;re headed.
          </T>
        </GradientMasthead>

        <View style={{ paddingHorizontal: space['2xl'] }}>
          <View style={{ gap: space.lg, marginTop: space['2xl'] }}>
            {TRIO.map((o) => {
              const tint = VERTICAL_TINT[o.tint] ?? { bg: color.brand[50], ink: color.brand[600] };
              return (
                <PressableScale
                  key={o.intent}
                  testID={`role-picker-${o.intent}`}
                  onPress={() => pick(o.intent)}
                  accessibilityRole="button"
                  accessibilityLabel={`${o.title}. ${o.sub}`}
                  accessibilityHint={o.hint}
                >
                  <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
                    <View
                      style={{
                        width: 56,
                        height: 56,
                        borderRadius: radius.md,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: tint.bg,
                      }}
                    >
                      <Pictogram name={o.pictogram} size={30} color={tint.ink} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <T variant="body" weight="semibold">
                        {o.title}
                      </T>
                      <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
                        {o.sub}
                      </T>
                    </View>
                    <Feather name="chevron-right" size={20} color={color.text.muted} />
                  </Card>
                </PressableScale>
              );
            })}
          </View>

          {/* The account answers: sign in first and the trio question is never
              asked — the server's roles + last-used role route (SO-4). */}
          <Pressable
            testID="role-picker-sign-in"
            onPress={() => {
              haptic.select();
              if (!countryCode) setCountry(DEFAULT_COUNTRY);
              setIntent(null);
              promptLogin();
            }}
            style={{
              minHeight: 44,
              maxWidth: '100%',
              paddingHorizontal: space.sm,
              marginTop: space['2xl'],
              alignSelf: 'center',
              justifyContent: 'center',
            }}
            accessibilityRole="button"
            accessibilityLabel="Already have an account? Sign in"
            accessibilityHint="Open phone sign in"
          >
            {({ pressed }) => (
              <T
                variant="label"
                tone="muted"
                style={{ flexShrink: 1, textAlign: 'center', opacity: pressed ? 0.6 : 1 }}
              >
                Already have an account? <T variant="label" style={{ color: color.brand[600] }}>Sign in</T>
              </T>
            )}
          </Pressable>

          {/* Growth funnel: real dashboards with sample data (R3/R4) and the
              advertiser surface. They were three unlabelled links floating in
              the dead space under the fold, reading like debug shortcuts; a
              titled card keeps them quiet AND deliberate. Never co-equal with
              the trio. */}
          <T
            variant="micro"
            tone="muted"
            weight="semibold"
            style={{ marginTop: space['3xl'], marginBottom: space.sm, marginLeft: space.xs, letterSpacing: 0.8 }}
          >
            JUST LOOKING?
          </T>
          <Card pad={false}>
            <QuietRow
              first
              icon="eye"
              label="Preview the driver app"
              hint="Open a read-only sample driver dashboard"
              testID="role-picker-preview-driver"
              onPress={() => {
                setMoverPreset('taxi');
                enterPreview('DRIVER');
                setIntent('mover');
              }}
            />
            <QuietRow
              icon="eye"
              label="Preview a business dashboard"
              hint="Open a read-only sample business dashboard"
              testID="role-picker-preview-business"
              onPress={() => {
                enterVendorPreview('RESTAURANT');
                setIntent('vendor');
              }}
            />
            <QuietRow
              icon="tv"
              label="Advertise on Swift"
              hint="Open Swift advertising"
              testID="role-picker-advertiser"
              onPress={() => setIntent('advertiser')}
            />
          </Card>
        </View>
      </ScrollView>
    </Screen>
  );
}
