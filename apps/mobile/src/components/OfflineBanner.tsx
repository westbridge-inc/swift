import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import NetInfo from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { color } from '@swift/ui';
import { T } from '../kit';

// H (pre-launch audit): the app assumed connectivity on networks that don't
// have it. This wires React Query's onlineManager to real device connectivity
// (so queries/mutations pause + resume instead of hammering a dead network)
// and shows a persistent banner so a failure reads as "you're offline", not a
// mystery spinner. Degrades to no-banner if NetInfo is unavailable — never
// crashes the tree.

// Bridge NetInfo → React Query connectivity (module scope: set up once).
onlineManager.setEventListener((setOnline) =>
  NetInfo.addEventListener((state) => {
    setOnline(!!state.isConnected);
  }),
);

export function OfflineBanner() {
  const insets = useSafeAreaInsets();
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      // `isConnected === false` is a hard offline; null (unknown) stays quiet.
      setOffline(state.isConnected === false);
    });
    return () => unsub();
  }, []);

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
