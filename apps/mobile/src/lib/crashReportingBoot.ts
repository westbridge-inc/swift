/**
 * [L13 item 7] Imported FIRST by App.tsx so a crash during startup is caught.
 * Does nothing when the build carries no crash-report address.
 */
import * as Sentry from '@sentry/react-native';
import { crashEnvironment, startCrashReporting, type CrashSdk } from './crashReporting';

declare const __DEV__: boolean | undefined;

const sdk: CrashSdk = {
  init: (options) => Sentry.init(options as Sentry.ReactNativeOptions),
  captureException: (error, hint) => Sentry.captureException(error, hint),
};

startCrashReporting(sdk, {
  // @ts-expect-error Expo statically inlines this declared public build-time variable.
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
  environment: crashEnvironment(
    // @ts-expect-error Expo statically inlines this declared public build-time variable.
    process.env.EXPO_PUBLIC_API_URL,
    typeof __DEV__ !== 'undefined' && __DEV__ === true,
  ),
});
