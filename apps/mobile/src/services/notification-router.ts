import { teamInviteKeys } from '../hooks/teamInviteKeys';
import * as Notifications from 'expo-notifications';
import { navigationRef, safeNavigate } from '../navigation/navigationRef';
import { getAuthSessionSnapshot } from '../stores/authStore';
import { useStoreSwitcher } from '../stores/storeSwitcher';
import { selectionStillCurrent } from '../lib/storeSelection';

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
  if (data['kind'] === 'billing_mmg_checkout') return { screen: 'WeeklyFee', params: { ref: typeof data['ref'] === 'string' ? data['ref'] : undefined, subscriptionId: typeof data['subscriptionId'] === 'string' ? data['subscriptionId'] : undefined, vendorId: typeof data['vendorId'] === 'string' ? data['vendorId'] : undefined } };
  const kind = typeof data['kind'] === 'string' ? (data['kind'] as string) : '';
  const orderId = typeof data['orderId'] === 'string' ? (data['orderId'] as string) : undefined;
  // Server-tagged surface ('customer' | 'earner' | 'business'), merged into
  // data by NotificationService.send. Present on only some payloads today.
  const audience = typeof data['audience'] === 'string' ? (data['audience'] as string) : '';

  // [Row 55] A store team invite is answered on the inbox, where its Accept /
  // Decline card sits (the invitee joins only by accepting there).
  if (kind === 'staff_invite') return { screen: 'Storefront', params: { screen: 'Notifications' } };

  // Rides: queue outcomes + anything ride-flavoured lands on the taxi screen
  // (it reads the active ride itself — T21 restore does the rest).
  if (kind === 'ride_queue_matched' || kind === 'ride_queue_expired' || kind.startsWith('ride_')) {
    return { screen: 'Taxi' };
  }

  // [safety §5.3] THE TRIP-GUARDIAN CHECK-IN — "Everything OK on your trip?"
  // It goes to the PASSENGER of a ride, and the card that answers it lives on
  // the Taxi screen. It carries an orderId, so the generic branch at the
  // bottom sent it to Delivery — the CUSTOMER order-tracking screen, which a
  // ride never renders on. A person being asked whether they are safe tapped
  // the notification and arrived somewhere that could not ask them.
  //
  // Taxi takes no params: it resolves the active ride itself and then asks the
  // server whether a check-in is outstanding. Passing a "show the prompt" flag
  // would let a stale tap re-raise a card the passenger already answered, and
  // the server is the only thing that knows.
  if (kind === 'guardian_checkin') return { screen: 'Taxi' };

  // [TST-001] The DRIVER's half of that check: the passenger did not answer,
  // so the driver is asked to confirm the trip's status before it escalates.
  // This went to Delivery — a screen MoverStack never mounts — and the census
  // asserted that dead end as passing, with a comment admitting it. The
  // endpoint existed with no caller and there was no control anywhere.
  //
  // It carries the cycle and the nonce that identify the question: the screen
  // answers THAT check, never whichever one happens to be open, so a stale
  // notification cannot resolve a later one.
  if (kind === 'guardian_driver_confirm') {
    return {
      screen: 'GuardianDriverConfirm',
      params: {
        sessionId: data['sessionId'],
        cycleId: data['cycleId'],
        nonce: data['nonce'],
        respondBy: data['respondBy'],
        orderId: data['orderId'],
      },
    };
  }

  // [E36 / danger #22] An OFFER ping is for the EARNER: their role-resolved
  // Main IS the mover home where the live offer card (and its countdown)
  // renders. The generic orderId branch below would have dropped them on the
  // CUSTOMER Delivery screen — a dead end with the clock running.
  if (kind === 'dispatch_offer') return { screen: 'Main' };
  // [Q10] "Order ready for pickup" goes to the RIDER who holds the job, never
  // to the customer (the API sends it only from the kitchen's Mark-ready to
  // the assigned rider, tagged audience earner). Its orderId sent it down the
  // generic branch to Delivery, the CUSTOMER screen MoverStack never mounts,
  // so the tap opened nothing. ActiveJob is the rider's live job; it takes no
  // params because it resolves the active job itself.
  if (kind === 'prep_ready') return { screen: 'ActiveJob' };
  // [AF-MOB-006] Custody recovery. The holder's live job carries the handoff
  // code; the relay rider's task waits on their dashboard until custody is theirs.
  if (kind === 'custody_handoff_code') return { screen: 'ActiveJob' };
  if (kind === 'custody_relay_assigned' || kind === 'custody_relay_cancelled') return { screen: 'Main' };
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
  // before the service-job family below. It has TWO recipients, told apart
  // by the audience the API tags [E28]. business = the STORE whose calendar
  // owns the slot; their Schedule agenda shows it. customer = the person whose
  // appointment moved. Schedule is mounted ONLY by VendorStack, so a customer
  // tap aimed there opened nothing. The customer copy returns null (the app
  // opens normally): the push carries the bookingId, not the orderId a
  // Delivery deep link needs. (A reschedule now moves Order.appointmentSlot
  // with the booking [Q12], so the order screen shows the new time once the
  // customer opens it.) An untagged row cannot say whose it is, so it also
  // opens the app normally.
  if (kind === 'booking_rescheduled') {
    return audience === 'business' ? { screen: 'Schedule' } : null;
  }

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

  // [E12 §7.2] The identity-check prompts land ON the selfie screen — a timed
  // prompt that opens the app "wherever it was" is a deadline the person burns
  // hunting for the right screen. The deadline rides along verbatim (a server
  // timestamp, never invented); a missed-check tap goes to the same screen
  // because a fresh PASS is the only way back online. The lock's only door is
  // support, so that tap opens GetHelp preset with the subject.
  if (kind === 'liveness_midshift_prompt' || kind === 'liveness_midshift_missed') {
    const profile = data['profile'] === 'RIDER' ? 'RIDER' : 'DRIVER';
    const respondBy = typeof data['respondBy'] === 'string' ? (data['respondBy'] as string) : undefined;
    return { screen: 'LivenessCheck', params: respondBy ? { profile, respondBy } : { profile } };
  }
  // [MKT G3] "Review your categories — takes about 2 minutes." The backfill
  // sends this to a STORE OWNER (`vendor.owner.userId`), and accepting one of
  // those suggestions is the only thing that writes the tag the Market feed
  // filters on. It was unrouted, and the census had it filed under "admins" —
  // so the one action that fills the marketplace arrived as a push that opened
  // the app on whatever screen was last shown.
  if (kind === 'category_backfill_review') return { screen: 'VendorCategoryReview' };
  // [DOC-1 §3.6] The store's tier moved, or is near a cap — the seller-status screen says what lifts it.
  if (kind === 'vendor_tier_promoted' || kind === 'vendor_tier_nudge') return { screen: 'VendorTier' };
  // [ALG-34] The MMG pay link change notices land on Account, where the
  // pending change (and its cancel) lives — vendor and mover stacks both
  // name that screen Account.
  if (kind === 'mmg_link_change_staged' || kind === 'mmg_link_change_applied' || kind === 'mmg_link_change_cancelled') {
    return { screen: 'Account' };
  }
  // [Q8 · DS269 F1] Someone on the team moved the store's map pin. The owner
  // lands on Account, where the Store location card shows it and moves it back.
  if (kind === 'store_pin_moved') return { screen: 'Account' };

  // [L04 · MASTER-003] "Your password was changed" — if it wasn't the owner,
  // support is the way back, so the notice opens the help screen (mounted in
  // every navigator) already filed as an account problem.
  if (kind === 'password_changed') {
    return { screen: 'GetHelp', params: { category: 'ACCOUNT', subject: 'I did not change my password' } };
  }
  // [L04 · MASTER-056] Password sign-in paused after many wrong attempts: the
  // owner can still sign in with a code; help is the door if it wasn't them.
  if (kind === 'password_sign_in_paused') {
    return { screen: 'GetHelp', params: { category: 'ACCOUNT', subject: 'Someone is trying my password' } };
  }
  if (kind === 'liveness_locked') {
    return { screen: 'GetHelp', params: { category: 'ACCOUNT', subject: 'Identity check locked my account' } };
  }

  // TWO PUSHES THAT TELL THE RECIPIENT TO CONTACT SUPPORT, AND THEN DIDN'T.
  //
  // Both go to a MOVER and both carry an orderId, so the generic branch at the
  // bottom sent them to `Delivery` — a route MoverStack never mounts. The
  // navigate was silently unhandled and the app opened on whatever was last on
  // screen, which is how a suspended driver read "contact Swift support to
  // respond" and had nowhere to tap.
  //
  // `GetHelp` is the answer for the same reason `liveness_locked` uses it: it
  // is mounted in ALL FOUR navigators (customer, mover, vendor, advertiser), so
  // it is reachable no matter which stack the recipient is in — and the screen
  // genuinely reads `category`, `subject` and `orderId`, so none of these params
  // is decoration.
  if (kind === 'incident_interim_suspension') {
    return { screen: 'GetHelp', params: { category: 'ACCOUNT', subject: 'Account suspended pending review' } };
  }
  // [DOC-1 §31.4] A guarantee claim and everything about it lands on the claims screen — filed,
  // updated, paid, protection suspended or reinstated. MoverStack mounts it.
  if (kind === 'claim' || kind === 'claim_update' || kind === 'rlp_suspended' || kind === 'rlp_reinstated') {
    return { screen: 'Claims' };
  }
  if (kind === 'claim_over_gate') {
    // The body says "Support will follow up" — this is the door for the person
    // who would rather not wait. PAYMENT, not the orderId default of
    // ORDER_ISSUE: the dispute is about the guarantee, not the delivery.
    return {
      screen: 'GetHelp',
      params: { category: 'PAYMENT', subject: 'Delivery guarantee claim', ...(orderId ? { orderId } : {}) },
    };
  }

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
  // screen — covers status updates, substitutions, pickup READY.
  if (orderId) return { screen: 'Delivery', params: { orderId } };

  return null; // unknown → the app opens normally
}

