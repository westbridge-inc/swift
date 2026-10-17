/** @jsxImportSource react */
import React, { useEffect, useState } from 'react';
import { AppState, Linking, Modal, Platform, View } from 'react-native';
import { color, space } from '@swift/ui';
import { PillButton, Screen, T } from '../kit';
import { SwiftMark } from './SwiftLogo';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { STORE_NAMES, STORE_URLS, storePlatformOf, updateRequired, type StorePlatform } from '../lib/appVersionGate';
import { bundledPolicyFor, resolveEmergencyDial, telUrl } from '../lib/emergencyPolicy';

/**
 * [Row 3 · force update] Build 12 on: when the API says this phone's build is
 * older than the oldest one Swift still serves, a full-screen "Update Swift"
 * covers the app, with this platform's store link and no way past it (Android's
 * back button does not close it). It asks on open and every time the app comes
 * back to the screen, so a phone already open mid-job is only stopped at its
 * next return, never in the middle of a tap.
 *
 * It never blocks on doubt: no answer (offline, an older API), a malformed one,
 * a development build or an unreadable build number shows the app as usual.
 * The emergency number stays one tap away on this screen, because it hides SOS.
 */

/** The phone's native build number (CFBundleVersion / versionCode). expo-application is
 *  a NATIVE module: loaded through a guarded require so a binary without it reads
 *  "unknown" (never blocked) instead of crashing at startup. */
export function nativeBuildNumber(
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  load: () => unknown = () => require('expo-application'),
): string | null {
  try {
    const app = load() as { nativeBuildVersion?: unknown } | null;
    return typeof app?.nativeBuildVersion === 'string' ? app.nativeBuildVersion : null;
  } catch {
    return null;
  }
}

// eslint-disable-next-line no-undef
const isDevelopmentBuild = () => typeof __DEV__ !== 'undefined' && __DEV__ === true;

/** Asks on mount and on every return to the screen; a failed ask keeps the last answer. */
export function useUpdateRequired(readBuild: () => string | null = nativeBuildNumber): boolean {
  const [required, setRequired] = useState(false);
  useEffect(() => {
    if (isDevelopmentBuild()) return undefined;
    let alive = true;
    let latest = 0;
    const check = async () => {
      const mine = ++latest;
      try {
        const res = await api.get('/public/app-version');
        if (!alive || mine !== latest) return;
        setRequired(updateRequired(res.data?.data, Platform.OS, readBuild()));
      } catch {
        // Offline, or an API without this route: never block on a check that failed.
      }
    };
    void check();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void check();
    });
    return () => {
      alive = false;
      subscription.remove();
    };
  }, [readBuild]);
  return required;
}

export function UpdateRequiredScreen({ platform, country }: { platform: StorePlatform; country: string | null }) {
  const [couldNotOpen, setCouldNotOpen] = useState(false);
  const store = STORE_NAMES[platform];
  const emergency = resolveEmergencyDial(bundledPolicyFor(country ?? 'GY'), 'police');
  const openStore = () => {
    setCouldNotOpen(false);
    Linking.openURL(STORE_URLS[platform]).catch(() => setCouldNotOpen(true));
  };
  return (
    <Screen testID="update-required" style={{ backgroundColor: color.surface.subtle, paddingHorizontal: space.xl, paddingBottom: space.xl }}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <SwiftMark size={56} />
        <T variant="title" center style={{ marginTop: space.xl }}>
          Update Swift
        </T>
        <T variant="body" tone="muted" center style={{ marginTop: space.sm, maxWidth: 330 }}>
          This version of Swift is no longer supported. Update to the newest version from {store} to keep using Swift.
        </T>
      </View>
      <View style={{ width: '100%', maxWidth: 360, alignSelf: 'center' }}>
        <PillButton label="Update Swift" icon="download" onPress={openStore} testID="update-required-open-store" />
        {couldNotOpen ? (
          <T variant="caption" tone="error" center style={{ marginTop: space.md }} testID="update-required-store-failed">
            {`Couldn’t open ${store}. Open it yourself and search for Swift.`}
          </T>
        ) : null}
        {emergency.kind === 'auto' ? (
          <T
            variant="caption"
            tone="muted"
            center
            style={{ marginTop: space.lg }}
            accessibilityRole="link"
            onPress={() => { Linking.openURL(telUrl(emergency.number)).catch(() => {}); }}
            testID="update-required-emergency"
          >
            {`In an emergency, call ${emergency.number}.`}
          </T>
        ) : null}
      </View>
    </Screen>
  );
}

export function UpdateRequiredGate({ readBuild = nativeBuildNumber }: { readBuild?: () => string | null }) {
  const required = useUpdateRequired(readBuild);
  const country = useAuthStore((s) => s.countryCode);
  const platform = storePlatformOf(Platform.OS);
  if (!required || !platform) return null;
  return (
    <Modal visible animationType="none" transparent={false} onRequestClose={() => {}}>
      <UpdateRequiredScreen platform={platform} country={country ?? null} />
    </Modal>
  );
}
