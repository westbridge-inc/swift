import { describe, expect, it } from 'vitest';
import { locationPrimer } from '../lib/location-primer';
import type { LocationStatus } from '../lib/deviceLocation';

const ALL: LocationStatus[] = ['unknown', 'resolving', 'granted', 'denied', 'unavailable'];

describe('locationPrimer', () => {
  it('never asks once a fix is in hand, whatever the status says', () => {
    // A persisted last-known fix can coexist with any status at cold start,
    // so "has a fix" has to win over the status in every combination.
    for (const status of ALL) {
      expect(locationPrimer(true, status)).toEqual({ show: false, action: 'none' });
    }
  });

  it('offers the OS request only where a dialog can still appear', () => {
    expect(locationPrimer(false, 'unknown')).toEqual({ show: true, action: 'request' });
    // Granted-but-no-fix: re-running resolution is the recovery, not a prompt.
    expect(locationPrimer(false, 'granted')).toEqual({ show: true, action: 'request' });
  });

  it('routes a denial to Settings, because the app can no longer prompt', () => {
    // THE BUG THIS PINS: offering "Use location" after a denial produces a
    // button that silently does nothing — iOS resolves a denied request
    // without showing a dialog — and strands the user with no way back.
    for (const status of ['denied', 'unavailable'] as LocationStatus[]) {
      expect(locationPrimer(false, status)).toEqual({ show: true, action: 'settings' });
    }
  });

  it('explains an in-flight resolution but offers no button to press', () => {
    // A second request while one is pending is a no-op; a button that reports
    // no progress is worse than the sentence that says we are looking.
    expect(locationPrimer(false, 'resolving')).toEqual({ show: true, action: 'none' });
  });

  it('always reaches a decision — no status falls through', () => {
    for (const status of ALL) {
      const out = locationPrimer(false, status);
      expect(out).toBeDefined();
      expect(['request', 'settings', 'none']).toContain(out.action);
      // Without a fix the marketplace has no local dimension, so the gap must
      // always be explained even when there is nothing to tap.
      expect(out.show).toBe(true);
    }
  });
});
