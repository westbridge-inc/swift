import { type ReactNode, useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { onlineManager } from '@tanstack/react-query';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { T } from '../kit';
import { offlineBannerBodyHeight, OFFLINE_BANNER_MIN_BODY_HEIGHT } from '../lib/connectivity';

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

const OFFLINE_CONFIRMATION_MS = 800;

/** Subscribe to connectivity changes; a no-op when NetInfo is unavailable. */
function subscribeConnectivity(onChange: (connected: boolean | null) => void): () => void {
  if (!netInfo) return () => {};
  try {
    return netInfo.addEventListener((state) => onChange(state.isConnected));
  } catch {
    return () => {};
  }
}

/** Own the one stabilized connectivity signal used by both the banner and
 * React Query. iOS can replay a transient/stale `false` while a simulator or
 * device finishes restoring its network path; a fresh native read confirms it
 * before the UI claims the device is offline. Foreground refresh also repairs
 * a stale sample even when the native path watcher emits no follow-up event. */
function useOfflineStatus(): boolean {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if (!netInfo) return undefined;

    let mounted = true;
    let latestSample: boolean | null = null;
    let confirmationTimer: ReturnType<typeof setTimeout> | null = null;
    let confirming = false;
    let sawOnlineDuringConfirmation = false;

    const clearConfirmation = () => {
      if (confirmationTimer !== null) clearTimeout(confirmationTimer);
      confirmationTimer = null;
    };

    const commit = (connected: boolean) => {
      if (!mounted) return;
      onlineManager.setOnline(connected);
      setOffline(!connected);
    };

    const observe = (connected: boolean | null) => {
      latestSample = connected;

      // `refresh()` publishes its result through this same subscription before
      // its promise resolves. Do not schedule another confirmation from that
      // publication or an offline device would poll forever every 800ms.
      if (confirming) {
        if (connected === true) {
          sawOnlineDuringConfirmation = true;
          commit(true);
        }
        return;
      }

      clearConfirmation();

      if (connected === true) {
        commit(true);
        return;
      }
      if (connected !== false) return;

      confirmationTimer = setTimeout(() => {
        confirmationTimer = null;
        confirming = true;
        sawOnlineDuringConfirmation = false;
        void netInfo
          .refresh()
          .then((state) => {
            confirming = false;
            const refreshed = state.isConnected ?? latestSample;
            latestSample = refreshed;
            // If an online event raced with a stale false refresh callback,
            // confirm the final false sample again rather than overriding the
            // newer online event. A genuine drop will confirm on the next read.
            if (sawOnlineDuringConfirmation && refreshed === false) {
              observe(false);
              return;
            }
            if (refreshed !== null) commit(refreshed);
          })
          // If the confirming read itself fails, retain the native hard-offline
          // sample. The subscription will restore online immediately on change.
          .catch(() => {
            confirming = false;
            if (sawOnlineDuringConfirmation && latestSample === false) {
              observe(false);
            } else if (latestSample === false) {
              commit(false);
            }
          });
      }, OFFLINE_CONFIRMATION_MS);
    };

    const unsubscribe = subscribeConnectivity(observe);
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void netInfo.refresh().then((sample) => observe(sample.isConnected)).catch(() => {});
    });

    // Do not rely only on the subscription's cached first callback. A fresh read
    // fixed the exact stale-false state reproduced during simulator certification.
    void netInfo.refresh().then((sample) => observe(sample.isConnected)).catch(() => {});

    return () => {
      mounted = false;
      clearConfirmation();
      appStateSubscription.remove();
      unsubscribe();
    };
  }, []);

  return offline;
}

/** Reserves the banner's body height above navigation while its safe-area
 * portion remains over the status bar. This keeps every screen header visible
 * without double-applying the device's top inset. */
export function ConnectivityBoundary({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const offline = useOfflineStatus();
  const [bannerBodyHeight, setBannerBodyHeight] = useState(OFFLINE_BANNER_MIN_BODY_HEIGHT);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1, paddingTop: offline ? bannerBodyHeight : 0 }}>{children}</View>
      {offline ? (
        <View
          pointerEvents="none"
          accessible
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          onLayout={(event) => {
            const next = offlineBannerBodyHeight(event.nativeEvent.layout.height, insets.top);
            setBannerBodyHeight((current) => (current === next ? current : next));
          }}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            paddingTop: insets.top + 6,
            paddingBottom: 8,
            paddingHorizontal: 16,
            backgroundColor: color.text.primary,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            zIndex: 9999,
            elevation: 9999,
          }}
        >
          <MaterialCommunityIcons name="wifi-off" size={14} color={color.white} />
          <T variant="caption" weight="semibold" style={{ color: color.white, flexShrink: 1 }}>
            No connection — we’ll retry when you’re back online
          </T>
        </View>
      ) : null}
    </View>
  );
}
