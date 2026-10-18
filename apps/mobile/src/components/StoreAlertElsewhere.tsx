/** @jsxImportSource react */
import React from 'react';
import { Vibration } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
import { DecorativeIcon, LinkText, PillButton, PopupCard, PopupTitle, T } from '../kit';
import { useAuthStore } from '../stores/authStore';
import { accountHoldsRole, type Intent } from '../lib/roleLanding';
import { connectSocket, getSocket } from '../services/socket';
import { routeNotificationData, setBusinessTapElsewhereHandler } from '../services/notification-router';
import { useRoleSwitch } from './RoleSwitcherSheet';

// ---------------------------------------------------------------------------
// [STORE-ALERT 18 Oct 2026] A new order for the person's store while another
// app of Swift is open. One account is often a customer AND a store owner;
// the store's full-screen takeover lives in the store app only (store room
// socket, VendorStack), and the per-person 'vendor:order_alert' event had no
// listener anywhere, so an owner browsing as a customer heard nothing. And a
// "New Order!" push tapped there opened nothing: its screen is not mounted.
//
// This layer covers both: the live alert while the CUSTOMER app is open (not
// over a mover's map: a driver gets the OS push banner), and a tapped store
// push in any other app. "Open my store" switches apps through the same
// server switch-role the app switcher uses, then routes the push data again,
// which opens the order on the store's order desk.
// ---------------------------------------------------------------------------

type StoreAlert = { data: Record<string, unknown>; orderNumber?: string };

function alertFrom(payload: unknown): StoreAlert | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p['orderId'] !== 'string' || !p['orderId']) return null;
  const orderNumber = typeof p['orderNumber'] === 'string' ? p['orderNumber'] : undefined;
  return {
    data: { kind: 'vendor_order_alert', orderId: p['orderId'], audience: 'business', ...(orderNumber ? { orderNumber } : {}) },
    ...(orderNumber ? { orderNumber } : {}),
  };
}

export function StoreAlertElsewhere() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const intent = (useAuthStore((s) => s.intent) ?? 'customer') as Intent;
  const sessionGeneration = useAuthStore((s) => s.sessionGeneration);
  const user = useAuthStore((s) => s.user);
  const ownsStore = isAuthenticated && accountHoldsRole(user as Parameters<typeof accountHoldsRole>[0], 'vendor');
  const [alert, setAlert] = React.useState<StoreAlert | null>(null);
  // The app switcher knows three apps; the advertiser console switches like the customer app.
  const { switchTo, switching } = useRoleSwitch(intent === 'mover' || intent === 'vendor' ? intent : 'customer');

  // A tapped "New Order!" push while another app is open.
  React.useEffect(() => {
    if (!ownsStore) return undefined;
    return setBusinessTapElsewhereHandler((data) => {
      const next = alertFrom(data);
      if (next) setAlert(next);
    });
  }, [ownsStore]);

  // The live alert while the customer app is open.
  React.useEffect(() => {
    if (!ownsStore || intent !== 'customer') return undefined;
    connectSocket();
    const socket = getSocket();
    const onAlert = (payload: unknown) => {
      const next = alertFrom(payload);
      if (!next) return;
      Vibration.vibrate(400);
      setAlert(next);
    };
    socket.on('vendor:order_alert', onAlert);
    return () => { socket.off('vendor:order_alert', onAlert); };
  }, [ownsStore, intent, sessionGeneration]);

  // Opening the store app retires this layer's alert: the store board owns it.
  React.useEffect(() => {
    if (intent === 'vendor') setAlert(null);
  }, [intent]);

  if (!alert || intent === 'vendor' || !ownsStore) return null;

  const open = () => {
    if (switching) return;
    const data = alert.data;
    void switchTo('vendor', () => {
      setAlert(null);
      // One beat for the store app to mount before its order desk opens.
      setTimeout(() => routeNotificationData(data), 400);
    });
  };

  return (
    <PopupCard visible onClose={() => setAlert(null)}>
      <DecorativeIcon
        style={{
          width: 44,
          height: 44,
          borderRadius: radius.full,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: color.brand[50],
          marginBottom: space.md,
        }}
      >
        <Feather name="shopping-bag" size={20} color={color.brand[600]} />
      </DecorativeIcon>
      <PopupTitle variant="body" weight="bold" center>
        New order at your store
      </PopupTitle>
      <T variant="caption" tone="muted" center style={{ marginTop: space.sm, marginBottom: space.lg }}>
        {alert.orderNumber
          ? `Order ${alert.orderNumber} is waiting for you to accept or decline.`
          : 'An order is waiting for you to accept or decline.'}
      </T>
      <PillButton label="Open my store" loading={switching} onPress={open} style={{ alignSelf: 'stretch', marginBottom: space.md }} />
      <LinkText label="Not now" tone="muted" onPress={() => setAlert(null)} />
    </PopupCard>
  );
}
