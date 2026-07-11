/** @jsxImportSource react */
import React from 'react';
import { Pressable, View } from 'react-native';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { PopupCard, T, TonePill } from '../kit';
import { useAuthStore } from '../stores/authStore';

type Intent = 'customer' | 'mover' | 'vendor';

// One Swift account, three apps-within-the-app. Switching is IN CONTEXT —
// you pick the app you're opening, never bounce through onboarding. The
// root navigator handles the rest (sign-in for earner surfaces, onboarding
// for accounts that don't hold the role yet).
const APPS: {
  intent: Intent;
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  title: string;
  sub: string;
}[] = [
  { intent: 'customer', icon: 'shopping-outline', title: 'Swift', sub: 'Order food, groceries, rides and more' },
  { intent: 'mover', icon: 'steering', title: 'Swift Driver', sub: 'Deliveries and taxi trips — you keep 100%' },
  { intent: 'vendor', icon: 'storefront-outline', title: 'Swift Business', sub: 'Run your store, menu and orders' },
];

export function RoleSwitcherSheet({
  visible,
  current,
  onClose,
}: {
  visible: boolean;
  current: Intent;
  onClose: () => void;
}) {
  const setIntent = useAuthStore((s) => s.setIntent);

  const pick = (intent: Intent) => {
    onClose();
    if (intent !== current) setIntent(intent);
  };

  return (
    <PopupCard visible={visible} onClose={onClose}>
      <T variant="title" center>
        Switch app
      </T>
      <T variant="label" tone="muted" center style={{ marginTop: space.sm }}>
        One account — pick where you&apos;re headed.
      </T>

      <View style={{ alignSelf: 'stretch', gap: space.md, marginTop: space.xl }}>
        {APPS.map((app) => {
          const active = app.intent === current;
          return (
            <Pressable key={app.intent} onPress={() => pick(app.intent)} disabled={active}>
              {({ pressed }) => (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space.md,
                    borderRadius: radius.lg,
                    borderWidth: 1,
                    borderColor: active ? color.brand[500] : color.border.subtle,
                    backgroundColor: active ? color.brand[50] : pressed ? color.surface.subtle : color.surface.base,
                    padding: space.lg,
                  }}
                >
                  <View
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: radius.md,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: active ? color.brand[500] : color.brand[50],
                    }}
                  >
                    <MaterialCommunityIcons name={app.icon} size={22} color={active ? color.white : color.brand[600]} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <T variant="body" weight="bold">
                      {app.title}
                    </T>
                    <T variant="caption" tone="muted" numberOfLines={1} style={{ marginTop: 1 }}>
                      {app.sub}
                    </T>
                  </View>
                  {active ? (
                    <TonePill label="You're here" tone="brand" />
                  ) : (
                    <Feather name="chevron-right" size={18} color={color.text.muted} />
                  )}
                </View>
              )}
            </Pressable>
          );
        })}
      </View>
    </PopupCard>
  );
}
