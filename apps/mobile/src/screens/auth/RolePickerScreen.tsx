/** @jsxImportSource react */
import React from 'react';
import { Pressable, View } from 'react-native';
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
}[] = [
  { intent: 'customer', pictogram: 'groceries', title: 'Swift', sub: 'Order food, groceries, rides and more' },
  { intent: 'mover', pictogram: 'wheel', title: 'Swift Driver', sub: 'Deliveries and taxi trips — you keep 100%' },
  { intent: 'vendor', pictogram: 'shops', title: 'Swift Business', sub: 'Run your store, menu and orders' },
];

function QuietRow({ icon, label, onPress }: { icon: React.ComponentProps<typeof Feather>['name']; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: space.xs }} hitSlop={10}>
      {({ pressed }) => (
        <>
          <Feather name={icon} size={16} color={color.brand[600]} style={{ opacity: pressed ? 0.6 : 1 }} />
          <T variant="label" style={{ color: color.brand[600], opacity: pressed ? 0.6 : 1 }}>
            {label}
          </T>
        </>
      )}
    </Pressable>
  );
}

export function RolePickerScreen() {
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
      <View style={{ flex: 1, paddingHorizontal: space['2xl'], paddingTop: space['2xl'] }}>
        <SwiftMark size={56} />
        <T variant="title" style={{ marginTop: space['3xl'] }}>
          Welcome to Swift
        </T>
        <T variant="body" tone="muted" style={{ marginTop: space.sm }}>
          One account — pick where you&apos;re headed.
        </T>

        <View style={{ gap: space.lg, marginTop: space['3xl'] }}>
          {TRIO.map((o) => (
            <PressableScale key={o.intent} onPress={() => pick(o.intent)}>
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
          style={{ marginTop: space['2xl'], alignSelf: 'center' }}
          hitSlop={10}
        >
          {({ pressed }) => (
            <T variant="label" tone="muted" style={{ opacity: pressed ? 0.6 : 1 }}>
              Already have an account? <T variant="label" style={{ color: color.brand[600] }}>Sign in</T>
            </T>
          )}
        </Pressable>

        <View style={{ flex: 1 }} />

        {/* Growth funnel rows: real dashboards with sample data (R3/R4) and
            the advertiser surface — quiet, never co-equal with the trio. */}
        <View style={{ gap: space.lg, marginBottom: space['2xl'] }}>
          <QuietRow
            icon="eye"
            label="Preview the driver app"
            onPress={() => {
              setMoverPreset('taxi');
              enterPreview('DRIVER');
              setIntent('mover');
            }}
          />
          <QuietRow
            icon="eye"
            label="Preview a business dashboard"
            onPress={() => {
              enterVendorPreview('RESTAURANT');
              setIntent('vendor');
            }}
          />
          <QuietRow icon="tv" label="Advertise on Swift" onPress={() => setIntent('advertiser')} />
        </View>
      </View>
    </Screen>
  );
}
