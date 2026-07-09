import React from 'react';
import { Pressable, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, space } from '@swift/ui';
import { useAuthStore } from '../../stores/authStore';
import { SwiftMark } from '../../components/SwiftLogo';
import { Card, IconChip, Screen, T } from '../../kit';

// Entry gate ("How will you use Swift?") — business rule, not a kit frame;
// composed from the kit's card + icon-chip language. Customer browses as a
// guest; mover/vendor go straight to sign-in.
const OPTIONS: {
  intent: 'customer' | 'mover' | 'vendor';
  icon: React.ComponentProps<typeof Feather>['name'];
  title: string;
  sub: string;
}[] = [
  { intent: 'customer', icon: 'shopping-bag', title: 'Order with Swift', sub: 'Food, groceries, rides and more' },
  { intent: 'mover', icon: 'navigation', title: 'Earn as a driver or rider', sub: 'Deliveries and taxi trips, your schedule' },
  { intent: 'vendor', icon: 'briefcase', title: 'Sell as a business', sub: 'Restaurants, stores and services' },
];

export function RolePickerScreen() {
  const setIntent = useAuthStore((s) => s.setIntent);

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
            <Pressable key={o.intent} onPress={() => setIntent(o.intent)}>
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
