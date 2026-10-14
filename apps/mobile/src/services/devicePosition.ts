import * as Location from 'expo-location';
import {
  currentPositionWithFallback,
  LAST_KNOWN_MAX_ACCURACY_M,
  LAST_KNOWN_MAX_AGE_MS,
  type PositionSource,
} from '../lib/positionFix';

/**
 * [GO-LOC-1] The device's three ways to a position, for the one fallback
 * policy in lib/positionFix.ts: Balanced first, then a fresh and accurate
 * cached fix, then GPS. Every caller that needs a current fix (the location
 * resolver behind GO, pickup and SOS, and the mover's stationary heartbeat)
 * goes through here, so none of them can hang on a Balanced request again.
 */
export const expoPositionSource: PositionSource = {
  balanced: () => Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
  // The OS filters too; positionFix re-checks age and accuracy itself.
  lastKnown: () => Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS, requiredAccuracy: LAST_KNOWN_MAX_ACCURACY_M }),
  gps: () => Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
};

/** One current device position, bounded, with the GPS fallback. */
export function currentDevicePosition() {
  return currentPositionWithFallback(expoPositionSource);
}
