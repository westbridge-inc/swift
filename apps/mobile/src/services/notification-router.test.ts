import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

// Pure routing-table test — the expo/notifications + navigation modules are
// side-effect imports the table doesn't need; mock them to nothing.
vi.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: () => ({ remove: () => undefined }),
  getLastNotificationResponseAsync: () => Promise.resolve(null),
}));
vi.mock('../navigation/navigationRef', () => ({
  navigationRef: { isReady: () => false },
  safeNavigate: () => false,
}));

vi.mock('../stores/authStore', () => ({ getAuthSessionSnapshot: () => null }));
vi.mock('../stores/storeSwitcher', () => ({ useStoreSwitcher: { getState: () => ({ selectedStoreId: null, storeGeneration: 0 }) } }));

import { destinationFor } from './notification-router';

// The tap-router's single source of truth [first-open 2.4]: every payload
// kind lands exactly where its journey lives; unknown payloads return null
// (the app opens normally — never a guess, never a crash).

describe('destinationFor — the tap table', () => {
  it('queue outcomes and ride kinds land on Taxi', () => {
    expect(destinationFor({ kind: 'ride_queue_matched', orderId: 'o1' })).toEqual({ screen: 'Taxi' });
    expect(destinationFor({ kind: 'ride_queue_expired' })).toEqual({ screen: 'Taxi' });
    // ride_sos_ack is NOT a kind the API sends today — it stands in for the
    // ride_ PREFIX rule, which is what covers a ride kind shipped tomorrow.
    expect(destinationFor({ kind: 'ride_sos_ack' })).toEqual({ screen: 'Taxi' });
  });

  it('an unavailable queue notice opens the ride picker without retry parameters', () => {
    expect(destinationFor({ kind: 'ride_queue_unavailable', audience: 'customer' }))
      .toEqual({ screen: 'Taxi' });
  });

  it('an OFFER ping lands the earner on their mover home, never the customer screen [E36 / danger #22]', () => {
    // Pre-fix, the generic orderId branch dropped an earner mid-countdown on
    // the CUSTOMER Delivery screen — a dead end with the clock running.
    expect(destinationFor({ kind: 'dispatch_offer', orderId: 'o9' })).toEqual({ screen: 'Main' });
    // A store's "cancelled order may hold an MMG payment" opens their dashboard.
    expect(destinationFor({ kind: 'mmg_unattested_cancellation', orderId: 'o9' })).toEqual({ screen: 'Main' });
  });

  it('anything carrying an orderId lands on that order’s tracking screen', () => {
    // [Q10] This used prep_ready as its example, but prep_ready goes to the
    // RIDER, never the customer: it has its own branch now (ActiveJob).
    expect(destinationFor({ kind: 'substitution_pending', orderId: 'abc' })).toEqual({ screen: 'Delivery', params: { orderId: 'abc' } });
    expect(destinationFor({ orderId: 'xyz' })).toEqual({ screen: 'Delivery', params: { orderId: 'xyz' } });
  });

  it('unknowns open the app normally', () => {
    // [PUSH-ROUTING] This used billing_topup, a real partner notice that now
    // opens the fee screen; a kind nothing sends is the unknown it meant.
    expect(destinationFor({ kind: 'kind_nothing_sends' })).toBeNull();
    expect(destinationFor({})).toBeNull();
    expect(destinationFor(null)).toBeNull();
  });

  it('ride kinds outrank the orderId fallback (a taxi push opens Taxi, not Delivery)', () => {
    expect(destinationFor({ kind: 'ride_queue_matched', orderId: 'ride-order' })).toEqual({ screen: 'Taxi' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// S0: PUSHES THAT OPENED THE APP AND DID NOTHING
// ───────────────────────────────────────────────────────────────────────────

describe('a push never lands on a route its recipient cannot reach [S0]', () => {
  // THE SHAPE OF THIS WHOLE CLASS OF BUG. `Delivery` is the CUSTOMER order
  // screen. It is mounted by CustomerStack and by nothing else — so a push
  // aimed there for a MOVER or a STORE hit `safeNavigate` on a route their
  // navigator never mounts, the navigate was silently unhandled, and the app
  // opened on whatever was last on screen. Three kinds sat like that: an
  // agent chasing a store for an order, a rider told their guarantee claim was
  // out of range, and a mover told their account was suspended.
  //
  // They are fixed three different ways, and the difference is the lesson:
  // one needed the SERVER to say who it was for (audience), and two needed a
  // destination that EXISTS for the recipient at all.

  it('a store chased about an order lands on their order desk, not the customer screen', () => {
    // The server tags the audience — the router cannot infer "this orderId is
    // for the store" from an orderId alone.
    //
    // [NO-AI] This used to be carried by `agent_vendor_ping`, sent by the ops
    // agent. The agent is gone, but the INVARIANT is not: any future
    // business-audience push with only an orderId would fall through to the
    // customer tracking screen, a route VendorStack never mounts. The rule is
    // tested through the router's own audience branch rather than deleted with
    // the one kind that happened to exercise it.
    expect(destinationFor({ kind: 'vendor_order_alert', orderId: 'o1', audience: 'business' }))
      .toEqual({ screen: 'VendorOrderDetail', params: { orderId: 'o1' } });
  });

  it('the two pushes that say "contact support" open support', () => {
    // Both bodies instruct the recipient to contact Swift. GetHelp is mounted
    // in every navigator, which is precisely why liveness_locked already uses
    // it — a mover-bound destination has to exist inside MoverStack.
    expect(destinationFor({ kind: 'incident_interim_suspension', orderId: 'o1', caseNumber: 'INC-1' }))
      .toEqual({ screen: 'GetHelp', params: { category: 'ACCOUNT', subject: 'Account suspended pending review' } });
    expect(destinationFor({ kind: 'claim_over_gate', orderId: 'o1' }))
      .toEqual({ screen: 'GetHelp', params: { category: 'PAYMENT', subject: 'Delivery guarantee claim', orderId: 'o1' } });
  });

  it('none of the three still falls through to the customer Delivery screen', () => {
    // The regression this guards: any of them losing its branch drops straight
    // back into the generic `if (orderId)` catch-all at the bottom.
    for (const data of [
      { kind: 'vendor_order_alert', orderId: 'o1', audience: 'business' },
      { kind: 'incident_interim_suspension', orderId: 'o1' },
      { kind: 'claim_over_gate', orderId: 'o1' },
    ]) {
      expect(destinationFor(data)!.screen, `${data.kind} must not land on Delivery`).not.toBe('Delivery');
    }
  });

  it('a CUSTOMER push with an orderId still goes to Delivery (guards the guard)', () => {
    // The catch-all is right for the case it was written for; these branches
    // must not have broken it. (It used prep_ready, which is a RIDER push.)
    expect(destinationFor({ kind: 'substitution_pending', orderId: 'o1' }))
      .toEqual({ screen: 'Delivery', params: { orderId: 'o1' } });
  });

  it('the rider told the bag is ready lands on their live job, not the customer screen [Q10]', () => {
    // prep_ready is sent to the ASSIGNED RIDER when the kitchen marks the
    // order ready. Its orderId sent it to Delivery, which MoverStack never
    // mounts: the rider tapped "Order ready for pickup" and nothing opened.
    expect(destinationFor({ kind: 'prep_ready', orderId: 'o1', audience: 'earner' })).toEqual({ screen: 'ActiveJob' });
    // Untagged rows from before the API tagged it route the same way.
    expect(destinationFor({ kind: 'prep_ready', orderId: 'o1' })).toEqual({ screen: 'ActiveJob' });
    // [L07] The customer cancelled the rider's delivery: the mover dashboard, not Delivery.
    expect(destinationFor({ kind: 'mover_job_cancelled', orderId: 'o1', status: 'CANCELLED', audience: 'earner' })).toEqual({ screen: 'Main' });
  });
});

describe('booking + service-job pushes land on the job [S0]', () => {
  // Before: booking_to_confirm / booking_confirmed / booking_slot_declined had
  // no case at all (null → "the app opens normally"), and booking_reminder
  // pointed at 'HomeTabs' — a route name that exists NOWHERE in the app (the
  // customer tabs route is 'Tabs'), so its navigate was silently unhandled.
  // A provider read "a customer wants to confirm Tuesday 09:00", tapped, and
  // landed on the home screen.
  it('every service-job kind opens My Jobs — the one screen that shows that job to BOTH sides', () => {
    for (const kind of [
      // The request itself — the rung that had no notification at all, so the
      // provider never learned there was anything to quote on.
      'booking_requested',
      'booking_quoted',
      'booking_to_confirm',
      'booking_confirmed',
      'booking_slot_declined',
      'booking_started',
      'booking_completed',
      'booking_cancelled',
    ]) {
      expect(destinationFor({ kind, jobId: 'job-1' })).toEqual({ screen: 'ServiceJobs' });
    }
    // The 24h reminder carries refId (job OR appointment) instead of jobId.
    expect(destinationFor({ kind: 'booking_reminder', refId: 'job-1' })).toEqual({ screen: 'ServiceJobs' });
  });

  it('routes by PREFIX, so the next booking_ kind is not born dead', () => {
    // booking_completed and booking_cancelled were added to the API DURING
    // this audit; an enumerated list is how three kinds went unrouted.
    expect(destinationFor({ kind: 'booking_not_shipped_yet', jobId: 'j' })).toEqual({ screen: 'ServiceJobs' });
  });

  it('carries no params — ServiceJobsScreen reads none, and an ignored param is a lie', () => {
    const dest = destinationFor({ kind: 'booking_to_confirm', jobId: 'job-1' });
    expect(dest).not.toBeNull();
    expect(dest!.params).toBeUndefined();
  });

  it('a moved APPOINTMENT opens the store’s Schedule agenda, not the jobs list', () => {
    // booking_rescheduled is the one booking_ kind that is not a service job:
    // it carries bookingId (a slot on a vendor calendar). The STORE's copy is
    // tagged audience:'business' and opens their Schedule agenda.
    expect(destinationFor({ kind: 'booking_rescheduled', bookingId: 'b1', audience: 'business' })).toEqual({ screen: 'Schedule' });
    // The customer's copy is tagged audience:'customer'. The customer stack
    // never mounts Schedule, so a tap aimed there was silently dropped [E28].
    // [PUSH-ROUTING] It opened nothing after that; it now opens their orders,
    // where the appointment's order shows the moved time [Q12] — a screen
    // CustomerStack mounts (asserted with the customer copies below).
    expect(destinationFor({ kind: 'booking_rescheduled', bookingId: 'b1', audience: 'customer' })).toEqual({ screen: 'OrdersHistory' });
    // Untagged legacy rows are nobody-placeable: opening the app normally is
    // the safe answer, never a dead navigate into a vendor-only screen.
    expect(destinationFor({ kind: 'booking_rescheduled', bookingId: 'b1' })).toBeNull();
  });
});

describe('store pushes land on the store’s order desk, never the customer screen', () => {
  it('THE vendor order alert opens that order, with its number when the payload carries one', () => {
    expect(destinationFor({ kind: 'vendor_order_alert', orderId: 'o1', orderNumber: 'SW-1001', status: 'PENDING' }))
      .toEqual({ screen: 'VendorOrderDetail', params: { orderId: 'o1', orderNumber: 'SW-1001' } });
  });

  it('omits orderNumber rather than inventing one', () => {
    expect(destinationFor({ kind: 'vendor_order_alert', orderId: 'o1' }))
      .toEqual({ screen: 'VendorOrderDetail', params: { orderId: 'o1' } });
    expect(destinationFor({ kind: 'vendor_order_alert', orderId: 'o1', orderNumber: 42 }))
      .toEqual({ screen: 'VendorOrderDetail', params: { orderId: 'o1' } });
  });

  it('a server-tagged business audience routes by itself — same kind, two audiences, two screens', () => {
    // dispatch_exhausted is sent to the customer AND to the store; only the
    // store's copy is tagged audience:'business'.
    expect(destinationFor({ kind: 'dispatch_exhausted', orderId: 'o2', audience: 'customer' }))
      .toEqual({ screen: 'Delivery', params: { orderId: 'o2' } });
    expect(destinationFor({ kind: 'dispatch_exhausted', orderId: 'o2', audience: 'business' }))
      .toEqual({ screen: 'VendorOrderDetail', params: { orderId: 'o2' } });
  });

  it('a deliberate business destination still outranks the audience rule', () => {
    expect(destinationFor({ kind: 'mmg_unattested_cancellation', orderId: 'o3', audience: 'business' }))
      .toEqual({ screen: 'Main' });
  });

  it('the "still waiting" re-alert opens the same order: exactly the payload escalateVendorAlert sends [Q10]', () => {
    // The re-alert push is not an inbox row, so the census below cannot see
    // its shape. It used to carry only the orderId, which the generic branch
    // sends to the CUSTOMER Delivery screen the vendor app never mounts.
    expect(destinationFor({ orderId: 'o1' })).toEqual({ screen: 'Delivery', params: { orderId: 'o1' } });
    expect(destinationFor({
      kind: 'vendor_order_alert', orderId: 'o1', orderNumber: 'SW-1001', audience: 'business', respondBy: '2026-09-24T20:10:00.000Z',
    })).toEqual({ screen: 'VendorOrderDetail', params: { orderId: 'o1', orderNumber: 'SW-1001' } });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE CENSUS — every `kind` the API sends, with the destination it gets.
//
// Rebuilt by scanning apps/api/src for `kind: '…'` push payloads. `to: null`
// means "the app opens normally": for an ops/admin page that is correct (there
// is no mobile admin surface). The drift test underneath fails the moment the
// API grows a kind that is not in this table, which is what stops the next
// booking_to_confirm from shipping dead.
//
// [PUSH-ROUTING · board row 331] A user-facing kind may NOT be null. This table
// used to carry 53 rows marked GAP: 7 for operations, 13 for advertisers, and
// 33 for people who use the app (billing_final_warning, billing_suspended,
// verification_*), whose tap opened nothing. Every row is now one of:
//   - `why` starts "admins"  — operations; there is no mobile admin app.
//   - `why` starts "ADS OFF" — advertiser kinds; ads are off at launch
//     (GUARDRAILS §4), so they are routed when ads go on.
//   - anything else          — a person using the app: a real screen of their
//     role, or HOME on purpose with `why` starting "HOME:" and its reason.
// "no user-facing push opens nothing" below grades the ROUTER, not this table.
// ───────────────────────────────────────────────────────────────────────────

type Dest = { screen: string; params?: Record<string, unknown> } | null;
type Case = {
  /** payload data.kind */
  k: string;
  /** the rest of the payload that matters to routing (as the API sends it) */
  d?: Record<string, unknown>;
  /** where the tap lands today */
  to: Dest;
  /** who receives it + why this destination (or why it is a gap) */
  why: string;
  /** false when the API builds the kind dynamically, so the source scan below
   *  cannot see it as a literal */
  scan?: false;
};

const DELIVERY = (orderId: string): Dest => ({ screen: 'Delivery', params: { orderId } });
const O = { orderId: 'o1' };
/** The app's home: every role stack is mounted under the root route Main. */
const HOME: Dest = { screen: 'Main' };
/** The Weekly fee screen, opened on the paying family the notice is about. */
const FEE = (feeFamily: 'mover' | 'vendor'): Dest => ({ screen: 'WeeklyFee', params: { feeFamily } });
/** A tab of the store's own screen (VendorRoot), after the router selects the store. */
const VENDOR_TAB = (screen: 'Account' | 'Menu'): Dest => ({ screen: 'VendorRoot', params: { screen } });

const CENSUS: Case[] = [
  // ── Orders: the customer's own journey. Delivery IS their tracking screen.
  { k: 'substitution_pending', d: { ...O, lineId: 'l1' }, to: DELIVERY('o1'), why: 'customer — approve a substitution' },
  { k: 'line_refunded', d: { ...O, lineId: 'l1' }, to: DELIVERY('o1'), why: 'customer — a line was refunded' },
  { k: 'mmg_payment_confirmed', d: { ...O, audience: 'customer', claimRevision: 1 }, to: DELIVERY('o1'), why: 'customer — the STORE reported the MMG payment arrived: a claim, never a capture; the order screen is where they can say they did not pay [S1-6]' },
  { k: 'mmg_claim_disputed', d: { ...O, audience: 'customer', claimRevision: 2 }, to: DELIVERY('o1'), why: 'customer — their word and the store\'s disagree and the order is held; the claim card is on their order screen. The store\'s copy is tagged audience:business and lands on its order desk by the audience rule [S1-6]' },
  { k: 'mmg_claim_resolved', d: { ...O, audience: 'customer', claimRevision: 3 }, to: DELIVERY('o1'), why: 'customer — an operator decided the payment disagreement; same audience split as mmg_claim_disputed [S1-6]' },
  { k: 'handover_review', d: O, to: DELIVERY('o1'), why: 'customer — failed delivery recorded' },
  { k: 'delivery_options', d: O, to: DELIVERY('o1'), why: 'customer — supply is thin, pick another option' },
  { k: 'delivery_cash_settlement', d: { ...O, settlementId: 's1', status: 'OPEN' }, to: DELIVERY('o1'), why: 'cash settlement on that order' },
  { k: 'dispatch_retrying', d: { ...O, audience: 'customer' }, to: DELIVERY('o1'), why: 'customer — still looking for a mover' },
  { k: 'converted_to_pickup', d: { ...O, audience: 'business' }, to: { screen: 'VendorOrderDetail', params: { orderId: 'o1' } }, why: 'store — the order became a pickup [audience rule]' },
  { k: 'dispatch_exhausted', d: { ...O, audience: 'customer' }, to: DELIVERY('o1'), why: 'customer — no mover found' },
  { k: 'riderless_cutoff', d: { ...O, orderNumber: 'SW-1', audience: 'customer', canCancelFree: true, cancelsInMinutes: 15 }, to: DELIVERY('o1'), why: 'customer — [OF-01/17] no rider yet, they can cancel for free; the cancel is on their tracking screen' },
  { k: 'rider_no_show', d: { ...O, orderNumber: 'SW-1', status: 'READY_FOR_PICKUP', audience: 'customer' }, to: DELIVERY('o1'), why: 'customer — [OF-33] their rider did not come; a new rider is being found, on their tracking screen (the store copy, audience business, takes the order desk by the audience rule)' },
  { k: 'rider_waiting', d: { ...O, orderNumber: 'SW-1', audience: 'business' }, to: { screen: 'VendorOrderDetail', params: { orderId: 'o1' } }, why: 'store — [OF-33] their rider is at the counter and the order is not marked ready; the order desk (audience rule)' },
  { k: 'mover_session_revocation', d: { ...O, audience: 'customer', status: 'PICKED_UP', action: 'REOPEN' }, to: DELIVERY('o1'), why: 'customer — their mover lost custody' },
  { k: 'vendor_order_alert', d: { ...O, orderNumber: 'SW-1', status: 'PENDING', audience: 'business', respondBy: '2026-09-24T20:10:00.000Z' }, to: { screen: 'VendorOrderDetail', params: { orderId: 'o1', orderNumber: 'SW-1' } }, why: 'store — THE new-order alert [fixed here]. [Q10] It carries the auto-cancel deadline its push rings until, and the business audience' },
  { k: 'mmg_unattested_cancellation', d: { ...O, audience: 'business' }, to: { screen: 'Main' }, why: 'store — a cancelled order may still hold an MMG payment; their Main is the dashboard' },
  { k: 'vendor_customer_answered', d: { ...O, orderNumber: 'SW-1', audience: 'business' }, to: { screen: 'VendorOrderDetail', params: { orderId: 'o1' } }, why: 'store team — [O-4] the customer answered an out-of-stock question asked before acceptance; the order desk holds Accept [audience rule]' },
  { k: 'mmg_customer_says_paid', d: { ...O, audience: 'business' }, to: { screen: 'VendorOrderDetail', params: { orderId: 'o1' } }, why: 'store owner — [owner 18 Oct] the customer says they paid and the store has not tapped Paid by MMG 30 minutes after accepting; the order desk holds the Paid by MMG button [audience rule]' },
  // `d` must mirror what the API actually SENDS. The drift check compares only
  // `kind` strings, so a payload that grows a field goes unnoticed here and the
  // case then grades a shape nothing produces.
  { k: 'claim_over_gate', d: O, to: { screen: 'GetHelp', params: { category: 'PAYMENT', subject: 'Delivery guarantee claim', orderId: 'o1' } }, why: 'rider — the body says "support will follow up"; this is the door for someone who would rather not wait. GetHelp is mounted in every navigator. Was Delivery, which MoverStack never mounts' },
  { k: 'guardian_checkin', d: { ...O, sessionId: 's1', level: 'SOFT' }, to: { screen: 'Taxi' }, why: 'passenger mid-RIDE — the check-in card lives on Taxi, which asks the server whether one is outstanding. Was Delivery, a screen a ride never renders on, so the person being asked if they are safe could not answer' },
  { k: 'guardian_driver_confirm', d: { ...O, sessionId: 's1', cycleId: 'cy1', nonce: 'n1', respondBy: '2026-09-03T12:00:00.000Z' }, to: { screen: 'GuardianDriverConfirm', params: { sessionId: 's1', cycleId: 'cy1', nonce: 'n1', respondBy: '2026-09-03T12:00:00.000Z', orderId: 'o1' } }, why: '[TST-001] the DRIVER, on a screen MoverStack mounts. This used to route to Delivery — which MoverStack never mounts — and this census asserted that dead end as passing, on a SAFETY path, while POST /safety/guardian/driver-confirm sat with no caller. It carries the cycle and the nonce so the screen answers THAT check' },
  { k: 'guardian_deescalation', d: { ...O, sessionId: 's1', cycleId: 'cy1' }, to: DELIVERY('o1'), why: 'admins — [S-04] a passenger never answered a hard check and the driver de-escalated; the review is an ops surface, not mobile' },
  { k: 'guardian_checkin_undelivered', d: { ...O, sessionId: 's1', cycleId: 'cy1', delivery: 'PENDING' }, to: DELIVERY('o1'), why: 'admins — [S-06] a hard check-in that never reached the passenger; the deadline is held and a human looks — an ops surface' },
  { k: 'incident_duplicate_intake', d: { clusters: [] }, to: null, why: 'admins — [S-08] likely duplicate intakes that drove enforcement; review and merge is an ops surface' },
  { k: 'legal_hold_partial', d: { partial: [], failedVault: 0 }, to: null, why: 'admins — [S-09] a held case and its evidence disagree; deletion is frozen; an ops surface' },
  { k: 'safety_escrow_review', d: { holds: [] }, to: null, why: 'admins — [AG-XF-013] a deleted account\u2019s emergency contact details are still escrowed because a safety hold never closed. Confirming the hold is still real, or closing the case so erasure completes, is an ops act — and the person it concerns has already left, so there is no mobile destination' },
  { k: 'not_my_driver_discrepancy', d: { missingCase: [], missingDispatch: [], repaired: [] }, to: null, why: 'admins — [S-13] a not-my-driver decision lacked its case or its dispatch command; an ops surface' },
  { k: 'trip_share_rotated', d: { ...O }, to: { screen: 'Taxi' }, why: 'sharer — [S-16 · PUSH-ROUTING] their share link was reset and the body says to share the trip again; only the Taxi screen shares a trip. It routed by orderId to Delivery, a screen a ride never renders on (the guardian_checkin lesson)' },
  { k: 'trip_share_ended', d: { outcome: 'STOPPED_BY_RIDER' }, to: HOME, why: 'HOME: guardian — [L10 §2] the trip someone shared with them ended (stopped, completed, cancelled, or contact lost); they follow a trip, they own no order, so the notice is the whole message' },
  { k: 'ops_alert_escalated', d: { opsAlertId: 'a1', sosAlertId: 'a1', level: 1 }, to: null, why: 'admins — [S-19] an ops page nobody acknowledged by its deadline; the alert list is an ops surface' },
  { k: 'ops_alert_drill', d: { opsAlertId: 'a1' }, to: null, why: 'admins — [S-19] a scheduled or manual drill of the paging path; an ops surface' },
  { k: 'csae_report', d: { opsAlertId: 'a1', contentReportId: 'r1', targetType: 'USER' }, to: null, why: 'admins — [R19] a child-safety report pages operations; the moderation queue is an ops surface' },
  { k: 'safety_sweep_slo', d: { workType: 'guardian.open', stalled: true, passAgeSeconds: 1200 }, to: null, why: 'admins — [S-05] a safety sweep whose pass stalled past the SLO or whose rows keep failing; an ops surface, not mobile' },
  { k: 'incident_interim_suspension', d: { ...O, caseNumber: 'INC-1' }, to: { screen: 'GetHelp', params: { category: 'ACCOUNT', subject: 'Account suspended pending review' } }, why: 'suspended mover — the body says "contact Swift support to respond", and support is the ONLY way back. Same destination as liveness_locked, for the same reason. Was Delivery, which MoverStack never mounts' },
  { k: 'support_ticket', d: { ...O, ticketId: 't1' }, to: DELIVERY('o1'), why: 'admins — ops queue lives on the web console' },
  { k: 'sos_active', d: { ...O, sosAlertId: 'a1' }, to: DELIVERY('o1'), why: 'admins — SOS war room is not a mobile surface' },
  { k: 'ops_delivery_rider_dropped', d: O, to: DELIVERY('o1'), why: 'admins' },
  { k: 'ops_dispatch_exhausted', d: O, to: DELIVERY('o1'), why: 'admins' },
  { k: 'ops_food_too_old', d: O, to: DELIVERY('o1'), why: 'admins — [ALG-06] an order too old to deliver was cancelled by the system and needs a person' },
  { k: 'ops_rider_no_show', d: { ...O, riderId: 'r1' }, to: DELIVERY('o1'), why: 'admins — [OF-33] a rider accepted and never picked up; the order went back to dispatch' },
  { k: 'ops_rider_waiting', d: { ...O, riderId: 'r1' }, to: DELIVERY('o1'), why: 'admins — [OF-33] a rider is waiting at a store that has not marked the order ready' },
  { k: 'ops_rider_waiting_long', d: { ...O, riderId: 'r1', waitedMinutes: 61, opsAlertId: 'a1' }, to: DELIVERY('o1'), why: 'admins — [OF-33] the loud ops-alert page: a rider has waited 3 release windows at a store that is not ready; a person decides' },
  { k: 'ops_taxi_driver_dropped', d: O, to: DELIVERY('o1'), why: 'admins' },
  { k: 'ops_custody_case', d: { ...O, event: 'opened', caseId: 'c1', state: 'SUPPORT_HOLD' }, to: DELIVERY('o1'), why: 'admins — [AF-MOB-006] a custody recovery case opened, went overdue, lost its relay rider or locked its handoff; the case console is an ops surface' },
  { k: 'ops_cash_door_short', d: { ...O, due: 3500, collected: 2800, shortfall: 700 }, to: DELIVERY('o1'), why: 'admins — [L02 row 34] a cash order was handed over for less than due; the mismatch is held for review' },
  { k: 'ops_cash_return_held', d: { ...O, amount: 2000, opsAlertId: 'a1' }, to: DELIVERY('o1'), why: 'admins — partial cash could not be handed back and remains with the rider for operations' },
  { k: 'RATING_REMINDER', d: O, to: DELIVERY('o1'), why: 'customer — rate a finished order (the one SHOUTY kind)', scan: false },
  { k: 'ops_mover_session_ended:o1', d: O, to: DELIVERY('o1'), why: 'admins — kind is built with the orderId appended', scan: false },

  // ── Rides: the taxi screen reads the active ride itself.
  { k: 'ride_queue_matched', d: { ...O, audience: 'customer' }, to: { screen: 'Taxi' }, why: 'customer — a driver took their queued ride' },
  { k: 'ride_queue_expired', d: { audience: 'customer', rideClass: 'STANDARD' }, to: { screen: 'Taxi' }, why: 'customer — queue timed out, request again' },
  { k: 'ride_queue_unavailable', d: { audience: 'customer' }, to: { screen: 'Taxi' }, why: 'customer — the queued class is no longer offered; choose an available class without retrying the retired trip' },
  { k: 'ride_released_no_drivers', d: { ...O, audience: 'customer' }, to: { screen: 'Taxi' }, why: 'customer — ride released' },
  { k: 'dispatch_offer', d: { ...O, audience: 'earner', offerAttemptId: 'a1', expiresAt: '2026-09-24T20:00:20.000Z' }, to: { screen: 'Main' }, why: 'earner — the live offer card is on their Main' },
  { k: 'custody_handoff_code', d: { ...O, caseId: 'c1' }, to: { screen: 'ActiveJob' }, why: 'RIDER holding the goods — [AF-MOB-006] a relay rider is coming; the handoff code is on their live job, which MoverStack mounts' },
  { k: 'custody_relay_cancelled', d: { caseId: 'c1', reason: 'called_off' }, to: { screen: 'Main' }, why: 'RELAY RIDER — [AF-MOB-006 · DS667] the handoff they were asked to make was called off or expired; their dashboard no longer shows it' },
  { k: 'mover_job_cancelled', d: { ...O, status: 'CANCELLED', audience: 'earner' }, to: { screen: 'Main' }, why: 'RIDER — [L07] the customer cancelled the delivery they held; the job is gone, so their dashboard, never the customer Delivery screen its orderId used to send it to' },
  { k: 'custody_relay_assigned', d: { caseId: 'c1' }, to: { screen: 'Main' }, why: 'RELAY RIDER — [AF-MOB-006] asked to take an order over; the order is not theirs until the code is verified, so it opens their dashboard, never the order' },
  { k: 'prep_ready', d: { ...O, audience: 'earner' }, to: { screen: 'ActiveJob' }, why: 'RIDER — the kitchen marked the bag ready; ActiveJob is their live job, which MoverStack mounts [Q10]. It sat in the customer group aimed at Delivery, which MoverStack never mounts, so the tap opened nothing' },
  { k: 'pickup_overdue', d: { ...O, orderNumber: 'SW-1', audience: 'earner', releasesInMinutes: 10 }, to: { screen: 'ActiveJob' }, why: 'RIDER — [OF-33] pick up now or hand it back; ActiveJob is their live job (MoverStack mounts it), never the customer Delivery screen' },

  // ── Bookings + service jobs [the S0 this pass closed].
  { k: 'booking_requested', d: { jobId: 'j1' }, to: { screen: 'ServiceJobs' }, why: 'provider — a customer asked them to quote; the first rung of the ladder, and the one that used to send nothing at all' },
  { k: 'booking_quoted', d: { jobId: 'j1' }, to: { screen: 'ServiceJobs' }, why: 'customer — a durable quote is ready to review' },
  { k: 'booking_to_confirm', d: { jobId: 'j1' }, to: { screen: 'ServiceJobs' }, why: 'provider — accept or move the customer’s slot' },
  { k: 'booking_confirmed', d: { jobId: 'j1' }, to: { screen: 'ServiceJobs' }, why: 'customer — provider took the slot' },
  { k: 'booking_slot_declined', d: { jobId: 'j1' }, to: { screen: 'ServiceJobs' }, why: 'customer — pick another time' },
  { k: 'booking_started', d: { jobId: 'j1' }, to: { screen: 'ServiceJobs' }, why: 'customer — provider asserted commencement at the agreed time' },
  { k: 'booking_completed', d: { jobId: 'j1' }, to: { screen: 'ServiceJobs' }, why: 'both — job done, rate it' },
  { k: 'booking_cancelled', d: { jobId: 'j1' }, to: { screen: 'ServiceJobs' }, why: 'the other side — job cancelled' },
  { k: 'booking_reminder', d: { refId: 'j1' }, to: { screen: 'ServiceJobs' }, why: 'both, 24h out — GAP when refId is an APPOINTMENT: no customer appointments screen exists' },
  { k: 'booking_rescheduled', d: { bookingId: 'b1', audience: 'business' }, to: { screen: 'Schedule' }, why: 'store — the moved slot on their agenda [E28: the business copy is tagged audience, the customer copy opens normally]' },

  // ── [PUSH-ROUTING] The weekly fee: every notice about a partner’s subscription opens the fee screen.
  { k: 'billing_mmg_checkout', d: { subscriptionId: 's1', ref: 'checkout-1', status: 'CONFIRMED' }, to: { screen: 'WeeklyFee', params: { ref: 'checkout-1', subscriptionId: 's1', vendorId: undefined } }, why: 'MMG-CHECKOUT-API 628c8206: server state is fetched on the weekly-fee screen' },
  { k: 'billing_mmg_pending', d: { subscriptionId: 's1', audience: 'earner' }, to: FEE('mover'), why: 'partner — [PUSH-ROUTING] MMG asked them to approve this week’s fee; the Weekly fee screen is the one place the fee is seen and paid. The family comes from the server tag (earner = a mover’s fee, business = a store’s; table below)' },
  { k: 'billing_success', d: { subscriptionId: 's1', audience: 'earner' }, to: FEE('mover'), why: 'partner — the week is paid; the fee screen shows it' },
  { k: 'billing_failed', d: { subscriptionId: 's1', audience: 'earner' }, to: FEE('mover'), why: 'partner — the charge failed; the fee screen is where they pay' },
  { k: 'billing_final_warning', d: { subscriptionId: 's1', suspendsAt: '2026-10-20T04:00:00.000Z', audience: 'business' }, to: FEE('vendor'), why: 'partner — suspension is imminent, the highest-value push that used to open nothing; a store’s copy opens the store fee' },
  { k: 'billing_suspended', d: { subscriptionId: 's1', audience: 'business' }, to: FEE('vendor'), why: 'partner — they cannot earn until they pay; paying here restores them' },
  { k: 'billing_suspended_nudge', d: { subscriptionId: 's1', audience: 'earner' }, to: FEE('mover'), why: 'partner — still suspended; pay here' },
  { k: 'billing_reminder', d: { subscriptionId: 's1', audience: 'earner' }, to: FEE('mover'), why: 'partner — the fee is due soon' },
  { k: 'billing_banked', d: { subscriptionId: 's1', audience: 'earner' }, to: FEE('mover'), why: 'partner — a payment arrived and was banked toward the fee' },
  { k: 'billing_churned', d: { subscriptionId: 's1', audience: 'earner' }, to: FEE('mover'), why: 'partner — the subscription closed after 30 days unpaid; the body says paying restores access, and the fee screen is where they pay' },
  { k: 'billing_topup', d: { subscriptionId: 's1', audience: 'earner' }, to: FEE('mover'), why: 'partner — a payment received; it counts toward the next fee' },
  { k: 'billing_card_action_required', d: { subscriptionId: 's1', audience: 'earner' }, to: FEE('mover'), why: 'partner — [PT-1] the bank wants the partner to confirm this week’s card payment (3-D Secure); the fee screen is where the week is paid. Its Confirm-your-card surface arrives with PT-3 (cards are off at launch)' },
  { k: 'trial_fee_education', d: { subscriptionId: 's1', stage: 'MID', audience: 'MOVER' }, to: FEE('mover'), why: 'partner — the trial ends soon; this sender spells the tag MOVER/VENDOR' },
  { k: 'fx_change_notice', d: { subscriptionId: 's1', fxRateId: 'f1' }, to: FEE('mover'), why: 'partner — untagged: the family follows the app that is open (a store owner in Business opens the store fee; table below). With no app context, a mover’s fee' },
  { k: 'billing_rate_change', d: { change: 'PRICE_BOOK', subscriptionId: 's1', priceBookEntryId: 'p1', amountUsd: 12, appliesFrom: '2026-11-02T04:00:00.000Z', audience: 'earner' }, to: FEE('mover'), why: 'partner — (owner 15 Oct) a weekly fee change, told before it applies; the fee screen shows the fee' },
  { k: 'usd_migration_notice', d: { subscriptionId: 's1', mode: 'A' }, to: FEE('mover'), why: 'partner — untagged, as fx_change_notice' },
  { k: 'claim', d: { claimId: 'c1' }, to: { screen: 'Claims' }, why: 'rider — the guarantee claims screen (DOC-1 §31.4)' },
  { k: 'claim_update', d: { claimId: 'c1' }, to: { screen: 'Claims' }, why: 'rider — same screen' },

  // ── Verification / liveness / safety of the person receiving it [PUSH-ROUTING: no row opens nothing].
  { k: 'verification_approved', d: { docId: 'd1', audience: 'earner' }, to: { screen: 'MoverDocuments' }, why: 'document owner — [PUSH-ROUTING] the documents screen of the role the document belongs to: earner -> MoverDocuments, customer -> IdentityVerification, business -> the store’s Account tab (its Documents section). Untagged rows follow the app that is open (table below)' },
  { k: 'verification_rejected', to: { screen: 'IdentityVerification' }, why: 'document owner — they must re-upload. notifyRejection sends no audience, so the open app decides (table below); with no app context, the customer ID screen' },
  { k: 'verification_expired', d: { docId: 'd1', audience: 'earner' }, to: { screen: 'MoverDocuments' }, why: 'document owner — renew it on the documents screen of its role' },
  { k: 'verification_expiry_reminder', d: { docId: 'd1', daysLeft: 3, audience: 'earner' }, to: { screen: 'MoverDocuments' }, why: 'document owner — an approved document re-opens for upload in its renewal window, on that screen' },
  { k: 'verification_application_abandoned', d: { audience: 'earner' }, to: { screen: 'MoverDocuments' }, why: 'applicant — [Row 249] their unfinished application documents will be deleted in 14 days; finishing it happens on the documents screen of its role' },
  { k: 'verification_forced_offline', d: { audience: 'earner' }, to: { screen: 'MoverDocuments' }, why: 'mover — taken offline because a required document lapsed; renewing it is the way back online' },
  { k: 'verification_vehicle_lapsed', d: { docId: 'd1', subjectId: 's1', suspended: 3, audience: 'earner' }, to: { screen: 'MoverDocuments' }, why: 'mover who owns the vehicle — a vehicle document lapsed and its drivers cannot take jobs; it is renewed on the mover documents checklist' },
  { k: 'verification_l2', d: { audience: 'customer' }, to: { screen: 'IdentityVerification' }, why: 'customer — their ID is on file; the ID screen shows it' },
  { k: 'trust_l3', to: HOME, why: 'HOME: customer — trusted status earned; no screen shows the trust tier, so the notice is the whole message' },
  { k: 'liveness_midshift_prompt', d: { respondBy: '2026-01-01T00:00:00.000Z', profile: 'DRIVER' }, to: { screen: 'LivenessCheck', params: { profile: 'DRIVER', respondBy: '2026-01-01T00:00:00.000Z' } }, why: 'E12: the timed selfie check, deadline riding along' },
  { k: 'liveness_midshift_missed', to: { screen: 'LivenessCheck', params: { profile: 'DRIVER' } }, why: 'E12: a fresh PASS is the only way back online' },
  { k: 'password_changed', to: { screen: 'GetHelp', params: { category: 'ACCOUNT', subject: 'I did not change my password' } }, why: '[L04 · MASTER-003] security notice after a password change: if it was not the owner, support is the only way back' },
  { k: 'password_sign_in_paused', to: { screen: 'GetHelp', params: { category: 'ACCOUNT', subject: 'Someone is trying my password' } }, why: '[L04 · MASTER-056] password sign-in paused after many wrong attempts; code sign-in still works, help is the door if it was not the owner' },
  { k: 'liveness_locked', to: { screen: 'GetHelp', params: { category: 'ACCOUNT', subject: 'Identity check locked my account' } }, why: 'E12: only support clears a lock' },
  { k: 'incident_interim_lifted', d: { caseNumber: 'INC-1', restrictionRemains: false }, to: HOME, why: 'HOME: the subject — the suspension is lifted and the body says they can go back online; their home is the dashboard where they do. When another review still restricts them the body says contact support, and that copy opens GetHelp (test below)' },
  { k: 'incident_shadow_restricted', d: { caseNumber: 'INC-1', category: 'HARASSMENT' }, to: { screen: 'GetHelp', params: { category: 'ACCOUNT', subject: 'Account under review' } }, why: 'the subject — the body says contact support to respond; GetHelp is mounted in every navigator, as for incident_interim_suspension' },
  { k: 'compliance_review_failed', d: { audience: 'earner', caseId: 'c1' }, to: { screen: 'MoverDocuments' }, why: 'mover — offline until their documents are re-verified; the body says re-submit them in the app' },

  // ── Store surfaces, then the advertiser kinds (ADS OFF at launch).
  { k: 'low_stock', d: { itemId: 'i1', remaining: 2 }, to: VENDOR_TAB('Menu'), why: 'store owner — the catalogue tab, where stock and availability are set. The payload names the item, not the store: it opens on the selected store' },
  { k: 'staff_added', d: { vendorId: 'v1' }, to: { screen: 'VendorRoot' }, why: 'the person ADDED to a store team — the store’s own screen, selected by its vendorId; it is reached in Business mode, which the body tells them to choose' },
  { k: 'staff_invite', d: { vendorId: 'v1', audience: 'customer' }, to: { screen: 'Storefront', params: { screen: 'Notifications' } }, why: '[row 55] the invite is answered on the inbox Accept card' },
  { k: 'staff_joined', d: { vendorId: 'v1', audience: 'business' }, to: VENDOR_TAB('Account'), why: 'store owner — [row 55] someone accepted their invite; the team panel is on the Account tab' },
  { k: 'review_response', d: { ratingId: 'r1', vendorId: 'v1' }, to: { screen: 'VendorReviews', params: { vendorId: 'v1' } }, why: 'the customer who wrote the review — the store replied; the store’s reviews page shows the reply' },
  { k: 'rating_removed', to: HOME, why: 'HOME: the person whose review was removed — the payload names no rating and no store, so there is nothing to open; the notice is the whole message' },
  { k: 'category_request_resolved', to: VENDOR_TAB('Menu'), why: 'store owner — a category they asked for was added, mapped or declined; items are tagged in the catalogue tab' },
  { k: 'support_update', d: { ticketId: 't1' }, to: { screen: 'GetHelp' }, why: 'anyone with a ticket — GetHelp lists Your tickets with their status, in every navigator. No ticketId param: the screen reads none' },
  { k: 'supply_returned', d: { audience: 'customer', pool: 'DRIVER' }, to: { screen: 'Taxi' }, why: 'customer — drivers are back, request your ride: only the Taxi screen creates this watch (POST /availability/watch, pool DRIVER)' },
  { k: 'ad_campaign_scheduled', d: { campaignId: 'c1' }, to: null, why: 'ADS OFF: advertiser — CampaignDetail exists and is unrouted; ads are off at launch (GUARDRAILS §4), so the advertiser kinds are routed when ads go on' },
  { k: 'ad_campaign_live', d: { campaignId: 'c1' }, to: null, why: 'ADS OFF: same' },
  { k: 'ad_campaign_completed', d: { campaignId: 'c1' }, to: null, why: 'ADS OFF: same' },
  { k: 'ad_campaign_paused', d: { campaignId: 'c1' }, to: null, why: 'ADS OFF: same' },
  { k: 'ad_team_invite', d: { advertiserId: 'a1' }, to: null, why: 'ADS OFF: the invited person — the accept and decline screens are built when ads go on (ads-on checklist); until then the notice is the whole message' },
  { k: 'ad_campaign_resumed', d: { campaignId: 'c1' }, to: null, why: 'ADS OFF: same' },
  { k: 'ad_campaign_cancelled', d: { campaignId: 'c1' }, to: null, why: 'ADS OFF: same' },
  { k: 'ad_campaign_killed', d: { campaignId: 'c1' }, to: null, why: 'ADS OFF: same' },
  { k: 'ad_campaign_auto_cancelled', d: { campaignId: 'c1' }, to: null, why: 'ADS OFF: same' },
  { k: 'ad_creative_rejected', d: { creativeId: 'c1', reason: 'POLICY' }, to: null, why: 'ADS OFF: advertiser must re-upload' },
  { k: 'ad_invoice_receipt', d: { campaignId: 'c1', invoiceNumber: 'INV-1' }, to: null, why: 'ADS OFF: advertiser receipt' },
  { k: 'ad_reservation_expiring', d: { campaignId: 'c1' }, to: null, why: 'ADS OFF: advertiser \u2014 a 5-minute money deadline' },
  { k: 'ad_late_capture', d: { campaignId: 'c1', invoiceId: 'i1' }, to: null, why: 'ADS OFF: advertiser — a payment captured after the hold expired became a refund obligation (R045-ADS-05); no advertiser surface routes it yet' },
  { k: 'ad_weekly_report', d: { campaignId: 'c1', weekStart: '2026-01-05' }, to: null, why: 'ADS OFF: advertiser report' },

  // ── Admin / ops pages. null is CORRECT: there is no mobile admin app.
  { k: 'ops_error_spike', to: null, why: 'admins' },
  { k: 'ops_collusion_affinity', to: null, why: 'admins' },
  { k: 'ops_billing_failures', to: null, why: 'admins' },
  { k: 'ops_pool_saturation', to: null, why: 'admins' },
  // Backups are stale, or are running but never leaving the machine they
  // protect. Admin-only and acted on from the server, not the phone.
  { k: 'ops_backup_stale', to: null, why: 'admins' },
  // The upload malware scanner (clamd) stopped answering: uploads are refused until it is back.
  { k: 'ops_malware_scanner_down', d: { failures: 2, reason: 'x' }, to: null, why: 'admins — ops page, acted on from the server (row 312)' },
  // Uploads stored before a clean scan (row 312 follow-up): the emergency bypass is on, evidence is
  // held for its scan, or a stored upload was quarantined. Admin-only, acted on from the server.
  { k: 'ops_malware_scan_bypass', d: { unscannedOpen: 1 }, to: null, why: 'admins — ops page (row 312)' },
  { k: 'ops_evidence_unscanned', d: { open: 1 }, to: null, why: 'admins — ops page (row 312)' },
  { k: 'ops_evidence_held', d: { held: 1 }, to: null, why: 'admins — ops page (row 312)' },
  { k: 'ops_upload_quarantined', d: { surface: 'vehicle-photo', reason: 'bypass', debtId: 'd1', signature: 'x' }, to: null, why: 'admins — ops page (row 312)' },
  { k: 'ops_reaper_stale', d: { ageHours: 50 }, to: null, why: 'admins — the document reaper is behind by two cycles (DOC-1 §9.2)' },
  { k: 'ops_reaper_failed', d: { error: 'x' }, to: null, why: 'admins — the document reaper threw (DOC-1 §9.2)' },
  { k: 'ops_image_policy_failed', d: { error: 'boom' }, to: null, why: 'admins — ops page, admin only' },
  { k: 'ops_extraction_breaker_open', d: { profileCode: 'GY_ID', rate: 0.2 }, to: null, why: 'admins — ops page, admin only' },
  { k: 'mmg_claim_mismatch', d: { orderId: 'o1' }, to: { screen: 'Delivery', params: { orderId: 'o1' } }, why: 'admins — two payment claims disagree; routes by orderId like the other ops order pages' },
  { k: 'handover_claims_unmatched', d: { unmatched: 3, date: '2026-09-06' }, to: null, why: 'admins — the nightly handover-claims report' },
  { k: 'rlp_suspended', d: {}, to: { screen: 'Claims' }, why: 'rider — the claims screen shows the suspension and the help route' },
  { k: 'rlp_reinstated', d: {}, to: { screen: 'Claims' }, why: 'rider — same screen' },
  { k: 'rlp_sla_breached', d: { breached: 2, date: '2026-09-06' }, to: null, why: 'admins — approved payouts past the SLA' },
  { k: 'rlp_reserve_low', d: { countries: ['GY'], date: '2026-09-06' }, to: null, why: 'admins — the reserve line is below its floor' },
  { k: 'rlp_reserve_provisioned', d: { countryCode: 'GY', periodKey: '2026-08' }, to: null, why: 'admins — the monthly provisioning notice' },
  { k: 'vendor_tier_promoted', d: { vendorId: 'v1' }, to: { screen: 'VendorTier' }, why: 'vendor owner — the seller-status screen (DOC-1 §3.6)' },
  { k: 'vendor_needs_public_phone', d: { vendorId: 'v1' }, to: { screen: 'Main' }, why: 'vendor owner — [owner #51] documents done, the store goes live once it publishes a number customers can call; the waiting store\'s own screen asks for it' },
  { k: 'vendor_needs_food_handler_tick', d: { vendorId: 'v1' }, to: { screen: 'VendorRoot', params: { screen: 'Account' } }, why: 'vendor owner — [FOOD-PERMIT · owner 24 Oct] a registered restaurant ticks that everyone who handles its food holds a current certificate; the store\'s Documents (on Account) show the tick' },
  { k: 'vendor_tier_nudge', d: { vendorId: 'v1', ordersToday: 18, grossThisWeek: 90000 }, to: { screen: 'VendorTier' }, why: 'vendor owner — same screen; it shows the usage against the caps' },
  // Its sibling from the same heartbeat: a background job exhausted its retries
  // (N4/WS-8.1). Admin-only, and the surface that acts on it is the ADMIN web
  // console's Background jobs page — there is no mobile admin surface, so the
  // app opening normally is the correct destination, not a gap.
  { k: 'ops_dlq_non_empty', to: null, why: 'admins — acted on in the admin console, no mobile surface exists' },
  // Third alarm from the same heartbeat: OSRM is unreachable and every fare,
  // ETA and dispatch ranking has quietly reverted to straight-line distance.
  // Admin-only, and the action is on the OSRM host, not in any app.
  { k: 'ops_osrm_fallback', to: null, why: 'admins — the fix is on the routing host, not on a screen' },
  // [PLACES-LOUD] Address search (Google) keeps failing: customers are told search is not
  // working and set places on the map. The fix is the key / Google Cloud console, not a screen.
  { k: 'ops_places_failing', to: null, why: 'admins — the fix is the Google key and console, not a screen' },
  { k: 'ops_scheduler_stall', to: null, why: 'admins — kind built from a ternary', scan: false },
  { k: 'ops_scheduler_never_booted', to: null, why: 'admins — kind built from a ternary', scan: false },
  { k: 'billing_dunning_ops_task', to: null, why: 'admins' },
  { k: 'billing_invariants', to: null, why: 'admins' },
  { k: 'vat_threshold', to: null, why: 'admins — VAT registration threshold watch (owner legal plan R10)' },
  { k: 'billing_manual_reconciliation', to: null, why: 'admins — a card instruction the processor never saw; reviewed in the admin console before any new attempt' },
  { k: 'billing_unknown_intents_sla', to: null, why: 'admins' },
  { k: 'reconcile_mismatch', to: null, why: 'admins' },
  { k: 'settlement_trailer_mismatch', to: null, why: 'admins' },
  { k: 'settlement_deposit_mismatch', to: null, why: 'admins' },
  { k: 'earnings_missing', to: null, why: 'admins' },
  { k: 'agent_cash_sla', to: null, why: 'admins' },
  { k: 'category_backfill_review', to: { screen: 'VendorCategoryReview' }, why: 'the STORE OWNER, not an admin — the backfill notifies `vendor.owner.userId`, and accepting a suggestion is the ONLY thing that writes the tag the Market feed reads. It was unrouted and mislabelled; 50 suggestions sat PENDING against 0 tags' },
  // ── [ALG-34 / ALG-INV-14] The MMG pay link is a money surface: a staged change,
  //    its apply, and its cancel all land on Account — where the pending link
  //    and its cancel live. Vendor and mover stacks both name that screen Account.
  { k: 'mmg_link_change_staged', d: { actor: 'VENDOR' }, to: { screen: 'Account' }, why: 'the OLD contact point — the owner, on every device — sees the pending link and can cancel it' },
  { k: 'mmg_link_change_applied', d: { actor: 'DRIVER' }, to: { screen: 'Account' }, why: 'the cool-off passed; the new link is live where it is managed' },
  { k: 'mmg_link_change_cancelled', d: { actor: 'VENDOR' }, to: { screen: 'Account' }, why: 'the owner cancelled; other devices were signed out' },
  // [PAYMENT-SIMPLIFY] the store's MMG NUMBER (it replaces the link): the same three notices, the same place.
  { k: 'mmg_number_change_staged', d: { actor: 'VENDOR' }, to: { screen: 'Account' }, why: 'the OLD contact point — the owner, on every device — sees the pending number and can cancel it' },
  { k: 'mmg_number_change_applied', d: { actor: 'VENDOR' }, to: { screen: 'Account' }, why: 'the cool-off passed; the new number is live where it is managed' },
  { k: 'mmg_number_change_cancelled', d: { actor: 'VENDOR' }, to: { screen: 'Account' }, why: 'the owner cancelled; other devices were signed out' },
  { k: 'store_pin_moved', d: { vendorId: 'v1', audience: 'business' }, to: { screen: 'Account' }, why: 'the store OWNER — [Q8 · DS269 F1] a manager moved the map pin riders and customers are sent to; Account holds the Store location card that shows it and moves it back' },
  { k: 'incident_new', d: { caseId: 'c1', caseNumber: 'INC-1' }, to: null, why: 'admins' },
  { k: 'incident_sla_breach', d: { caseId: 'c1' }, to: null, why: 'admins' },
  { k: 'incident_weekly_digest', to: null, why: 'admins' },
  { k: 'incident_pattern_cross_reporter', to: null, why: 'admins' },
  { k: 'liveness_outage', d: { userId: 'u1' }, to: null, why: 'admins' },
  { k: 'liveness_review', d: { livenessCheckId: 'l1' }, to: null, why: 'admins' },
  { k: 'compliance_violation', d: { runId: 'r1' }, to: null, why: 'admins' },
  { k: 'verification_pending', d: { docId: 'd1' }, to: null, why: 'admins — review queue' },
  { k: 'verification_sla_breach', d: { slaHours: 24 }, to: null, why: 'admins' },
  { k: 'audit_chain_broken', d: { breakAt: '12', reason: 'HASH' }, to: null, why: 'admins — the tamper-evident audit chain failed verification (DOC-1 §20.1)' },
  { k: 'audit_chain_anchor', d: { headSeq: '12', headHash: 'ab', verified: true }, to: null, why: 'admins — the daily audit-chain head to keep outside Swift' },
  { k: 'verification_legal_hold_overdue', d: { overdue: 1, holdIds: ['h1'] }, to: null, why: 'admins — a document legal hold past its review date (DOC-1 §9.4)' },
  { k: 'integrity_appeal', d: { enforcementId: 'e1' }, to: null, why: 'admins' },
  { k: 'dup_doc', d: { sha256: 'x' }, to: null, why: 'admins' },
  { k: 'vendor_pending', d: { vendorId: 'v1' }, to: null, why: 'admins — approve the store' },
  { k: 'advertiser_application', d: { advertiserId: 'a1' }, to: null, why: 'admins' },
  { k: 'ad_review_sla_risk', d: { creativeId: 'c1' }, to: null, why: 'admins' },
  { k: 'ad_campaign_killed_ops', d: { campaignId: 'c1' }, to: null, why: 'admins' },
  { k: 'ad_refund_payout_task', d: { campaignId: 'c1' }, to: null, why: 'admins' },
  { k: 'ad_campaign_paid', d: { campaignId: 'c1', invoiceNumber: 'INV-1' }, to: null, why: 'admins' },
  { k: 'sos_marked_safe', d: { sosAlertId: 'a1' }, to: null, why: 'admins' },
];

// ── [PUSH-ROUTING] The census keeps ONE payload per kind. The kinds below go to
//    more than one kind of recipient (told apart by the server-tagged audience,
//    or, untagged, by the app that is open), so their other copies are tabled
//    here and graded by the reachability tests and the no-null test.

/** Every notice about a partner's weekly-fee subscription. */
const PARTNER_FEE_KINDS = [
  'billing_mmg_pending', 'billing_success', 'billing_failed', 'billing_final_warning', 'billing_suspended',
  'billing_suspended_nudge', 'billing_reminder', 'billing_banked', 'billing_churned', 'billing_topup',
  'billing_card_action_required', 'trial_fee_education', 'fx_change_notice', 'billing_rate_change', 'usd_migration_notice',
];

/** The document notices sent to whoever owns the document — a mover, a customer or a store. */
const DOCUMENT_KINDS = ['verification_approved', 'verification_rejected', 'verification_expired', 'verification_expiry_reminder', 'verification_application_abandoned'];

/** Census rows whose recipient is a store (owner or team). */
const STORE_KINDS = [
  'low_stock', 'staff_added', 'staff_joined', 'category_request_resolved', 'category_backfill_review',
  'vendor_tier_promoted', 'vendor_tier_nudge', 'vendor_needs_public_phone', 'vendor_needs_food_handler_tick', 'store_pin_moved', 'booking_rescheduled',
];

/** Customer copies of kinds the census lists for someone else, or untagged. */
const CUSTOMER_COPIES: Record<string, unknown>[] = [
  { kind: 'booking_rescheduled', bookingId: 'b1', audience: 'customer' },
  { kind: 'verification_rejected', audience: 'customer' },
  { kind: 'verification_approved', docId: 'd1', audience: 'customer' },
  { kind: 'verification_expired', docId: 'd1', audience: 'customer' },
  { kind: 'verification_l2', audience: 'customer' },
  { kind: 'review_response', ratingId: 'r1', vendorId: 'v1' },
  { kind: 'rating_removed' },
  { kind: 'support_update', ticketId: 't1' },
  { kind: 'trip_share_rotated', orderId: 'o1' },
  { kind: 'trip_share_ended', outcome: 'COMPLETED' },
  { kind: 'trust_l3' },
];

/** Store copies of kinds the census lists with another audience. */
const STORE_COPIES: Record<string, unknown>[] = [
  ...PARTNER_FEE_KINDS.map((kind) => ({ kind, subscriptionId: 's1', audience: 'business' })),
  ...DOCUMENT_KINDS.map((kind) => ({ kind, docId: 'd1', audience: 'business' })),
  { kind: 'support_update', ticketId: 't1' },
];

/** [payload (+ the app that is open, as `intent`), where it lands]. */
const DOCUMENT_COPIES: Array<[Record<string, unknown>, Dest]> = DOCUMENT_KINDS.flatMap((kind): Array<[Record<string, unknown>, Dest]> => [
  [{ kind, docId: 'd1', audience: 'earner' }, { screen: 'MoverDocuments' }],
  [{ kind, docId: 'd1', audience: 'customer' }, { screen: 'IdentityVerification' }],
  [{ kind, docId: 'd1', audience: 'business' }, VENDOR_TAB('Account')],
  // notifyRejection (and any older row) sends no audience: the open app decides.
  [{ kind, intent: 'mover' }, { screen: 'MoverDocuments' }],
  [{ kind, intent: 'vendor' }, VENDOR_TAB('Account')],
  [{ kind, intent: 'customer' }, { screen: 'IdentityVerification' }],
  [{ kind, intent: null }, { screen: 'IdentityVerification' }],
  // An advertiser account has no documents screen: its home, on purpose.
  [{ kind, intent: 'advertiser' }, HOME],
]);

describe('the census: every kind the API sends has an asserted destination', () => {
  it('routes each one exactly where this table says', () => {
    for (const c of CENSUS) {
      expect(destinationFor({ kind: c.k, ...(c.d ?? {}) }), `${c.k} — ${c.why}`).toEqual(c.to);
    }
  });

  it('lists each kind once', () => {
    const seen = new Set<string>();
    const dupes = CENSUS.filter((c) => (seen.has(c.k) ? true : (seen.add(c.k), false))).map((c) => c.k);
    expect(dupes).toEqual([]);
  });
});

describe('every destination is a route the app actually registers', () => {
  // THE HomeTabs LESSON: 'HomeTabs' is a component NAME, not a route name (the
  // customer tabs register as 'Tabs'). safeNavigate swallows an unknown screen
  // — no crash, no navigation, no error the user can see — so a typo'd screen
  // is indistinguishable from a working one until someone taps a real push.
  it('names only screens registered in a navigator', () => {
    const registered = new Set<string>();
    for (const file of filesUnder(join(process.cwd(), 'src'), '.tsx')) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\.Screen[^>]*?name="([A-Za-z0-9_]+)"/g)) {
        registered.add(m[1]!);
      }
    }
    expect(registered.size).toBeGreaterThan(20); // the scan itself found screens

    const wanted = new Set(CENSUS.map((c) => c.to?.screen).filter((s): s is string => !!s));
    // Destinations asserted outside the census table too.
    wanted.add('Taxi');
    wanted.add('ServiceJobs');
    // [PUSH-ROUTING] The per-audience copies tabled below.
    for (const payload of [...CUSTOMER_COPIES, ...STORE_COPIES]) {
      const screen = destinationFor(payload)?.screen;
      if (screen) wanted.add(screen);
    }
    for (const [, dest] of DOCUMENT_COPIES) if (dest?.screen) wanted.add(dest.screen);
    const missing = [...wanted].filter((s) => !registered.has(s)).sort();
    expect(missing, 'tap destinations no navigator registers — these taps go nowhere').toEqual([]);
  });

  // [TST-001] EXISTING SOMEWHERE IS NOT REACHABLE BY THE RECIPIENT.
  //
  // The test above asks whether ANY navigator registers the screen. That is
  // how `guardian_driver_confirm -> Delivery` passed for so long: Delivery is
  // a real screen, in the CUSTOMER stack, and the recipient is a driver whose
  // navigator never mounts it. The tap opened nothing, on a safety path, and
  // the census said it was fine.
  //
  // A push aimed at a mover must land on a screen MoverStack mounts.
  const MOVER_KINDS: Record<string, string> = {
    billing_mmg_checkout: 'MMG status is for every partner',
    guardian_driver_confirm: 'the driver is asked to confirm the trip status',
    dispatch_offer: 'the earner has an offer with a running clock',
    claim_over_gate: 'the rider is owed a delivery guarantee',
    prep_ready: 'the rider is told the bag is packed at the counter',
    custody_handoff_code: 'the rider holding the goods is told a relay rider is coming',
    custody_relay_assigned: 'a relay rider is asked to take an order over',
    custody_relay_cancelled: 'a relay rider is told the handoff is off',
    mover_job_cancelled: 'the rider is told the customer cancelled the delivery they held',
    // [PUSH-ROUTING] Rows that opened nothing until now; each census row
    // carries the earner tag the API sends.
    billing_mmg_pending: 'a mover asked to approve this week’s fee',
    billing_failed: 'a mover whose fee charge failed',
    billing_suspended_nudge: 'a mover still suspended for the fee',
    billing_churned: 'a mover whose subscription closed',
    billing_card_action_required: 'a mover whose bank wants the card payment confirmed',
    trial_fee_education: 'a mover whose trial ends soon',
    verification_approved: 'a mover whose document was approved',
    verification_expired: 'a mover whose document expired',
    verification_expiry_reminder: 'a mover whose document expires soon',
    verification_application_abandoned: 'a mover applicant whose unfinished application documents will be deleted',
    verification_forced_offline: 'a mover taken offline for a lapsed document',
    verification_vehicle_lapsed: 'a vehicle owner whose vehicle document lapsed',
    compliance_review_failed: 'a mover offline until documents are re-verified',
    incident_interim_lifted: 'a mover whose suspension was lifted',
  };

  it('a push aimed at a MOVER lands on a screen MoverStack mounts', () => {
    const stack = readFileSync(join(process.cwd(), 'src', 'modules', 'mover', 'MoverStack.tsx'), 'utf8');
    const mounted = new Set([...stack.matchAll(/\.Screen[^>]*?name="([A-Za-z0-9_]+)"/g)].map((m) => m[1]!));
    // MoverStack composes a role-resolved root; these are reachable from it.
    mounted.add('Main');
    mounted.add('MoverRoot');
    expect(mounted.size, 'the scan itself found the stack').toBeGreaterThan(5);

    const unreachable: string[] = [];
    for (const [kind, why] of Object.entries(MOVER_KINDS)) {
      const row = CENSUS.find((c) => c.k === kind);
      expect(row, `${kind} is in the census`).toBeTruthy();
      const screen = row!.to?.screen;
      if (screen && !mounted.has(screen)) unreachable.push(`${kind} -> ${screen} (${why})`);
    }
    expect(unreachable, 'a mover tapping these opens nothing — the screen is in another stack').toEqual([]);
  });

  // [E28] THE SAME LESSON FOR THE CUSTOMER. booking_rescheduled goes to two
  // people. Its customer copy was aimed at Schedule, a screen only VendorStack
  // mounts, and no test asked whether the customer could reach it. The census
  // keeps one row per kind, so the customer copies of two-audience kinds are
  // listed here as well as every census row the API tags for the customer.
  it('a push aimed at a CUSTOMER lands on a screen CustomerStack mounts', () => {
    const stack = readFileSync(join(process.cwd(), 'src', 'navigation', 'CustomerStack.tsx'), 'utf8');
    const mounted = new Set([...stack.matchAll(/\.Screen[^>]*?name="([A-Za-z0-9_]+)"/g)].map((m) => m[1]!));
    // Every role stack sits under the root route Main, so it is reachable too.
    mounted.add('Main');
    // The root mounts a CustomerStack separately for cross-mode inbox taps.
    const root = readFileSync(join(process.cwd(), 'src', 'navigation', 'RootNavigator.tsx'), 'utf8');
    expect(root).toMatch(/name="Storefront"\s+component=\{CustomerStack\}/);
    mounted.add('Storefront');
    expect(mounted.size, 'the scan itself found the stack').toBeGreaterThan(5);

    const payloads = [
      ...CENSUS.filter((c) => c.d?.['audience'] === 'customer').map((c) => ({ kind: c.k, ...c.d })),
      ...CUSTOMER_COPIES,
    ];
    expect(payloads.length, 'the census still tags customer pushes').toBeGreaterThan(5);

    const unreachable: string[] = [];
    for (const payload of payloads) {
      const screen = destinationFor(payload)?.screen;
      if (screen && !mounted.has(screen)) unreachable.push(`${String(payload['kind'])} -> ${screen}`);
    }
    expect(unreachable, 'a customer tapping these opens nothing — the screen is in another stack').toEqual([]);
  });

  // [PUSH-ROUTING] THE SAME LESSON FOR THE STORE. A store push must land on a
  // screen VendorStack mounts: one of its stack screens, or VendorRoot opened
  // on one of the tabs VendorRoot renders (the router selects the store first).
  it('a push aimed at a STORE lands on a screen VendorStack mounts', () => {
    const stack = readFileSync(join(process.cwd(), 'src', 'modules', 'vendor', 'VendorStack.tsx'), 'utf8');
    // Stack screens and VendorRoot's tabs (VTab.Screen) — both are `.Screen name=`.
    const mounted = new Set([...stack.matchAll(/\.Screen[^>]*?name="([A-Za-z0-9_]+)"/g)].map((m) => m[1]!));
    mounted.add('Main');
    expect(mounted.has('VendorRoot') && mounted.has('Account') && mounted.has('Menu'), 'the scan found the stack and its tabs').toBe(true);

    const payloads = [...STORE_KINDS.map((k) => ({ kind: k, ...CENSUS.find((c) => c.k === k)!.d })), ...STORE_COPIES];
    const unreachable: string[] = [];
    for (const payload of payloads) {
      const dest = destinationFor(payload);
      const tab = dest?.params?.['screen'];
      if (!dest) unreachable.push(`${String(payload['kind'])} -> nothing`);
      else if (!mounted.has(dest.screen)) unreachable.push(`${String(payload['kind'])} -> ${dest.screen}`);
      else if (typeof tab === 'string' && !mounted.has(tab)) unreachable.push(`${String(payload['kind'])} -> ${dest.screen} / ${tab}`);
    }
    expect(unreachable, 'a store tapping these opens nothing — the screen is in another stack').toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// [PUSH-ROUTING · board row 331] NO USER-FACING PUSH OPENS NOTHING.
// ───────────────────────────────────────────────────────────────────────────

const isOps = (c: Case) => /^admins\b/.test(c.why);
const isAdsOff = (c: Case) => c.why.startsWith('ADS OFF');

describe('no user-facing push opens nothing [PUSH-ROUTING]', () => {
  it('every user-facing kind routes somewhere — graded on the router, not on this table', () => {
    const silent = CENSUS.filter((c) => !isOps(c) && !isAdsOff(c))
      .filter((c) => destinationFor({ kind: c.k, ...(c.d ?? {}) }) === null)
      .map((c) => c.k)
      .sort();
    expect(silent, 'user-facing kinds whose tap opens nothing — give each a screen of its role, or HOME with a reason').toEqual([]);
  });

  it('every second-audience copy routes somewhere too', () => {
    const silent = [...CUSTOMER_COPIES, ...STORE_COPIES]
      .filter((payload) => destinationFor(payload) === null)
      .map((payload) => `${String(payload['kind'])} (${String(payload['audience'] ?? 'untagged')})`);
    expect(silent).toEqual([]);
  });

  it('the ADS OFF exemption covers advertiser kinds only', () => {
    const ads = CENSUS.filter(isAdsOff);
    expect(ads.filter((c) => !c.k.startsWith('ad_')).map((c) => c.k)).toEqual([]);
    expect(ads.length, 'the advertiser rows are still listed').toBeGreaterThan(10);
  });

  it('no row is still marked GAP', () => {
    expect(CENSUS.filter((c) => c.why.startsWith('GAP')).map((c) => c.k)).toEqual([]);
  });

  it('a HOME row lands on HOME and says why', () => {
    const homes = CENSUS.filter((c) => c.why.startsWith('HOME:'));
    expect(homes.length, 'the HOME rows are listed').toBeGreaterThan(2);
    for (const c of homes) {
      expect(destinationFor({ kind: c.k, ...(c.d ?? {}) }), c.k).toEqual(HOME);
      expect(c.why.length, `${c.k} names its reason`).toBeGreaterThan(60);
    }
  });
});

describe('a weekly-fee notice opens the fee of the family it is about [PUSH-ROUTING]', () => {
  it('the server tag picks the family: business or VENDOR is a store fee, earner or MOVER a mover fee', () => {
    for (const kind of PARTNER_FEE_KINDS) {
      for (const [audience, family] of [['business', 'vendor'], ['VENDOR', 'vendor'], ['earner', 'mover'], ['MOVER', 'mover']] as const) {
        expect(destinationFor({ kind, subscriptionId: 's1', audience }), `${kind} / ${audience}`).toEqual(FEE(family));
      }
    }
  });

  it('a tagged notice never asks which app is open', () => {
    const ask = () => { throw new Error('the open app was read for a tagged notice'); };
    expect(destinationFor({ kind: 'billing_suspended', subscriptionId: 's1', audience: 'business' }, ask)).toEqual(FEE('vendor'));
    expect(destinationFor({ kind: 'billing_suspended', subscriptionId: 's1', audience: 'earner' }, ask)).toEqual(FEE('mover'));
  });

  it('an untagged notice follows the app that is open, as WeeklyFeeRouteScreen does', () => {
    for (const kind of PARTNER_FEE_KINDS) {
      const untagged = { kind, subscriptionId: 's1' };
      expect(destinationFor(untagged, () => 'vendor'), `${kind} in Business`).toEqual(FEE('vendor'));
      expect(destinationFor(untagged, () => 'mover'), `${kind} in Earner`).toEqual(FEE('mover'));
      expect(destinationFor(untagged, () => 'customer'), kind).toEqual(FEE('mover'));
      expect(destinationFor(untagged, () => null), kind).toEqual(FEE('mover'));
      expect(destinationFor(untagged), kind).toEqual(FEE('mover'));
    }
  });

  it('names only the family: the payload carries no store and no checkout to invent', () => {
    expect(destinationFor({ kind: 'billing_final_warning', subscriptionId: 's1', suspendsAt: 'x', audience: 'business' })!.params)
      .toEqual({ feeFamily: 'vendor' });
  });

  it('every partner fee kind is in the census, and the operations billing kinds stay ops', () => {
    const census = new Set(CENSUS.map((c) => c.k));
    expect(PARTNER_FEE_KINDS.filter((k) => !census.has(k))).toEqual([]);
    for (const kind of ['billing_invariants', 'billing_dunning_ops_task', 'billing_manual_reconciliation', 'billing_unknown_intents_sla']) {
      expect(destinationFor({ kind, audience: 'earner' }, () => 'mover'), kind).toBeNull();
    }
  });

  it('billing_mmg_checkout keeps its own contract (build 9 to 11 phones route it the same way)', () => {
    expect(destinationFor({ kind: 'billing_mmg_checkout', subscriptionId: 's1', ref: 'r1', vendorId: 'v1', audience: 'business' }))
      .toEqual({ screen: 'WeeklyFee', params: { ref: 'r1', subscriptionId: 's1', vendorId: 'v1' } });
  });
});

describe('a document notice opens the documents of the role it is about [PUSH-ROUTING]', () => {
  it('routes every tagged and untagged copy as tabled', () => {
    for (const [payload, dest] of DOCUMENT_COPIES) {
      const { intent, ...data } = payload;
      expect(destinationFor(data, () => intent as string | null), JSON.stringify(payload)).toEqual(dest);
    }
  });

  it('the server tag wins over the app that is open', () => {
    expect(destinationFor({ kind: 'verification_expired', docId: 'd1', audience: 'earner' }, () => 'vendor')).toEqual({ screen: 'MoverDocuments' });
    expect(destinationFor({ kind: 'verification_expired', docId: 'd1', audience: 'business' }, () => 'mover')).toEqual(VENDOR_TAB('Account'));
  });

  it('the earner-only document notices open the mover documents whatever app is open', () => {
    for (const kind of ['verification_forced_offline', 'verification_vehicle_lapsed', 'compliance_review_failed']) {
      expect(destinationFor({ kind }, () => 'customer'), kind).toEqual({ screen: 'MoverDocuments' });
    }
  });

  it('the review tables cover all four document kinds and every role', () => {
    const covered = new Set(DOCUMENT_COPIES.map(([p]) => `${String(p['kind'])}/${String(p['audience'] ?? `intent:${String(p['intent'])}`)}`));
    for (const kind of DOCUMENT_KINDS) {
      for (const who of ['earner', 'customer', 'business', 'intent:mover', 'intent:vendor', 'intent:customer', 'intent:null', 'intent:advertiser']) {
        expect(covered.has(`${kind}/${who}`), `${kind}/${who}`).toBe(true);
      }
    }
  });
});

describe('the subject of a safety case is sent where the body sends them [PUSH-ROUTING]', () => {
  it('a lifted suspension with another review still open says contact support, and opens support', () => {
    expect(destinationFor({ kind: 'incident_interim_lifted', caseNumber: 'INC-1', restrictionRemains: true }))
      .toEqual({ screen: 'GetHelp', params: { category: 'ACCOUNT', subject: 'Account under review' } });
  });
});

// ── The drift guard. A new kind in the API is a routing DECISION, not a
// silent null: this fails until the kind is added to the census above.
const API_SRC = join(process.cwd(), '../api/src');

// `kind:` literals in apps/api/src that are NOT push payloads. Each one is a
// discriminant or an enum-ish label; keeping them named (rather than widening
// the regex) means a real kind can never hide behind a filter.
const NOT_PUSH_KINDS = new Set([
  'pub', 'sub',                                   // socket command failures
  'invalid', 'reuse', 'success', 'insufficient_assurance', // auth result unions
  'low', 'out',                                   // stock event level
  'rider',                                        // admin mover-shape annotation
  'stall',                                        // scheduler-health union
  'advanced', 'banked', 'held', 'lost',           // MMG settlement outcome union (billing.service.ts)
  'churned', 'dunned', 'nudged', 'preserved', 'skipped', // dunning/repair outcome unions (billing.service.ts)
  'blocked', 'reserved', 'unproven',              // pay-session start and terminal-repair unions (card-rail, mmg-checkout, billing.service.ts)
]);

function filesUnder(dir: string, ext: '.ts' | '.tsx'): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return filesUnder(p, ext);
    return e.name.endsWith(ext) && !e.name.endsWith(`.test${ext}`) ? [p] : [];
  });
}

describe('census drift vs apps/api/src', () => {
  const sourceIsReadable = existsSync(API_SRC);

  it('can read the API source it is meant to check', () => {
    // UNVERIFIED beats a fake PASS: if the scan cannot run, say so loudly
    // rather than reporting a green two-way check it never performed.
    expect(sourceIsReadable, `${API_SRC} not found — the drift check cannot run`).toBe(true);
  });

  it('every kind the API sends is in the census (and nothing in the census is phantom)', () => {
    if (!sourceIsReadable) return;
    // The API producer is a parallel PR. This one explicit forward contract
    // remains census-covered before and after that producer lands.
    const sent = new Set<string>(['billing_mmg_checkout']);
    for (const file of filesUnder(API_SRC, '.ts')) {
      for (const m of readFileSync(file, 'utf8').matchAll(/kind: '([a-z][a-z0-9_]*)'/g)) {
        if (!NOT_PUSH_KINDS.has(m[1]!)) sent.add(m[1]!);
      }
    }

    const censusKinds = new Set(CENSUS.map((c) => c.k));
    const unrouted = [...sent].filter((k) => !censusKinds.has(k)).sort();
    expect(unrouted, 'API kinds with no census entry — decide where each one lands').toEqual([]);

    // The other direction: a census entry nothing sends is dead weight.
    const phantom = CENSUS.filter((c) => c.scan !== false && !sent.has(c.k)).map((c) => c.k).sort();
    expect(phantom, 'census entries the API no longer sends').toEqual([]);
  });
});
