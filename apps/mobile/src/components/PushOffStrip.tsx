/** @jsxImportSource react */
import React from 'react';
import { AppState, View, type ViewStyle } from 'react-native';
import { space } from '@swift/ui';
import { Card, IconChip, PillButton, T } from '../kit';
import type { PushPermission } from '../services/push';

// Loaded on first use: the push service pulls in the native notification
// module, which a dashboard's module graph should not need to load.
const pushService = () => import('../services/push');
const readPermission = async (): Promise<PushPermission> => (await pushService()).pushPermission();

// [STORE-ALERT 18 Oct 2026] An earner dashboard says so when this phone
// cannot ring. A store iPhone that was never asked for notifications showed
// a working board while every new order rang nothing: the person had no way
// to know, and on iOS no Settings switch exists until the app has asked. The
// strip shows whenever push is not granted, re-reads when the app returns to
// the foreground (after Settings), and its one button does the next real
// step: the OS prompt while it can still be shown, else this app's Settings.

const COPY: Record<'store' | 'mover', { title: string; body: string }> = {
  store: {
    title: 'Order alerts are off on this phone',
    body: 'While Swift is closed, new orders will not ring here.',
  },
  mover: {
    title: 'Job offers are off on this phone',
    body: 'While Swift is closed, offers will not reach you.',
  },
};

export function usePushPermission(read: () => Promise<PushPermission> = readPermission): [PushPermission | null, (next: PushPermission) => void] {
  const [permission, setPermission] = React.useState<PushPermission | null>(null);
  React.useEffect(() => {
    let alive = true;
    // Unreadable (no native module): show nothing rather than guess.
    const refresh = () => { void read().then((next) => { if (alive) setPermission(next); }).catch(() => undefined); };
    refresh();
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') refresh(); });
    return () => { alive = false; subscription.remove(); };
  }, [read]);
  return [permission, setPermission];
}

export function PushOffStrip({ audience, style }: { audience: 'store' | 'mover'; style?: ViewStyle }) {
  const [permission, setPermission] = usePushPermission();
  const [busy, setBusy] = React.useState(false);
  if (permission === null || permission === 'granted') return null;
  const copy = COPY[audience];
  return (
    <Card style={{ gap: space.md, ...(style as object) }} accessibilityRole="alert">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <IconChip icon="bell-off" />
        <View style={{ flex: 1 }}>
          <T variant="bodyStrong">{copy.title}</T>
          <T variant="caption" tone="muted" style={{ marginTop: 2 }}>{copy.body}</T>
        </View>
      </View>
      <PillButton
        label={permission === 'settings' ? 'Open settings' : 'Turn on notifications'}
        icon={permission === 'settings' ? 'settings' : 'bell'}
        variant="soft"
        size="md"
        loading={busy}
        onPress={() => {
          if (busy) return;
          setBusy(true);
          void pushService().then((push) => push.turnOnPush()).then(setPermission).catch(() => undefined).finally(() => setBusy(false));
        }}
      />
    </Card>
  );
}
