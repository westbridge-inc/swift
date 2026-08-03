/** @jsxImportSource react */
import React from 'react';
import { Pressable, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { Pictogram, PopupCard, T, TonePill, type PictogramName } from '../kit';
import { useAuthStore } from '../stores/authStore';
import { customerApi } from '../services/api';
import { switchRolePayload } from '../lib/roleLanding';

type Intent = 'customer' | 'mover' | 'vendor';

// One Swift account, three apps-within-the-app [first-open spec 2.2]. All
// three cards ALWAYS show: owned roles switch instantly; un-owned roles read
// as an invitation and open that path's JOIN flow (the root navigator routes
// sign-in/onboarding) — one system for switching AND growth. Switching an
// owned surface also tells the server (activeRole = last-used), so the next
// sign-in on any device lands right. Pictogram trio per design-100×: the
// basket, the wheel, the awning.
const APPS: {
  intent: Intent;
  pictogram: PictogramName;
  title: string;
  sub: string;
  invite?: string;
}[] = [
  { intent: 'customer', pictogram: 'groceries', title: 'Swift', sub: 'Order food, groceries, rides and more' },
  {
    intent: 'mover',
    pictogram: 'wheel',
    title: 'Swift Driver',
    sub: 'Deliveries and taxi trips — you keep 100%',
    invite: 'Become a driver — keep 100% of every fare',
  },
  {
    intent: 'vendor',
    pictogram: 'shops',
    title: 'Swift Business',
    sub: 'Run your store, menu and orders',
    invite: 'Put your store on Swift',
  },
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
  const user = useAuthStore((s) => s.user) as { roles?: string[]; driver?: unknown; rider?: unknown; vendorOwner?: unknown } | null;
  const roles: string[] = user?.roles ?? [];
  const owns = (intent: Intent): boolean => {
    if (intent === 'customer') return true;
    if (intent === 'mover') return roles.includes('DRIVER') || roles.includes('RIDER') || !!user?.driver || !!user?.rider;
    return roles.includes('VENDOR_OWNER') || !!user?.vendorOwner;
  };

  const pick = (intent: Intent) => {
    onClose();
    if (intent === current) return;
    setIntent(intent);
    // Owned switch → the server remembers last-used (fire-and-forget; the
    // join flow for un-owned roles registers the role itself).
    if (owns(intent)) {
      const payload = switchRolePayload(intent, roles);
      if (payload) void customerApi.switchRole(payload).catch(() => undefined);
    }
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
          const owned = owns(app.intent);
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
                    <Pictogram name={app.pictogram} size={24} color={active ? color.white : color.brand[600]} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <T variant="body" weight="bold">
                      {app.title}
                    </T>
                    <T variant="caption" tone="muted" numberOfLines={1} style={{ marginTop: 1 }}>
                      {owned || !app.invite ? app.sub : app.invite}
                    </T>
                  </View>
                  {active ? (
                    <TonePill label="You're here" tone="brand" />
                  ) : owned ? (
                    <Feather name="chevron-right" size={18} color={color.text.muted} />
                  ) : (
                    <TonePill label="Join" tone="neutral" />
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
