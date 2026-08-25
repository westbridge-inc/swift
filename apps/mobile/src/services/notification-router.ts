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
 *  extend HERE as new kinds ship. Every `kind` the API sends is enumerated in
 *  notification-router.test.ts (THE CENSUS), which is scanned against
 *  apps/api/src both ways: a new server kind fails the suite until someone
 *  decides where its tap lands, and a case here that nothing sends fails too.
 *  Screen names are checked against the real navigators — 'HomeTabs' once
 *  looked like a route and was not one, so its pushes silently went nowhere. */
export function destinationFor(data: Record<string, unknown> | null | undefined): Destination | null {
  if (!data) return null;
  const kind = typeof data['kind'] === 'string' ? (data['kind'] as string) : '';
  const orderId = typeof data['orderId'] === 'string' ? (data['orderId'] as string) : undefined;
  // Server-tagged surface ('customer' | 'earner' | 'business'), merged into
  // data by NotificationService.send. Present on only some payloads today.
  const audience = typeof data['audience'] === 'string' ? (data['audience'] as string) : '';

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

  // [E36 sibling] THE vendor order alert — the most money-critical push in the
  // app — is for the STORE. Their order desk is VendorOrderDetail, opened by
  // the vendor dashboard itself with { orderId, orderNumber }; the generic
  // orderId branch below dropped them on the CUSTOMER Delivery screen, a route
  // VendorStack never mounts, so "New Order!" opened on whatever was last on
  // screen. orderNumber only rides along when the payload actually carries it
  // (it titles the detail header while the order loads) — never invented.
  if (kind === 'vendor_order_alert' && orderId) {
    const orderNumber = typeof data['orderNumber'] === 'string' ? (data['orderNumber'] as string) : undefined;
    return { screen: 'VendorOrderDetail', params: orderNumber ? { orderId, orderNumber } : { orderId } };
  }

  // An appointment MOVED (booking_rescheduled) is a Booking on a STORE's
  // calendar — it carries bookingId, never jobId — so it takes its own branch
  // before the service-job family below: the vendor's Schedule agenda is the
  // screen that shows that slot. The other recipient of the same kind is the
  // customer whose appointment the store moved, and the app has no
  // customer-side appointments screen at all — that tap opens the app
  // normally, exactly as it does today, until one exists [reported].
  if (kind === 'booking_rescheduled') return { screen: 'Schedule' };

  // BOOKINGS + SERVICE JOBS [S0: a push landing on a dead screen]. Every other
  // booking_* kind is a service JOB event carrying jobId/refId and no orderId
  // (to_confirm · confirmed · slot_declined · reminder · completed ·
  // cancelled), so the family resolves above the order fallback: a job push
  // must never win a tracking screen. ServiceJobs ("My Jobs") is the ONE
  // screen that renders that job for BOTH sides — GET /services/jobs returns
  // rows where the caller is the customer OR the provider, and the provider's
  // quote / confirm-time / can't-make-it / mark-complete actions live on the
  // same card the push is about. Matched by PREFIX, like ride_ above, because
  // this family is still growing (completed + cancelled landed mid-audit);
  // enumerating it is how three kinds went unrouted in the first place.
  // No params: ServiceJobsScreen takes none — it lists every job — so a jobId
  // here would be an invented route param a screen never reads. A per-job deep
  // screen does not exist yet, and a booking_reminder whose refId is a vendor
  // APPOINTMENT rather than a service job lands on the same list without its
  // row [both reported, neither invented].
  if (kind.startsWith('booking_')) return { screen: 'ServiceJobs' };

  // [server-tagged audience] A push the server addressed to a BUSINESS belongs
  // on the store's order desk. NotificationService.send merges `audience` into
  // data (the in-app notification list already reads it), so this is a server
  // fact, not a guess: without it, audience:'business' payloads carrying an
  // orderId — a store told dispatch found no rider, a delivery converted to
  // pickup — fell through to the CUSTOMER Delivery screen, a route VendorStack
  // never mounts. Runs AFTER the kind branches so a deliberate business
  // destination (mmg_unattested_cancellation → Main) still wins.
  if (audience === 'business' && orderId) return { screen: 'VendorOrderDetail', params: { orderId } };

  // Orders: any payload carrying an orderId lands on that order's tracking
  // screen — covers status updates, prep_ready, substitutions, pickup READY.
  if (orderId) return { screen: 'Delivery', params: { orderId } };

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
