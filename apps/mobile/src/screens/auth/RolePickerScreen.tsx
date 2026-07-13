/** @jsxImportSource react */
import React from 'react';
import { Pressable, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { useAuthStore } from '../../stores/authStore';
import { DEFAULT_COUNTRY } from '../../lib/markets';
import { SwiftMark } from '../../components/SwiftLogo';
import { Card, IconChip, Screen, T } from '../../kit';

// Entry gate ("How will you use Swift?") — business rule, not a kit frame;
// composed from the kit's card + icon-chip language. Customer browses as a
// guest; mover/vendor go straight to sign-in.
const OPTIONS: {
  key: string;
  intent: 'customer' | 'mover' | 'vendor';
  moverPreset?: 'delivery' | 'taxi';
  icon: React.ComponentProps<typeof Feather>['name'];
  title: string;
  sub: string;
}[] = [
  { key: 'customer', intent: 'customer', icon: 'shopping-bag', title: 'Order with Swift', sub: 'Food, groceries, rides and more' },
  { key: 'rider', intent: 'mover', moverPreset: 'delivery', icon: 'package', title: 'Deliver as a rider', sub: 'Food, groceries and parcels — bike or motorcycle' },
  { key: 'taxi', intent: 'mover', moverPreset: 'taxi', icon: 'navigation', title: 'Drive as a taxi driver', sub: 'Passenger trips in your car' },
  { key: 'vendor', intent: 'vendor', icon: 'briefcase', title: 'Sell as a business', sub: 'Restaurants, stores and services' },
];

export function RolePickerScreen() {
  const setIntent = useAuthStore((s) => s.setIntent);
  const setMoverPreset = useAuthStore((s) => s.setMoverPreset);
  const setCountry = useAuthStore((s) => s.setCountry);
  const countryCode = useAuthStore((s) => s.countryCode);

  return (
    <Screen>
      <View style={{ flex: 1, paddingHorizontal: space['2xl'], paddingTop: space['2xl'] }}>
        <SwiftMark size={56} />
        <T variant="title" style={{ marginTop: space['3xl'] }}>
          How will you use Swift?
        </T>
        <T variant="body" tone="muted" style={{ marginTop: space.sm }}>
          Pick one to get going — you can switch any time.
        </T>

        <View style={{ gap: space.lg, marginTop: space['3xl'] }}>
          {OPTIONS.map((o) => (
            <Pressable
              key={o.key}
              onPress={() => {
                setMoverPreset(o.moverPreset ?? null);
                // Customer picks role → straight to browsing. Seed a market so
                // Home is never empty; useCustomerCountry then refines it from
                // device location. Earners pick a country on the next screen.
                if (o.intent === 'customer' && !countryCode) setCountry(DEFAULT_COUNTRY);
                setIntent(o.intent);
              }}
            >
              {({ pressed }) => (
                <Card
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space.lg,
                    opacity: pressed ? 0.8 : 1,
                  }}
                >
                  <IconChip icon={o.icon} size={52} />
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
              )}
            </Pressable>
          ))}
        </View>
      </View>
    </Screen>
  );
}
