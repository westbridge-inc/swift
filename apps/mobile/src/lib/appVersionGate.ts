/**
 * [Row 3 · force update] Whether THIS phone's build is older than the oldest
 * build Swift still serves, and where its update is.
 *
 * The API answers GET /public/app-version with a minimum build per platform
 * (an ops setting: apps/api/src/modules/ops/app-version.ts). The phone
 * compares its own NATIVE build number — the iPhone's CFBundleVersion and
 * Android's versionCode, which is what each store counts — because every
 * Swift binary is version 1.0.0. Pure: no React, no native module, so the
 * rule is tested on its own.
 *
 * Fail-open everywhere: no answer, a malformed answer, an unknown platform or
 * an unreadable build number is "no update needed". Only a clear "this build
 * is below the minimum" blocks the app.
 */

export type StorePlatform = 'ios' | 'android';

/** Swift's own store pages: the App Store app and the Google Play listing for gy.swift.app. */
export const STORE_URLS: Readonly<Record<StorePlatform, string>> = Object.freeze({
  ios: 'https://apps.apple.com/app/id6815507102',
  android: 'https://play.google.com/store/apps/details?id=gy.swift.app',
});

export const STORE_NAMES: Readonly<Record<StorePlatform, string>> = Object.freeze({
  ios: 'the App Store',
  android: 'Google Play',
});

export function storePlatformOf(os: unknown): StorePlatform | null {
  return os === 'ios' || os === 'android' ? os : null;
}

/** A whole, positive build number, or null. */
export function buildNumberOf(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** The platform's minimum from the API's `data` ({ ios: { minBuild }, android: { minBuild } }), or null. */
export function minimumBuildFor(answer: unknown, platform: StorePlatform): number | null {
  if (!answer || typeof answer !== 'object') return null;
  const entry = (answer as Record<string, unknown>)[platform];
  if (!entry || typeof entry !== 'object') return null;
  return buildNumberOf((entry as Record<string, unknown>)['minBuild']);
}

/** True only when this phone's build is known and below the platform's minimum. */
export function updateRequired(answer: unknown, os: unknown, nativeBuild: unknown): boolean {
  const platform = storePlatformOf(os);
  if (!platform) return false;
  const minimum = minimumBuildFor(answer, platform);
  const build = buildNumberOf(nativeBuild);
  return minimum !== null && build !== null && build < minimum;
}
