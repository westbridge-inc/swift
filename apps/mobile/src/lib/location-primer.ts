import type { LocationStatus } from './deviceLocation';

/**
 * What the Home location primer offers, given a permission status.
 *
 * This is a pure decision because getting it wrong is silent: a primer that
 * offers "Use location" after a denial opens an OS dialog that never appears
 * (iOS answers a denied request without prompting), so the button looks broken
 * and the user has no route to Settings. Keeping the four cases in one table
 * makes that failure a test, not a field report.
 */
export type LocationPrimerAction = 'request' | 'settings' | 'none';

export interface LocationPrimer {
  /** false ⇒ render nothing: a granted fix needs no ask. */
  show: boolean;
  action: LocationPrimerAction;
}

export function locationPrimer(
  hasFix: boolean,
  status: LocationStatus,
): LocationPrimer {
  // A usable fix is the whole point of asking — never ask again once we have one.
  if (hasFix) return { show: false, action: 'none' };

  switch (status) {
    // Denied is terminal for the app: only Settings can clear it.
    // 'unavailable' joins it — a grant that yields no fix is not re-promptable
    // either, and Settings is where Location Services itself is turned back on.
    case 'denied':
    case 'unavailable':
      return { show: true, action: 'settings' };
    // In flight. Show the explanation, but no button: a second request while
    // one is pending is a no-op, so offering it would be a lie about progress.
    case 'resolving':
      return { show: true, action: 'none' };
    // 'unknown' — never asked, or asked and not yet answered. This is the one
    // case where the OS dialog can still appear, so it is the one case that
    // earns the primary CTA.
    // 'granted' with no fix reaching the store yet: the grant exists but the
    // coordinate has not landed. Requesting re-runs resolution rather than
    // prompting, which is exactly the recovery we want.
    case 'unknown':
    case 'granted':
      return { show: true, action: 'request' };
  }
}
