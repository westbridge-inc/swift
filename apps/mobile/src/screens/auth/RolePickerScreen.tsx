/** @jsxImportSource react */
import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { useAuthStore } from '../../stores/authStore';
import { useMoverPreview } from '../../stores/moverPreview';
import { useVendorPreview } from '../../stores/vendorPreview';
import { DEFAULT_COUNTRY } from '../../lib/markets';
import { SwiftMark } from '../../components/SwiftLogo';
import { Card, Pictogram, Screen, T, type PictogramName } from '../../kit';
import { PressableScale } from '../../components/ui';
import { haptic } from '../../lib/haptics';

// FIRST OPEN [first-open spec 2.1]: one screen, the TRIO, zero carousel —
// the same three cards, pictograms and copy family as the in-app switcher
// (one binary presenting as three apps). This screen exists ONLY for people
// the server doesn't know yet; "Already have an account? Sign in" routes by
// the account and skips the question forever (SO-4). Driver vehicle kind is
// chosen inside the driver application, not here.
const TRIO: {
  intent: 'customer' | 'mover' | 'vendor';
  pictogram: PictogramName;
  title: string;
  sub: string;
  hint: string;
}[] = [
  {
    intent: 'customer',
    pictogram: 'groceries',
    title: 'Swift',
    sub: 'Order food, groceries, rides and more',
    hint: 'Continue to customer browsing',
  },
  {
    intent: 'mover',
    pictogram: 'wheel',
    title: 'Swift Driver',
    sub: 'Deliveries and taxi trips — you keep 100%',
    hint: 'Continue to driver setup',
  },
  {
    intent: 'vendor',
    pictogram: 'shops',
    title: 'Swift Business',
    sub: 'Run your store, menu and orders',
    hint: 'Continue to business setup',
  },
];

function QuietRow({
  icon,
  label,
  hint,
  onPress,
}: {
  icon: React.ComponentProps<typeof Feather>['name'];
  label: string;
  hint: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        minHeight: 44,
        maxWidth: '100%',
        paddingHorizontal: space.sm,
        alignSelf: 'center',
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs,
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
    >
      {({ pressed }) => (
        <>
          <Feather name={icon} size={16} color={color.brand[600]} style={{ opacity: pressed ? 0.6 : 1 }} />
          <T
            variant="label"
            style={{ flexShrink: 1, color: color.brand[600], opacity: pressed ? 0.6 : 1 }}
          >
            {label}
          </T>
        </>
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
    <Screen>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: space['2xl'],
          paddingTop: space['2xl'],
          paddingBottom: space['2xl'] + insets.bottom,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Grow on tall screens to keep the footer low, while retaining the
            original top alignment and scrolling naturally when space is tight. */}
        <View style={{ flexGrow: 1 }}>
          <SwiftMark size={56} />
          <T variant="title" style={{ marginTop: space['3xl'] }}>
            Welcome to Swift
          </T>
          <T variant="body" tone="muted" style={{ marginTop: space.sm }}>
            One account — pick where you&apos;re headed.
          </T>

          <View style={{ gap: space.lg, marginTop: space['3xl'] }}>
            {TRIO.map((o) => (
              <PressableScale
                key={o.intent}
                onPress={() => pick(o.intent)}
                accessibilityRole="button"
                accessibilityLabel={`${o.title}. ${o.sub}`}
                accessibilityHint={o.hint}
              >
                <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
                  <View
                    style={{
                      width: 52,
                      height: 52,
                      borderRadius: radius.md,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: color.brand[50],
                    }}
                  >
                    <Pictogram name={o.pictogram} size={28} color={color.brand[600]} />
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
            ))}
          </View>

          {/* The account answers: sign in first and the trio question is never
              asked — the server's roles + last-used role route (SO-4). */}
          <Pressable
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
        </View>

        {/* Growth funnel rows: real dashboards with sample data (R3/R4) and
            the advertiser surface — quiet, never co-equal with the trio. */}
        <View style={{ gap: space.lg, marginTop: space['3xl'] }}>
          <QuietRow
            icon="eye"
            label="Preview the driver app"
            hint="Open a read-only sample driver dashboard"
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
            onPress={() => {
              enterVendorPreview('RESTAURANT');
              setIntent('vendor');
            }}
          />
          <QuietRow
            icon="tv"
            label="Advertise on Swift"
            hint="Open Swift advertising"
            onPress={() => setIntent('advertiser')}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}
