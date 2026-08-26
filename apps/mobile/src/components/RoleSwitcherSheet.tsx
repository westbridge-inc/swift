/** @jsxImportSource react */
import React from 'react';
import { Pressable, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { color, radius, space } from '@swift/ui';
import { DecorativeIcon, Pictogram, PopupCard, PopupTitle, T, TonePill, type PictogramName } from '../kit';
import {
  AuthSessionBoundaryError,
  getAuthSessionSnapshot,
  requireAuthSessionForPrincipal,
  requireAuthSessionSnapshot,
  useAuthStore,
} from '../stores/authStore';
import { customerApi } from '../services/api';
import { roleSwitchAuthorityPayload } from '../lib/roleLanding';
import { toast } from '../kit/toast';
import {
  canonicalMoverAuthority,
  clearMoverAuthorityCache,
} from '../lib/moverAuthorityCache';

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
  const setIntentIfCurrent = useAuthStore((s) => s.setIntentIfCurrent);
  const setUserIfCurrent = useAuthStore((s) => s.setUserIfCurrent);
  const queryClient = useQueryClient();
  const [switching, setSwitching] = React.useState(false);
  const user = useAuthStore((s) => s.user) as (Parameters<typeof setUserIfCurrent>[1] & {
    lastMoverRole?: string | null;
    driver?: unknown;
    rider?: unknown;
    vendorOwner?: unknown;
  }) | null;
  const roles: string[] = user?.roles ?? [];
  const owns = (intent: Intent): boolean => {
    if (intent === 'customer') return true;
    if (intent === 'mover') return roles.includes('MOVER') || roles.includes('DRIVER') || roles.includes('RIDER') || !!user?.driver || !!user?.rider;
    return roles.includes('VENDOR_OWNER') || !!user?.vendorOwner;
  };

  const pick = async (intent: Intent) => {
    if (switching) return;
    if (intent === current) {
      onClose();
      return;
    }
    const operationUser = useAuthStore.getState().user as typeof user;
    const operationRoles: string[] = operationUser?.roles ?? [];
    const owned = intent === 'customer'
      || (intent === 'mover'
        ? operationRoles.includes('MOVER')
          || operationRoles.includes('DRIVER')
          || operationRoles.includes('RIDER')
          || !!operationUser?.driver
          || !!operationUser?.rider
        : operationRoles.includes('VENDOR_OWNER') || !!operationUser?.vendorOwner);
    const payload = roleSwitchAuthorityPayload(
      current,
      intent,
      owned,
      operationRoles,
      operationUser?.lastMoverRole,
    );
    if (!payload) {
      const owner = getAuthSessionSnapshot();
      if (intent === 'mover') clearMoverAuthorityCache(queryClient);
      onClose();
      if (owner) setIntentIfCurrent(owner, intent);
      else setIntent(intent);
      return;
    }
    setSwitching(true);
    try {
      const owner = requireAuthSessionSnapshot();
      if (!operationUser || operationUser.id !== owner.userId) {
        throw new AuthSessionBoundaryError();
      }
      // The server takes an idle mover offline and blocks this transition when
      // a live job exists. Change navigation only after that authority check.
      const response = await customerApi.switchRole(payload, owner);
      requireAuthSessionForPrincipal(owner);
      if (current === 'mover' || intent === 'mover') {
        clearMoverAuthorityCache(queryClient);
      }
      const canonical = canonicalMoverAuthority(
        response?.data?.data,
        payload,
        operationUser.lastMoverRole,
      );
      if (!setUserIfCurrent(owner, {
        ...operationUser,
        ...canonical,
      } as unknown as Parameters<typeof setUserIfCurrent>[1])) {
        throw new AuthSessionBoundaryError();
      }
      if (!setIntentIfCurrent(owner, intent)) throw new AuthSessionBoundaryError();
      requireAuthSessionForPrincipal(owner);
      onClose();
    } catch (error: any) {
      if (error instanceof AuthSessionBoundaryError) return;
      toast.error(
        error?.response?.data?.error?.message
          ?? 'Couldn’t switch apps. Finish any active work and try again.',
      );
    } finally {
      setSwitching(false);
    }
  };

  return (
    <PopupCard visible={visible} onClose={onClose}>
      <PopupTitle variant="title" center>
        Switch app
      </PopupTitle>
      <T variant="label" tone="muted" center style={{ marginTop: space.sm }}>
        One account — pick where you&apos;re headed.
      </T>

      <View style={{ alignSelf: 'stretch', gap: space.md, marginTop: space.xl }}>
        {APPS.map((app) => {
          const active = app.intent === current;
          const owned = owns(app.intent);
          return (
            <Pressable key={app.intent} onPress={() => void pick(app.intent)} disabled={active || switching}>
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
                    <DecorativeIcon>
                      <Feather name="chevron-right" size={18} color={color.text.muted} />
                    </DecorativeIcon>
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
