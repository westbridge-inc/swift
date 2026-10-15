import { requireOptionalNativeModule } from 'expo';

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

/** The Android channel job alerts post to (the API's JOB_OFFERS_CHANNEL). */
export const JOB_OFFERS_CHANNEL = 'job_offers';

/** The bundled tone, by the file name the push API and the channel use. */
export const JOB_RING_SOUND = 'swift_job_ring.wav';

/** The DeviceToken.alertsVersion a binary with the job ring reports (the
 *  API's RINGER_ALERTS_VERSION); every other binary reports 0. */
export const RINGER_ALERTS_VERSION = 1;

/** True only on a binary built with the job ring (build 12 on). */
export function hasJobRing(): boolean {
  try {
    return requireOptionalNativeModule('ExpoAudio') != null;
  } catch {
    return false;
  }
}

/** What this binary tells the server it can ring with, at push registration. */
export function jobAlertsVersion(): number {
  return hasJobRing() ? RINGER_ALERTS_VERSION : 0;
}
