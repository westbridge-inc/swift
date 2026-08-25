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
import { Pictogram, Screen, T, type PictogramName } from '../../kit';
import { PressableScale } from '../../components/ui';
import { haptic } from '../../lib/haptics';

// FIRST OPEN [first-open spec 2.1]: one screen, the TRIO, zero carousel —
// the same three options, pictograms and copy family as the in-app switcher
// (one binary presenting as three apps). This screen exists ONLY for people
// the server doesn't know yet; "Already have an account? Sign in" routes by
// the account and skips the question forever (SO-4). Driver vehicle kind is
// chosen inside the driver application, not here.
//
// `tint` is the vertical's own identity colour [F-263 ramp] and is RETAINED
// here for the surfaces that still paint it — this screen no longer does.
// The 100× pass is explicit that the entry surface gets ONE accent, not three:
// giving each option its own hue made the door vibrate and made "choose a
// Swift" read as "choose a colour". The flagship alone wears the brand fill,
// exactly as the services grid on Home now does.
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

/** A funnel row in the "just looking" list: glyph, label, chevron. Open paper,
 *  hairline divider — the card chassis it used to sit in is gone, and so is the
 *  filled brand circle around the glyph. Maroon is reserved for the flagship
 *  and the primary action; a preview link is neither. */
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
        // 44 is the floor, not the look: the row sits at 56 for the list's
        // rhythm and never below the touch-target minimum.
        minHeight: 44,
        height: 56,
        maxWidth: '100%',
        justifyContent: 'center',
        borderTopWidth: first ? 0 : 1,
        borderTopColor: color.border.subtle,
      }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
    >
      {({ pressed }) => (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, opacity: pressed ? 0.6 : 1 }}>
          <Feather name={icon} size={18} color={color.text.primary} />
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
        {/* THE CHROME IS PAPER, NOT BRAND. This screen used to open on a
            full-bleed maroon slab with a reversed mark and white copy. There is
            no such slab anywhere in the design: the top of a screen is the same
            warm paper as the rest of it. So the door is now the mark in its own
            colours, one INK display-face line, and a muted sub-line — the same
            shape Home's header took when it stopped reaching for the masthead.
            `GradientMasthead` is NOT deleted and is still exported from the kit (FG-2), but this screen was the last caller: it now has ZERO call sites app-wide and is dead code awaiting a founder decision. Logged as an FG-2 deletion candidate — not removed here. */}
        <View
          style={{
            paddingTop: insets.top + space['3xl'],
            paddingHorizontal: space['2xl'],
            paddingBottom: space['2xl'],
          }}
        >
          <SwiftMark size={44} />
          <T variant="display" style={{ marginTop: space.xl }}>
            Welcome to Swift
          </T>
          <T variant="body" tone="muted" style={{ marginTop: space.sm }}>
            One account — pick where you&apos;re headed.
          </T>
        </View>

        <View style={{ paddingHorizontal: space['2xl'] }}>
          {/* THE TRIO, on open paper. Three maroon cards read as three adverts
              for the same brand; hairline-separated rows read as three doors.
              The list is delimited top and bottom by a rule, and nothing here
              is wrapped in a card — a card chassis is earned only by a live
              interruption with a countdown, and a question is not that. */}
          <View
            style={{
              borderTopWidth: 1,
              borderBottomWidth: 1,
              borderColor: color.border.subtle,
            }}
          >
            {TRIO.map((o, i) => {
              // ONE BRAND MOMENT. The flagship — plain "Swift", the customer
              // app most people are here for — wears the brand fill and
              // reverses its pictogram out of it. Driver and Business sit on
              // the same quiet ground with ink pictograms, so the screen has a
              // first answer instead of three competing ones.
              const flagship = o.intent === 'customer';
              return (
                <View
                  key={o.intent}
                  style={{ borderTopWidth: i === 0 ? 0 : 1, borderTopColor: color.border.subtle }}
                >
                  <PressableScale
                    testID={`role-picker-${o.intent}`}
                    onPress={() => pick(o.intent)}
                    accessibilityRole="button"
                    accessibilityLabel={`${o.title}. ${o.sub}`}
                    accessibilityHint={o.hint}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: space.lg,
                      minHeight: 44,
                      paddingVertical: space.xl,
                    }}
                  >
                    <View
                      style={{
                        width: 52,
                        height: 52,
                        borderRadius: radius.lg,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: flagship ? color.brand[500] : color.surface.sunken,
                      }}
                    >
                      <Pictogram
                        name={o.pictogram}
                        size={28}
                        color={flagship ? color.white : color.text.primary}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <T variant="heading">{o.title}</T>
                      <T variant="caption" tone="muted" style={{ marginTop: space.xs / 2 }}>
                        {o.sub}
                      </T>
                    </View>
                    <Feather name="chevron-right" size={20} color={color.text.muted} />
                  </PressableScale>
                </View>
              );
            })}
          </View>

          {/* The account answers: sign in first and the trio question is never
              asked — the server's roles + last-used role route (SO-4). The
              action reads in INK, not maroon: the flagship already spent this
              screen's one brand moment, and a second one would make the two
              compete at the door. */}
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
                Already have an account?{' '}
                <T variant="label" weight="semibold">
                  Sign in
                </T>
              </T>
            )}
          </Pressable>

          {/* Growth funnel: real dashboards with sample data (R3/R4) and the
              advertiser surface. They were three unlabelled links floating in
              the dead space under the fold, reading like debug shortcuts; a
              titled, hairline-ruled list keeps them quiet AND deliberate.
              Never co-equal with the trio. */}
          <T
            variant="micro"
            tone="muted"
            weight="semibold"
            style={{ marginTop: space['3xl'], marginBottom: space.sm, letterSpacing: 0.8 }}
          >
            JUST LOOKING?
          </T>
          <View style={{ borderTopWidth: 1, borderBottomWidth: 1, borderColor: color.border.subtle }}>
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
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}
