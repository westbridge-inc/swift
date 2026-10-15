// ---------------------------------------------------------------------------
// [RINGER · loud alerts 3/4] Does THIS installed binary have the job ring?
//
// The ring ships in app build 12, all at once: the expo-audio native module
// (the in-app ring), the bundled tone (assets/sounds, copied into the iOS
// bundle and Android res/raw by the expo-notifications plugin), and the iOS
// time-sensitive entitlement. Builds 9-11 have none of it.
//
// The answer must come from the NATIVE binary, never from the JS bundle: an
// over-the-air update (runtimeVersion 'appVersion') can put this very code on
// a build 9-11 binary. So the test is whether the ExpoAudio native module is
// linked, which only the build-12 binary can say yes to, and which is looked
// up without loading expo-audio's JS (that throws on a binary without it).
// ---------------------------------------------------------------------------

/** Expo's own lookup of a native module: the module, or null when the binary
 *  does not link it. */
export type NativeModuleLookup = (moduleName: string) => unknown;

let expoLookup: NativeModuleLookup | null | undefined;

/** expo's requireOptionalNativeModule, loaded on first use rather than by a
 *  static import, so a screen that shows the ring never pulls all of expo
 *  into code that is not running on a phone (unit and screen tests). */
function defaultLookup(): NativeModuleLookup | null {
  if (expoLookup === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const expo = require('expo') as { requireOptionalNativeModule?: NativeModuleLookup };
      expoLookup = typeof expo.requireOptionalNativeModule === 'function' ? expo.requireOptionalNativeModule : null;
    } catch {
      expoLookup = null;
    }
  }
  return expoLookup;
}

/** The Android channel job alerts post to (the API's JOB_OFFERS_CHANNEL). */
export const JOB_OFFERS_CHANNEL = 'job_offers';

/** The bundled tone, by the file name the push API and the channel use. */
export const JOB_RING_SOUND = 'swift_job_ring.wav';

/** The DeviceToken.alertsVersion a binary with the job ring reports (the
 *  API's RINGER_ALERTS_VERSION); every other binary reports 0. */
export const RINGER_ALERTS_VERSION = 1;

/** True only on a binary built with the job ring (build 12 on). `lookup`
 *  exists for tests; the app always asks expo. */
export function hasJobRing(lookup: NativeModuleLookup | null = defaultLookup()): boolean {
  if (!lookup) return false;
  try {
    return lookup('ExpoAudio') != null;
  } catch {
    return false;
  }
}

/** What this binary tells the server it can ring with, at push registration. */
export function jobAlertsVersion(lookup: NativeModuleLookup | null = defaultLookup()): number {
  return hasJobRing(lookup) ? RINGER_ALERTS_VERSION : 0;
}
