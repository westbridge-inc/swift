import * as Notifications from 'expo-notifications';
import { navigationRef, safeNavigate } from '../navigation/navigationRef';

// The push TAP-ROUTER [first-open spec 2.4 / rides R-06 / QR Part 6]. Until
// now every notification the backend sent opened the app on whatever screen
// it last showed — a push that goes nowhere trains people to ignore pushes.
// One table maps every payload to its exact screen; unknown payloads open
// the app normally (never a crash, never a guess). Cold starts (app killed)
// and warm taps both route; navigation not ready yet → queued and flushed
// by RootNavigator's onReady.

type Destination = { screen: string; params?: Record<string, unknown> };

/** PURE: payload → destination. The single source of tap-routing truth —
 *  extend HERE as new kinds ship (the first-open engagement completes the
 *  earner-side matrix; v1 routes the customer journeys). */
export function destinationFor(data: Record<string, unknown> | null | undefined): Destination | null {
  if (!data) return null;
  const kind = typeof data['kind'] === 'string' ? (data['kind'] as string) : '';
  const orderId = typeof data['orderId'] === 'string' ? (data['orderId'] as string) : undefined;

  // Rides: queue outcomes + anything ride-flavoured lands on the taxi screen
  // (it reads the active ride itself — T21 restore does the rest).
  if (kind === 'ride_queue_matched' || kind === 'ride_queue_expired' || kind.startsWith('ride_')) {
    return { screen: 'Taxi' };
  }

  // [E36 / danger #22] An OFFER ping is for the EARNER: their role-resolved
  // Main IS the mover home where the live offer card (and its countdown)
  // renders. The generic orderId branch below would have dropped them on the
  // CUSTOMER Delivery screen — a dead end with the clock running.
  if (kind === 'dispatch_offer') return { screen: 'Main' };
  // A store told "a cancelled order may hold an MMG payment" runs a business:
  // their Main is the vendor dashboard, not a customer tracking screen.
  if (kind === 'mmg_unattested_cancellation') return { screen: 'Main' };

  // Orders: any payload carrying an orderId lands on that order's tracking
  // screen — covers status updates, prep_ready, substitutions, pickup READY.
  if (orderId) return { screen: 'Delivery', params: { orderId } };

  // Booking reminders carry refId (the job/booking) — the Activity tab is the
  // honest v1 landing until bookings get a dedicated deep screen.
  if (kind === 'booking_reminder') return { screen: 'HomeTabs', params: { screen: 'Activity' } };

  return null; // unknown → the app opens normally
}

let pending: Destination | null = null;
let installed = false;

function go(dest: Destination | null) {
  if (!dest) return;
  if (!safeNavigate(dest.screen, dest.params)) pending = dest;
}

/** RootNavigator calls this from onReady — delivers a cold-start tap that
 *  arrived before the container mounted. */
export function flushPendingNavigation() {
  if (!pending) return;
  const dest = pending;
  pending = null;
  // One frame of grace so the initial route settles before we move.
  setTimeout(() => { if (!safeNavigate(dest.screen, dest.params)) pending = dest; }, 250);
}

/** Install once at app start: warm taps via the listener, cold starts via the
 *  last-response lookup. Failures are silent — routing is garnish; the app
 *  opening at all is the meal. */
export function installNotificationTapRouter(): () => void {
  if (installed) return () => undefined;
  installed = true;

  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    try {
      go(destinationFor(response?.notification?.request?.content?.data as Record<string, unknown>));
    } catch { /* never let a tap crash the app */ }
  });

  // Cold start: the tap that LAUNCHED us.
  Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      if (!response) return;
      go(destinationFor(response.notification?.request?.content?.data as Record<string, unknown>));
    })
    .catch(() => undefined);

  return () => {
    installed = false;
    sub.remove();
  };
}

/** Test seam: is anything queued? */
export function hasPendingNavigation(): boolean {
  return pending != null && !navigationRef.isReady();
}