type Tap = {
  dest: Destination; data: Record<string, unknown>; attempt: number;
  owner: ReturnType<typeof getAuthSessionSnapshot>;
  selection: { selectedStoreId: string | null; storeGeneration: number };
};
let pending: Tap | null = null;
let installed = false;
let routing = 0;

function isVendorDestination({ dest, data }: Tap): boolean {
  return ['VendorOrderDetail', 'VendorCategoryReview', 'VendorTier', 'Schedule'].includes(dest.screen)
    || (dest.screen === 'Account' && (data['actor'] === 'VENDOR' || data['kind'] === 'store_pin_moved'));
}

function currentVendorTap(tap: Tap): boolean {
  const owner = getAuthSessionSnapshot();
  return tap.attempt === routing && !!tap.owner && owner?.userId === tap.owner.userId
    && owner.generation === tap.owner.generation && selectionStillCurrent(tap.selection, useStoreSwitcher.getState());
}

async function resolveVendorDestination(tap: Tap): Promise<boolean> {
  if (!currentVendorTap(tap)) return false;
  const { vendorApi } = await import('./api');
  const { queryClient } = await import('../lib/queryClient');
  if (!currentVendorTap(tap)) return false;
  // Join the shell's first profile read rather than consume a route on its
  // unselected group. The handoff still retires every editor and live layer.
  const profile = await queryClient.fetchQuery({
    queryKey: ['vendor', 'profile'], staleTime: 0, retry: false,
    queryFn: async () => (await vendorApi.profile(tap.owner!, tap.selection.selectedStoreId)).data.data,
  });
  if (!currentVendorTap(tap) || !Array.isArray(profile?.vendors)) return false;
  const stores = profile.vendors as Array<{ id: string }>;
  let target = typeof tap.data['vendorId'] === 'string' ? tap.data['vendorId'] : undefined;
  if (target !== undefined && !stores.some(store => store.id === target)) return false;
  if (tap.dest.screen === 'VendorOrderDetail') {
    const orderId = tap.dest.params?.['orderId'];
    if (typeof orderId !== 'string') return false;
    // This existing endpoint authorizes this account's order access and returns its
    // actual vendorId. A push without vendorId must not assume the first store.
    const order = (await vendorApi.order(orderId, tap.owner!, target ?? tap.selection.selectedStoreId ?? stores[0]?.id)).data.data;
    if (!currentVendorTap(tap) || order?.id !== orderId || typeof order.vendorId !== 'string'
      || (target !== undefined && target !== order.vendorId)) return false;
    target = order.vendorId;
  }
  target ??= useStoreSwitcher.getState().selectedStoreId ?? stores[0]?.id;
  if (!target || !stores.some(store => store.id === target) || !currentVendorTap(tap)) return false;
  useStoreSwitcher.getState().setSelectedStore(target);
  const selected = useStoreSwitcher.getState();
  // Let React traverse the keyed-group handoff BEFORE dispatching the route.
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  const owner = getAuthSessionSnapshot();
  const now = useStoreSwitcher.getState();
  return tap.attempt === routing && owner?.userId === tap.owner!.userId
    && owner.generation === tap.owner!.generation && now.selectedStoreId === target
    && now.storeGeneration === selected.storeGeneration;
}

