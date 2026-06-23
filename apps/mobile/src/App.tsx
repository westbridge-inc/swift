import 'react-native-gesture-handler';
import '../global.css';
import { useCallback, useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { SpaceGrotesk_500Medium, SpaceGrotesk_700Bold } from '@expo-google-fonts/space-grotesk';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import { GluestackUIProvider } from './components/ui';
import { RootNavigator } from './navigation/RootNavigator';
import { initSecureStorage } from './lib/storage';
import { useAuthStore } from './stores/authStore';
import { useLocationStore } from './stores/locationStore';
import { useDeviceLocation } from './hooks/useDeviceLocation';

// Hold the native splash until the brand fonts are ready (avoids a System-font flash).
SplashScreen.preventAutoHideAsync().catch(() => {});

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 2 } },
});

// Resolves device GPS into locationStore on launch. Rendered only after the
// encrypted store is open (see App `ready` gate) so the persisted write inside
// setLocation never runs before initSecureStorage().
function LocationBootstrap() {
  useDeviceLocation();
  return null;
}

export default function App() {
  // Register under the exact names @swift/ui tokens reference (font.display / font.body)
  // so the `font-display` / `font-body` NativeWind classes resolve to the brand typefaces.
  const [fontsLoaded] = useFonts({
    SpaceGrotesk: SpaceGrotesk_700Bold,
    SpaceGroteskMedium: SpaceGrotesk_500Medium,
    Inter: Inter_400Regular,
    InterMedium: Inter_500Medium,
    InterSemiBold: Inter_600SemiBold,
    InterBold: Inter_700Bold,
  });

  const [storageReady, setStorageReady] = useState(false);

  useEffect(() => {
    // Open the encrypted store (Keychain-backed key) and rehydrate the persisted
    // auth session before the first render — keeps the no-flash cold start.
    initSecureStorage()
      .then(() => Promise.all([useAuthStore.persist.rehydrate(), useLocationStore.persist.rehydrate()]))
      .catch((e) => console.warn('[secure-storage] init failed', e))
      .finally(() => setStorageReady(true));
  }, []);

  const ready = fontsLoaded && storageReady;

  const onLayoutRootView = useCallback(() => {
    if (ready) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [ready]);

  if (!ready) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }} onLayout={onLayoutRootView}>
      <SafeAreaProvider>
        <GluestackUIProvider>
          <QueryClientProvider client={queryClient}>
            <LocationBootstrap />
            <RootNavigator />
          </QueryClientProvider>
        </GluestackUIProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
