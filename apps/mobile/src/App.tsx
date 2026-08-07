/** @jsxImportSource react */
import 'react-native-gesture-handler';
import '../global.css';
import { useCallback, useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import {
  BricolageGrotesque_600SemiBold,
  BricolageGrotesque_700Bold,
} from '@expo-google-fonts/bricolage-grotesque';
import {
  HankenGrotesk_400Regular,
  HankenGrotesk_500Medium,
  HankenGrotesk_600SemiBold,
  HankenGrotesk_700Bold,
} from '@expo-google-fonts/hanken-grotesk';
import { GluestackUIProvider, ToastHost } from './components/ui';
import { OfflineBanner } from './components/OfflineBanner';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installGlobalErrorHandler } from './lib/crash-reporter';
import { RootNavigator } from './navigation/RootNavigator';
import { queryClient } from './lib/queryClient';
import { initSecureStorage } from './lib/storage';
import { track } from './lib/analytics';
import { PermissionPrimeSheet } from './components/PermissionPrimeSheet';
import { useAuthStore } from './stores/authStore';
import { useLocationStore } from './stores/locationStore';
import { useAppStore } from './stores/appStore';
import { useDeviceLocation } from './hooks/useDeviceLocation';

// Hold the native splash until the brand fonts are ready (avoids a System-font flash).
SplashScreen.preventAutoHideAsync().catch(() => {});

// SWIFT-013: capture uncaught JS errors (timers/async/event handlers) at the
// RN global handler before the first render, so nothing crashes silently.
installGlobalErrorHandler();

// Silently refreshes GPS only when permission is already granted. Rendered
// after encrypted storage is open so persisted writes are safe; the explicit
// OS request lives behind an in-context pickup primer [first-open SO-5].
function LocationBootstrap() {
  useDeviceLocation();
  return null;
}

export default function App() {
  // Register under the exact names @swift/ui tokens reference (font.display / font.body)
  // so the `font-display` / `font-body` NativeWind classes resolve to the brand typefaces.
  // Splash holds until loaded, so there is no fallback swap (zero layout shift).
  const [fontsLoaded] = useFonts({
    Bricolage: BricolageGrotesque_700Bold,
    BricolageSemiBold: BricolageGrotesque_600SemiBold,
    Hanken: HankenGrotesk_400Regular,
    HankenMedium: HankenGrotesk_500Medium,
    HankenSemiBold: HankenGrotesk_600SemiBold,
    HankenBold: HankenGrotesk_700Bold,
  });

  const [storageReady, setStorageReady] = useState(false);

  useEffect(() => {
    // Open the encrypted store (Keychain-backed key) and rehydrate the persisted
    // auth session before the first render — keeps the no-flash cold start.
    initSecureStorage()
      .then(() =>
        Promise.all([
          useAuthStore.persist.rehydrate(),
          useLocationStore.persist.rehydrate(),
          useAppStore.persist.rehydrate(),
        ]),
      )
      .catch((e) => console.warn('[secure-storage] init failed', e))
      .finally(() => {
        setStorageReady(true);
        track('app_opened', {});
      });
  }, []);

  const ready = fontsLoaded && storageReady;

  const onLayoutRootView = useCallback(() => {
    if (ready) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [ready]);

  if (!ready) return null;

  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }} onLayout={onLayoutRootView}>
        <SafeAreaProvider>
          <GluestackUIProvider>
            <QueryClientProvider client={queryClient}>
              <LocationBootstrap />
              <RootNavigator />
              <ToastHost />
              <PermissionPrimeSheet />
              <OfflineBanner />
            </QueryClientProvider>
          </GluestackUIProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
