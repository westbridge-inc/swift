import { teamInviteKeys } from '../hooks/teamInviteKeys';
import * as Notifications from 'expo-notifications';
import { navigationRef, safeNavigate } from '../navigation/navigationRef';
import { getAuthSessionSnapshot, getLastSignedOutUserId, useAuthStore } from '../stores/authStore';
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

/** The app's home. Every role stack is mounted under the root route Main, so
 *  it exists for everyone. [PUSH-ROUTING] A user-facing kind with no screen of
 *  its own opens HERE on purpose, with its reason in the census — never a
 *  silent null. (From inside the app it moves nothing, so the inbox shows such
 *  a row as a plain card.) */
export const HOME_SCREEN = 'Main';

/** Which app the person has open right now ('customer' | 'mover' | 'vendor' |
 *  'advertiser'). Read ONLY for a payload that does not say whose it is. */
export type OpenApp = () => string | null | undefined;

/** [PUSH-ROUTING] Every notice about a partner's weekly-fee subscription. Not
 *  a `billing_` prefix: billing_invariants and its siblings are OPERATIONS
 *  pages, and an operator's page must not open a partner's fee screen. */
const PARTNER_FEE_KINDS = new Set([
  'billing_mmg_pending', 'billing_success', 'billing_failed', 'billing_final_warning', 'billing_suspended',
  'billing_suspended_nudge', 'billing_reminder', 'billing_banked', 'billing_churned', 'billing_topup',
  'billing_card_action_required', 'trial_fee_education', 'fx_change_notice', 'billing_rate_change', 'usd_migration_notice',
]);

/** [PUSH-ROUTING] Document notices sent to whoever owns the document. */
const DOCUMENT_KINDS = new Set(['verification_approved', 'verification_rejected', 'verification_expired', 'verification_expiry_reminder', 'verification_application_abandoned']);

/** [PUSH-ROUTING] Document notices only a mover receives (the API tags them earner). */
const MOVER_DOCUMENT_KINDS = new Set(['verification_forced_offline', 'verification_vehicle_lapsed', 'compliance_review_failed']);

/** The paying family a fee notice is about. The server tags it (business = a
 *  store's fee, earner = a mover's; the trial notice spells them VENDOR and
 *  MOVER). An untagged notice follows the open app, exactly as
 *  WeeklyFeeRouteScreen resolves a family nobody named. */
function feeFamilyOf(audience: string, openApp?: OpenApp): 'vendor' | 'mover' {
  if (audience === 'business' || audience === 'VENDOR') return 'vendor';
  if (audience === 'earner' || audience === 'MOVER') return 'mover';
  return openApp?.() === 'vendor' ? 'vendor' : 'mover';
}

/** The documents screen of the role a document belongs to: the mover
 *  checklist, the customer's ID screen, or the store's Account tab (its
 *  Documents section; a store still in onboarding shows its checklist on the
 *  same VendorRoot). The server tag says whose document it is; an untagged
 *  notice (notifyRejection sends none) follows the open app. */
function documentsFor(audience: string, openApp?: OpenApp): Destination {
  const who = audience || openApp?.() || 'customer';
  if (who === 'earner' || who === 'mover') return { screen: 'MoverDocuments' };
  if (who === 'business' || who === 'vendor') return { screen: 'VendorRoot', params: { screen: 'Account' } };
  if (who === 'customer') return { screen: 'IdentityVerification' };
  return { screen: HOME_SCREEN }; // an advertiser account has no documents screen
}

/** PURE: payload → destination. The single source of tap-routing truth —
 *  extend HERE as new kinds ship. Every `kind` the API sends is enumerated in
 *  notification-router.test.ts (THE CENSUS), which is scanned against
 *  apps/api/src both ways: a new server kind fails the suite until someone
 *  decides where its tap lands, and a case here that nothing sends fails too.
 *  Screen names are checked against the real navigators — 'HomeTabs' once
 *  looked like a route and was not one, so its pushes silently went nowhere.
 *  `openApp` is consulted only for a payload with no server-tagged audience. */
