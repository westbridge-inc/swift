import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { onlineManager } from '@tanstack/react-query';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { T } from '../kit';

// H (pre-launch audit): the app assumed connectivity on networks that don't
// have it. This wires React Query's onlineManager to real device connectivity
// (so queries/mutations pause + resume instead of hammering a dead network)
// and shows a persistent banner so a failure reads as "you're offline", not a
// mystery spinner.
//
// NetInfo is a NATIVE module, and `@react-native-community/netinfo` THROWS at
// import time when the native side is missing (its nativeInterface throws the
// instant RNCNetInfo == null) — so a binary built before this dependency was
// added would crash on startup and freeze the whole JS tree (every tap dead),
// not just skip the banner. A connectivity indicator must never be able to do
// that. So we load it through a guarded require and treat any absence as
// "assume online, no banner". The feature lights up on the next native build;
// until then the app runs exactly as before.
type NetInfoDefault = typeof import('@react-native-community/netinfo').default;

const netInfo: NetInfoDefault | null = (() => {
  try {
    // require, not a static import: a static import of netinfo executes its
    // throw-on-missing-native-module check during bundle evaluation, which is
    // uncatchable. require lets us catch it and degrade.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@react-native-community/netinfo').default as NetInfoDefault;
  } catch {
    return null;
  }
})();

/** Subscribe to connectivity changes; a no-op when NetInfo is unavailable. */
function subscribeConnectivity(onChange: (connected: boolean | null) => void): () => void {
  if (!netInfo) return () => {};
  try {
    return netInfo.addEventListener((state) => onChange(state.isConnected));
  } catch {
    return () => {};
  }
}

// Bridge NetInfo → React Query connectivity (module scope: set up once). Without
// NetInfo, onlineManager keeps its default (assume online) and queries behave
// exactly as they did before this feature existed.
if (netInfo) {
  onlineManager.setEventListener((setOnline) =>
    subscribeConnectivity((connected) => setOnline(!!connected)),
  );
}

export function OfflineBanner() {
  const insets = useSafeAreaInsets();
  const [offline, setOffline] = useState(false);

  useEffect(
    // `isConnected === false` is a hard offline; null (unknown) stays quiet.
    () => subscribeConnectivity((connected) => setOffline(connected === false)),
    [],
  );

  if (!offline) return null;

  return (
    <View
      style={{
        position: 'absolute',
        top: 0, left: 0, right: 0,
        paddingTop: insets.top + 6,
        paddingBottom: 8,
        paddingHorizontal: 16,
        backgroundColor: color.text.primary,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        zIndex: 9999,
      }}
    >
      <MaterialCommunityIcons name="wifi-off" size={14} color="#fff" />
      <T variant="caption" weight="semibold" style={{ color: '#fff' }}>
        No connection — we’ll retry when you’re back online
      </T>
    </View>
  );
}