async function go(tap: Tap) {
  if (tap.attempt !== routing) return;
  if (!navigationRef.isReady()) { pending = tap; return; }
  let dest = tap.dest;
  if (isVendorDestination(tap)) {
    if (!await resolveVendorDestination(tap)) return;
    if (dest.screen === 'Account' || dest.screen === 'Schedule') {
      dest = { screen: 'VendorRoot', params: { screen: dest.screen, params: dest.params } };
    }
  } else if (dest.screen === 'WeeklyFee' && typeof dest.params?.['vendorId'] === 'string') {
    const { resolveFeeNotification } = await import('./weekly-fee-notification');
    if (!currentVendorTap(tap)) return;
    // The tap's exact authority fences every fee effect, not only the final
    // route: a newer tap, account or explicit choice retires the lookup before
    // it can publish a store, cycle the socket, recover or navigate. The fee
    // lookup's own authorized handoff becomes the tap's new selection.
    const authority = {
      current: () => currentVendorTap(tap),
      adopt: () => {
        const { selectedStoreId, storeGeneration } = useStoreSwitcher.getState();
        tap.selection = { selectedStoreId, storeGeneration };
      },
    };
    const params = await resolveFeeNotification(dest.params, (resolved) => { safeNavigate('WeeklyFee', { ...resolved, feeFamily: 'vendor' }); }, authority);
    if (!params || !authority.current() || useStoreSwitcher.getState().selectedStoreId !== params['vendorId']) return;
    dest = { ...dest, params: { ...params, feeFamily: 'vendor' } };
  } else if (dest.screen === 'WeeklyFee') {
    dest = { ...dest, params: { ...dest.params, feeFamily: 'mover' } };
  }
  if (tap.data['kind'] === 'staff_invite') {
    const { queryClient } = await import('../lib/queryClient');
    const owner = getAuthSessionSnapshot();
    if (tap.attempt !== routing || !tap.owner || owner?.userId !== tap.owner.userId
      || owner.generation !== tap.owner.generation) return;
    // A second tap can land on the already focused inbox. Invalidate the
    // active query on every invitation tap instead of relying on a remount.
    void queryClient.invalidateQueries({ queryKey: teamInviteKeys.mine });
  }
  if (tap.attempt !== routing) return;
  if (!safeNavigate(dest.screen, dest.params)) pending = { ...tap, dest };
}