export function destinationFor(data: Record<string, unknown> | null | undefined, openApp?: OpenApp): Destination | null {
  if (!data) return null;
  // [DRILL-STORM · S-19] An OPS PAGE — any payload carrying the ops alert it belongs to (an SOS page, a
  // platform page, a re-page, the drill, a failed drill) — opens that page on the responder's Ops alerts
  // screen, where it is acknowledged. Until now these taps opened nothing (or a customer's order screen),
  // so a page could only be stopped from a computer. Only ops pages carry an opsAlertId.
  const opsAlertId = data['opsAlertId'];
  if (typeof opsAlertId === 'string' && opsAlertId) return { screen: 'OpsAlerts', params: { opsAlertId } };
  if (data['kind'] === 'billing_mmg_checkout') return { screen: 'WeeklyFee', params: { ref: typeof data['ref'] === 'string' ? data['ref'] : undefined, subscriptionId: typeof data['subscriptionId'] === 'string' ? data['subscriptionId'] : undefined, vendorId: typeof data['vendorId'] === 'string' ? data['vendorId'] : undefined } };
  const kind = typeof data['kind'] === 'string' ? (data['kind'] as string) : '';
  const orderId = typeof data['orderId'] === 'string' ? (data['orderId'] as string) : undefined;
  // Server-tagged surface ('customer' | 'earner' | 'business'), merged into
  // data by NotificationService.send. Present on only some payloads today.
  const audience = typeof data['audience'] === 'string' ? (data['audience'] as string) : '';

  // [PUSH-ROUTING · board row 331] THE WEEKLY FEE. Only billing_mmg_checkout
  // was routed: billing_final_warning ("suspension is imminent") and
  // billing_suspended ("you cannot earn until you pay") opened the app
  // wherever it was. Every partner fee notice now opens the Weekly fee screen,
  // the one place the fee is seen and paid, on the family it is about. The
  // payload names the subscription, not the store, so a store fee opens on the
  // store the owner has selected; it carries no checkout ref to invent.
  if (PARTNER_FEE_KINDS.has(kind)) return { screen: 'WeeklyFee', params: { feeFamily: feeFamilyOf(audience, openApp) } };

  // [PUSH-ROUTING] DOCUMENTS. "Your document was rejected — fix it and
  // resubmit" opened nothing; it opens the documents of the role it is about.
  if (DOCUMENT_KINDS.has(kind)) return documentsFor(audience, openApp);
  // Taken offline for a lapsed document, a vehicle's papers lapsed, or a
  // routine review wants them re-submitted: renewing them is the way back.
  if (MOVER_DOCUMENT_KINDS.has(kind)) return { screen: 'MoverDocuments' };
  // "Your ID is on file" — the customer's ID screen shows it.
  if (kind === 'verification_l2') return { screen: 'IdentityVerification' };
  // Trusted status earned: no screen shows the trust tier; the notice is the
  // whole message. A review of theirs was removed: the payload names no rating
  // and no store. The person a trip was shared with: the trip ended, and they
  // own no order. [SEC-PII] A deletion request waiting for a review: the notice says why and when, and is the whole
  // message. Each opens HOME on purpose (census reasons). (Builds 9-12 open the app normally for erasure_delayed.)
  if (kind === 'trust_l3' || kind === 'rating_removed' || kind === 'trip_share_ended' || kind === 'erasure_delayed' || kind === 'erasure_completed') return { screen: HOME_SCREEN };

  // [Row 55] A store team invite is answered on the inbox, where its Accept /
  // Decline card sits (the invitee joins only by accepting there).
  if (kind === 'staff_invite') return { screen: 'Storefront', params: { screen: 'Notifications' } };

  // Rides: queue outcomes + anything ride-flavoured lands on the taxi screen
  // (it reads the active ride itself — T21 restore does the rest).
  if (kind === 'ride_queue_matched' || kind === 'ride_queue_expired' || kind.startsWith('ride_')) {
    return { screen: 'Taxi' };
  }
  // [PUSH-ROUTING] "Drivers are back near you — request your ride": only the
  // Taxi screen's "tell me when drivers are back" creates that watch. And "your
  // trip share link was reset — share your trip again": only Taxi shares a
  // trip. Its orderId sent it to Delivery, a screen a ride never renders on.
  if (kind === 'supply_returned' || kind === 'trip_share_rotated') return { screen: 'Taxi' };

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
  // [OF-33] "Pick up now or release the order" goes to the RIDER who holds the
  // job; ActiveJob is where they pick it up or hand it back. Its orderId would
  // otherwise send it down the generic branch to the CUSTOMER Delivery screen.
  if (kind === 'pickup_overdue') return { screen: 'ActiveJob' };
  // [AF-MOB-006] Custody recovery. The holder's live job carries the handoff
  // code; the relay rider's task waits on their dashboard until custody is theirs.
  if (kind === 'custody_handoff_code') return { screen: 'ActiveJob' };
  if (kind === 'custody_relay_assigned' || kind === 'custody_relay_cancelled') return { screen: 'Main' };
  // [L07] The customer cancelled the delivery this RIDER held. The job is gone,
  // so the tap opens their dashboard (MoverStack Main). Its orderId used to
  // send it down the generic branch to Delivery, the CUSTOMER screen.
  if (kind === 'mover_job_cancelled') return { screen: 'Main' };
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
  // [O-1] "Swift is calling you about your order": sent just before a Swift-
  // bridged call rings this person. It names the order as callOrderId (never
  // orderId), so an older app that has no case here opens itself instead of a
  // Delivery screen that cannot show a rider's or a store's job. Here it opens
  // the order where this person works it: a store on its order desk, a mover on
  // their live job (a driver on the ride), a customer on their tracking screen.
  if (kind === 'call_incoming') {
    const callOrderId = typeof data['callOrderId'] === 'string' ? (data['callOrderId'] as string) : undefined;
    const taxi = data['orderType'] === 'TAXI';
    if (audience === 'business') return callOrderId ? { screen: 'VendorOrderDetail', params: { orderId: callOrderId } } : { screen: 'VendorRoot' };
    if (audience === 'earner') return { screen: taxi ? 'Main' : 'ActiveJob' };
    if (taxi) return { screen: 'Taxi' };
    return callOrderId ? { screen: 'Delivery', params: { orderId: callOrderId } } : { screen: HOME_SCREEN };
  }
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
  // tap aimed there opened nothing. The push carries the bookingId, not the
  // orderId a Delivery deep link needs, so the customer copy used to return
  // null. [PUSH-ROUTING] It now opens OrdersHistory, their orders list: a
  // reschedule moves Order.appointmentSlot with the booking [Q12], and that
  // list prints each appointment's slot. An untagged row (the API tags both
  // copies; only an old inbox row has no tag) cannot say whose it is, so it
  // still opens the app normally. [BOOK-FU2] The API no longer sends it: a
  // move is now appointment_moved (below), because builds 9, 11 and 12 opened
  // this kind on ServiceJobs with the rest of the booking_ prefix. This case
  // stays for the inbox rows sent before that.
  if (kind === 'booking_rescheduled') {
    if (audience === 'business') return { screen: 'Schedule' };
    return audience === 'customer' ? { screen: 'OrdersHistory' } : null;
  }

  // [S4 · BOOK-MEASURE R5] A STORE appointment's 24h reminder. It used to be
  // sent as booking_reminder with the Booking id as refId, and the booking_
  // prefix below opened ServiceJobs, the marketplace jobs list, which never
  // shows a store booking. It now has its own kind, outside that prefix on
  // purpose: builds 9, 11 and 12 send the whole prefix to ServiceJobs, while
  // this kind reaches their order branches instead (business + orderId → the
  // order desk, orderId → the booking's order screen), exactly as here. The API
  // tags both copies. business = the store: the booking's order on its order
  // desk, where it is completed or cancelled; a booking with no order on file
  // opens the Schedule agenda, which lists it. customer = the person booked:
  // the booking's order screen (Delivery renders an appointment's status); with
  // no order on file, their orders list. An untagged copy cannot say whose it
  // is, so it opens the app normally rather than guess a stack.
  // [BOOK-FU2] appointment_moved (a store appointment moved; the other side is
  // told) takes the same branch for the same reason: it replaced
  // booking_rescheduled, which builds 9, 11 and 12 opened on ServiceJobs, and
  // those builds route this kind through their order branches exactly as here.
  // A move updates the order's time, so the order screen and the order desk
  // both show the new time.
  if (kind === 'appointment_reminder' || kind === 'appointment_moved') {
    if (audience === 'business') return orderId ? { screen: 'VendorOrderDetail', params: { orderId } } : { screen: 'Schedule' };
    if (audience === 'customer') return orderId ? { screen: 'Delivery', params: { orderId } } : { screen: 'OrdersHistory' };
    return null;
  }

  // BOOKINGS + SERVICE JOBS [S0: a push landing on a dead screen]. Every other
  // booking_* kind is a service JOB event carrying jobId/refId and no orderId
  // (quoted · to_confirm · confirmed · slot_declined · started · reminder
  // · completed · cancelled), so the family resolves above the order fallback: a job push
  // must never win a tracking screen. ServiceJobs ("My Jobs") is the ONE
  // screen that renders that job for BOTH sides — GET /services/jobs returns
  // rows where the caller is the customer OR the provider, and the provider's
  // quote / confirm-time / can't-make-it / mark-complete actions live on the
  // same card the push is about. Matched by PREFIX, like ride_ above, because
  // this family is still growing (completed + cancelled landed mid-audit);
  // enumerating it is how three kinds went unrouted in the first place.
  // No params: ServiceJobsScreen takes none — it lists every job — so a jobId
  // here would be an invented route param a screen never reads. A per-job deep
  // screen does not exist yet [reported, not invented]. booking_reminder is a
  // service job's reminder only: a store appointment's is appointment_reminder
  // (above) since S4. An inbox row sent before S4 still carries booking_reminder
  // with a Booking id and still opens this list; its refId cannot say which.
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
  // [PAYMENT-SIMPLIFY] The store's MMG NUMBER replaces its link; its change notices land in the same place, where
  // the MMG number card shows the pending change and its "This wasn't me".
  if (kind === 'mmg_number_change_staged' || kind === 'mmg_number_change_applied' || kind === 'mmg_number_change_cancelled') {
    return { screen: 'Account' };
  }
  // [Q8 · DS269 F1] Someone on the team moved the store's map pin. The owner
  // lands on Account, where the Store location card shows it and moves it back.
  if (kind === 'store_pin_moved') return { screen: 'Account' };
  // [owner #51] A store whose documents are done waits only for the number
  // customers can call: the vendor root (the waiting store's own screen) asks for it.
  if (kind === 'vendor_needs_public_phone') return { screen: 'Main' };
  // [FOOD-PERMIT · owner 24 Oct 2026] A registered restaurant ticks that everyone who handles its food holds a current
  // food handler's certificate: the tick is in the store's Documents, on Account.
  if (kind === 'vendor_needs_food_handler_tick') return { screen: 'VendorRoot', params: { screen: 'Account' } };
  // [PUSH-ROUTING] STORE SURFACES, on VendorRoot after the router selects the
  // store (go() validates the account and the store first). Stock ran low, or a
  // category the store asked for was added, mapped or declined: the catalogue
  // tab, where stock and availability are set and items are tagged. Neither
  // payload names the store, so it opens on the selected one.
  if (kind === 'low_stock' || kind === 'category_request_resolved') return { screen: 'VendorRoot', params: { screen: 'Menu' } };
  // [row 55] Someone accepted the owner's invite: the team panel is on Account.
  if (kind === 'staff_joined') return { screen: 'VendorRoot', params: { screen: 'Account' } };
  // The person ADDED to a team: the store they joined (its vendorId selects
  // it), reached in Business mode, which the body tells them to choose.
  if (kind === 'staff_added') return { screen: 'VendorRoot' };
  // [PUSH-ROUTING] The store replied to the customer's review: that store's
  // reviews page shows the reply.
  if (kind === 'review_response') {
    return typeof data['vendorId'] === 'string' ? { screen: 'VendorReviews', params: { vendorId: data['vendorId'] } } : { screen: HOME_SCREEN };
  }
  // A support ticket was updated or resolved: GetHelp lists "Your tickets"
  // with their status, and it is mounted in every navigator.
  if (kind === 'support_update') return { screen: 'GetHelp' };

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
  // [PUSH-ROUTING] The other two case notices to the SUBJECT, for the same
  // reason. Kept online while a report is reviewed ("contact support to
  // respond"), or the interim action lifted while another review still
  // restricts them (that body says contact support too): support. Lifted with
  // nothing left ("you can go back online"): their home, the dashboard where
  // they go online.
  if (kind === 'incident_shadow_restricted' || (kind === 'incident_interim_lifted' && data['restrictionRemains'] === true)) {
    return { screen: 'GetHelp', params: { category: 'ACCOUNT', subject: 'Account under review' } };
  }
  if (kind === 'incident_interim_lifted') return { screen: HOME_SCREEN };
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

  // Only a producer-authoritative taxi marker selects this destination.
  // A cancelled driver's ride is no longer ActiveJob; Main mounts their
  // available mover home. Bare historical order ids keep the generic contract.
  if (data['orderType'] === 'TAXI' && orderId && data['rideId'] === orderId) {
    if (audience === 'earner') return { screen: 'Main' };
    if (audience === 'customer') return { screen: 'Taxi' };
  }

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

/** [row 205 · DS256 F2] A tap made while signed out, held for the sign-in it
 *  opens. Before this, it was routed at once into a root that does not mount
 *  its screen (the picker, sign-in, a guest) and lost: a safety check-in or a
 *  ride notice tapped after a session ended landed nowhere after signing back
 *  in. It replays only for the account whose session this device last held
 *  (that account's push token delivered it; logout revokes the token), once
 *  that account is through every root gate. A different account, a cancelled
 *  sign-in, or an unknown owner (a cold start after sign-out) drops it
 *  silently. Process-local and one-shot, like the auth continuation. */
let heldForSignIn: { data: Record<string, unknown>; forUserId: string } | null = null;

function isVendorDestination({ dest, data }: Tap): boolean {
  // VendorRoot [PUSH-ROUTING]: the store's own screen and its tabs (stock,
  // the team, its documents) — validated and selected like every store route.
  return ['VendorOrderDetail', 'VendorCategoryReview', 'VendorTier', 'Schedule', 'VendorRoot'].includes(dest.screen)
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

/** [STORE-ALERT 18 Oct 2026] A "New Order!" push tapped while another app of
 *  Swift is open (one account is often a customer AND a store owner): the
 *  store screens are not mounted, so the route used to land nowhere. The
 *  global StoreAlertElsewhere layer registers here, asks to open the store,
 *  switches apps through the server's switch-role, then routes the same data
 *  again (routeNotificationData). */
type BusinessTapElsewhere = (data: Record<string, unknown>) => void;
let businessTapElsewhere: BusinessTapElsewhere | null = null;

export function setBusinessTapElsewhereHandler(handler: BusinessTapElsewhere | null): () => void {
  businessTapElsewhere = handler;
  return () => { if (businessTapElsewhere === handler) businessTapElsewhere = null; };
}

/** Route notification data exactly as a tap would (the same attempt fencing). */
export function routeNotificationData(data: Record<string, unknown>): void {
  routeTap(data);
}

async function go(tap: Tap) {
  if (tap.attempt !== routing) return;
  if (!navigationRef.isReady()) { pending = tap; return; }
  if (tap.data['kind'] === 'vendor_order_alert' && isVendorDestination(tap) && businessTapElsewhere
    && useAuthStore.getState().intent !== 'vendor') {
    businessTapElsewhere(tap.data);
    return;
  }
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
    // billing_mmg_checkout without a store is a mover's checkout. Every other
    // fee notice already names its family [PUSH-ROUTING], and that stands.
    dest = { ...dest, params: { feeFamily: 'mover', ...dest.params } };
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

/** The app open at tap time — asked only by a payload with no audience tag. */
const openApp: OpenApp = () => useAuthStore.getState().intent;

function routeTap(data: Record<string, unknown>) {
  const dest = destinationFor(data, openApp);
  const attempt = ++routing;
  pending = null;
  heldForSignIn = null; // a newer tap replaces one still waiting for sign-in
  if (!dest) return;
  const owner = getAuthSessionSnapshot();
  if (!owner) { holdForSignIn(data); return; }
  const { selectedStoreId, storeGeneration } = useStoreSwitcher.getState();
  void go({ dest, data, attempt, owner, selection: { selectedStoreId, storeGeneration } }).catch(() => undefined);
}

function holdForSignIn(data: Record<string, unknown>) {
  const forUserId = getLastSignedOutUserId();
  if (!forUserId) return; // whose tap this is is unknown: the app opens normally
  heldForSignIn = { data, forUserId };
  useAuthStore.getState().promptLogin();
}

export type HeldTapResult = 'none' | 'waiting' | 'delivered' | 'dropped';

/** RootNavigator calls this whenever its root gate changes. A tap held for
 *  sign-in is routed once the account that owns it is signed in and the app
 *  root is open; a different account or a cancelled sign-in drops it. */
export function settleTapAfterSignIn(state: {
  isAuthenticated: boolean; wantsAuth: boolean; entryGate: string;
}): HeldTapResult {
  const held = heldForSignIn;
  if (!held) return 'none';
  if (!state.isAuthenticated) {
    if (state.wantsAuth) return 'waiting';
    heldForSignIn = null; // sign-in cancelled (or never started): terminal
    return 'dropped';
  }
  const owner = getAuthSessionSnapshot();
  if (owner && owner.userId !== held.forUserId) { heldForSignIn = null; return 'dropped'; }
  if (!owner || state.entryGate !== 'main' || !navigationRef.isReady()) return 'waiting';
  heldForSignIn = null;
  routeTap(held.data);
  return 'delivered';
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
    routing++; pending = null; heldForSignIn = null;
    sub.remove();
  };
}

/** Test seam: is anything queued? */
export function hasPendingNavigation(): boolean {
  return pending != null && !navigationRef.isReady();
}
