/** @jsxImportSource react */
import 'react-native-gesture-handler';
import '../global.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';
import { Feather } from '@expo/vector-icons';
import { color, radius, space } from '@swift/ui';
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
import { GluestackUIProvider } from './components/ui';
import { ToastHost } from './kit/toast';
import { ConnectivityBoundary } from './components/OfflineBanner';
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
import { PillButton, Screen, T } from './kit';
import { SwiftMark } from './components/SwiftLogo';

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

type StorageBootstrapStatus = 'loading' | 'ready' | 'error';

async function hydratePersistedStores(): Promise<void> {
  await initSecureStorage();
  await Promise.all([
    useAuthStore.persist.rehydrate(),
    useLocationStore.persist.rehydrate(),
    useAppStore.persist.rehydrate(),
  ]);
}

/** A fail-closed recovery surface: no navigator, API queries, permission work,
 * or persisted-store writes mount until encrypted state is genuinely usable. */
function SecureStorageRecovery({
  retrying,
  onRetry,
}: {
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <Screen
      style={{
        backgroundColor: color.surface.subtle,
        paddingHorizontal: space.xl,
        paddingBottom: space.xl,
      }}
    >
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: 104, height: 104, alignItems: 'center', justifyContent: 'center' }}>
          <View
            style={{
              position: 'absolute',
              width: 96,
              height: 96,
              borderRadius: 48,
              borderWidth: 1,
              borderColor: color.brand[200],
              transform: [{ rotate: '-8deg' }],
            }}
          />
          <View
            style={{
              width: 78,
              height: 78,
              borderRadius: radius.xl,
              backgroundColor: color.surface.base,
              borderWidth: 1,
              borderColor: color.border.subtle,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <SwiftMark size={48} />
          </View>
          <View
            style={{
              position: 'absolute',
              right: 3,
              bottom: 3,
              width: 34,
              height: 34,
              borderRadius: 17,
              backgroundColor: color.brand[600],
              borderWidth: 3,
              borderColor: color.surface.subtle,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Feather name="lock" size={15} color={color.white} />
          </View>
        </View>

        <T variant="title" center style={{ marginTop: space.xl }}>
          Unlock Swift to continue
        </T>
        <T
          variant="body"
          tone="muted"
          center
          style={{ marginTop: space.sm, maxWidth: 330 }}
        >
          Swift couldn&apos;t open the encrypted data saved on this device. Nothing was deleted.
          Unlock your phone, then try again.
        </T>

        <View
          style={{
            width: '100%',
            maxWidth: 360,
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.md,
            marginTop: space['2xl'],
            padding: space.lg,
            borderRadius: radius.lg,
            backgroundColor: color.surface.sunken,
            borderWidth: 1,
            borderColor: color.border.subtle,
          }}
        >
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: radius.md,
              backgroundColor: color.brand[50],
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Feather name="shield" size={19} color={color.brand[600]} />
          </View>
          <View style={{ flex: 1 }}>
            <T variant="bodyStrong">Protected on this device</T>
            <T variant="caption" tone="muted" style={{ marginTop: 2 }}>
              Your sign-in and saved places remain encrypted.
            </T>
          </View>
        </View>
      </View>

      <View style={{ width: '100%', maxWidth: 360, alignSelf: 'center' }}>
        <PillButton
          label="Try again"
          icon="refresh-cw"
          loading={retrying}
          onPress={onRetry}
        />
        <T variant="caption" tone="faint" center style={{ marginTop: space.md }}>
          If this keeps happening, restart Swift or contact Support.
        </T>
      </View>
    </Screen>
  );
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

  const [storageStatus, setStorageStatus] = useState<StorageBootstrapStatus>('loading');
  const [storageRetrying, setStorageRetrying] = useState(false);
  const mountedRef = useRef(true);
  const attemptRef = useRef(0);
  const openedTrackedRef = useRef(false);

  const bootstrapStorage = useCallback(async (retry: boolean) => {
    const attempt = ++attemptRef.current;
    if (retry) setStorageRetrying(true);
    try {
      await hydratePersistedStores();
      if (mountedRef.current && attempt === attemptRef.current) {
        setStorageStatus('ready');
      }
    } catch (error) {
      console.warn('[secure-storage] init failed', error);
      if (mountedRef.current && attempt === attemptRef.current) {
        setStorageStatus('error');
      }
    } finally {
      if (mountedRef.current && attempt === attemptRef.current) {
        setStorageRetrying(false);
      }
      if (!openedTrackedRef.current) {
        openedTrackedRef.current = true;
        track('app_opened', {});
      }
    }
  }, []);

  useEffect(() => {
    // Open the encrypted store (Keychain-backed key) and rehydrate the persisted
    // auth session before the first render — keeps the no-flash cold start.
    mountedRef.current = true;
    void bootstrapStorage(false);
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrapStorage]);

  const renderReady = fontsLoaded && storageStatus !== 'loading';

  const onLayoutRootView = useCallback(() => {
    if (renderReady) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [renderReady]);

  if (!renderReady) return null;

  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }} onLayout={onLayoutRootView}>
        <SafeAreaProvider>
          <GluestackUIProvider>
            {storageStatus === 'error' ? (
              <SecureStorageRecovery
                retrying={storageRetrying}
                onRetry={() => void bootstrapStorage(true)}
              />
            ) : (
              <QueryClientProvider client={queryClient}>
                <LocationBootstrap />
                <ConnectivityBoundary>
                  <RootNavigator />
                </ConnectivityBoundary>
                <ToastHost />
                <PermissionPrimeSheet />
              </QueryClientProvider>
            )}
          </GluestackUIProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