function routeTap(data: Record<string, unknown>) {
  const dest = destinationFor(data);
  const attempt = ++routing;
  pending = null;
  if (!dest) return;
  const { selectedStoreId, storeGeneration } = useStoreSwitcher.getState();
  void go({ dest, data, attempt, owner: getAuthSessionSnapshot(), selection: { selectedStoreId, storeGeneration } }).catch(() => undefined);
}

/** RootNavigator calls this from onReady — delivers a cold-start tap that
 *  arrived before the container mounted. */
export function flushPendingNavigation() {
  if (!pending) return;
  const tap = pending;
  pending = null;
  // One frame of grace so the initial route settles before we move.
  setTimeout(() => { void go(tap).catch(() => undefined); }, 250);
}

/** Install once at app start: warm taps via the listener, cold starts via the
 *  last-response lookup. Failures are silent — routing is garnish; the app
 *  opening at all is the meal. */
export function installNotificationTapRouter(): () => void {
  if (installed) return () => undefined;
  installed = true;

  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    try {
      routeTap(response?.notification?.request?.content?.data as Record<string, unknown>);
    } catch { /* never let a tap crash the app */ }
  });

  // Cold start: the tap that LAUNCHED us.
  const installedAt = routing;
  Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      if (!response || !installed || routing !== installedAt) return;
      routeTap(response.notification?.request?.content?.data as Record<string, unknown>);
    })
    .catch(() => undefined);

  return () => {
    installed = false;
    routing++; pending = null;
    sub.remove();
  };
}

/** Test seam: is anything queued? */
export function hasPendingNavigation(): boolean {
  return pending != null && !navigationRef.isReady();
}
