import { useEffect } from 'react';
import { AppState } from 'react-native';
import { startJobRing } from '../services/jobRinger';

/** The slice of React Native's AppState the ring follows. */
export interface AppStateLike {
  currentState: string;
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
}

/**
 * [RINGER] Ring only while the app is in the foreground: `start` runs now if
 * the app is active, its stop runs the moment the app leaves the foreground,
 * and it runs again when the person comes back to the same open decision.
 * Returns the cleanup that stops the ring and the listening for good.
 */
export function ringWhileForeground(start: () => () => void, appState: AppStateLike): () => void {
  let stop: (() => void) | null = appState.currentState === 'active' ? start() : null;
  const subscription = appState.addEventListener('change', (state) => {
    if (state === 'active') {
      if (!stop) stop = start();
    } else if (stop) {
      stop();
      stop = null;
    }
  });
  return () => {
    subscription.remove();
    stop?.();
    stop = null;
  };
}

/**
 * [RINGER · owner ruling 15 Oct] Loop the job ring and the buzz while
 * `active` (an order or offer is waiting for this person's answer), until
 * `active` turns false (Accept, Decline, the order settled), the screen
 * unmounts, the app leaves the foreground, or `deadlineMs` passes.
 */
export function useJobRing(active: boolean, deadlineMs?: number): void {
  useEffect(() => {
    if (!active) return undefined;
    return ringWhileForeground(() => startJobRing({ deadlineMs }), AppState as unknown as AppStateLike);
  }, [active, deadlineMs]);
}
