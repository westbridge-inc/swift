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

  it('an OFFER ping lands the earner on their mover home, never the customer screen [E36 / danger #22]', () => {
    // Pre-fix, the generic orderId branch dropped an earner mid-countdown on
    // the CUSTOMER Delivery screen — a dead end with the clock running.
    expect(destinationFor({ kind: 'dispatch_offer', orderId: 'o9' })).toEqual({ screen: 'Main' });
    // A store's "cancelled order may hold an MMG payment" opens their dashboard.
    expect(destinationFor({ kind: 'mmg_unattested_cancellation', orderId: 'o9' })).toEqual({ screen: 'Main' });
  });

  it('anything carrying an orderId lands on that order’s tracking screen', () => {
    expect(destinationFor({ kind: 'prep_ready', orderId: 'abc' })).toEqual({ screen: 'Delivery', params: { orderId: 'abc' } });
    expect(destinationFor({ orderId: 'xyz' })).toEqual({ screen: 'Delivery', params: { orderId: 'xyz' } });
  });

  it('unknowns open the app normally', () => {
    expect(destinationFor({ kind: 'billing_topup' })).toBeNull();
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
    expect(destinationFor({ kind: 'agent_vendor_ping', orderId: 'o1', audience: 'business' }))
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
      { kind: 'agent_vendor_ping', orderId: 'o1', audience: 'business' },
      { kind: 'incident_interim_suspension', orderId: 'o1' },
      { kind: 'claim_over_gate', orderId: 'o1' },
    ]) {
      expect(destinationFor(data)!.screen, `${data.kind} must not land on Delivery`).not.toBe('Delivery');
    }
  });

  it('a CUSTOMER push with an orderId still goes to Delivery (guards the guard)', () => {
    // The catch-all is right for the case it was written for; these branches
    // must not have broken it.
    expect(destinationFor({ kind: 'agent_delay_notice', orderId: 'o1' }))
      .toEqual({ screen: 'Delivery', params: { orderId: 'o1' } });
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
      'booking_to_confirm',
      'booking_confirmed',
      'booking_slot_declined',
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
    // it carries bookingId (a slot on a vendor calendar). Its other recipient
    // is the customer, who has no appointments screen anywhere in the app.
    expect(destinationFor({ kind: 'booking_rescheduled', bookingId: 'b1' })).toEqual({ screen: 'Schedule' });
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
});

// ───────────────────────────────────────────────────────────────────────────
// THE CENSUS — every `kind` the API sends, with the destination it gets.
//
// Rebuilt by scanning apps/api/src for `kind: '…'` push payloads. `to: null`
// means "the app opens normally": for an ops/admin page that is correct (there
// is no mobile admin surface); for a user-facing kind it is a REPORTED gap,
// marked below, not an endorsement. The drift test underneath fails the moment
// the API grows a kind that is not in this table, which is what stops the next
// booking_to_confirm from shipping dead.
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

const CENSUS: Case[] = [
  // ── Orders: the customer's own journey. Delivery IS their tracking screen.
  { k: 'substitution_pending', d: { ...O, lineId: 'l1' }, to: DELIVERY('o1'), why: 'customer — approve a substitution' },
  { k: 'line_refunded', d: { ...O, lineId: 'l1' }, to: DELIVERY('o1'), why: 'customer — a line was refunded' },
  { k: 'prep_ready', d: O, to: DELIVERY('o1'), why: 'customer — order ready' },
  { k: 'mmg_payment_confirmed', d: O, to: DELIVERY('o1'), why: 'customer — MMG payment captured' },
  { k: 'strike', d: O, to: DELIVERY('o1'), why: 'customer — failed delivery recorded' },
  { k: 'delivery_options', d: O, to: DELIVERY('o1'), why: 'customer — supply is thin, pick another option' },
  { k: 'delivery_cash_settlement', d: { ...O, settlementId: 's1', status: 'OPEN' }, to: DELIVERY('o1'), why: 'cash settlement on that order' },
  { k: 'dispatch_retrying', d: { ...O, audience: 'customer' }, to: DELIVERY('o1'), why: 'customer — still looking for a mover' },
  { k: 'converted_to_pickup', d: { ...O, audience: 'business' }, to: { screen: 'VendorOrderDetail', params: { orderId: 'o1' } }, why: 'store — the order became a pickup [audience rule]' },
  { k: 'dispatch_exhausted', d: { ...O, audience: 'customer' }, to: DELIVERY('o1'), why: 'customer — no mover found' },
  { k: 'mover_session_revocation', d: { ...O, audience: 'customer', status: 'PICKED_UP', action: 'REOPEN' }, to: DELIVERY('o1'), why: 'customer — their mover lost custody' },
  { k: 'vendor_order_alert', d: { ...O, orderNumber: 'SW-1', status: 'PENDING' }, to: { screen: 'VendorOrderDetail', params: { orderId: 'o1', orderNumber: 'SW-1' } }, why: 'store — THE new-order alert [fixed here]' },
  { k: 'mmg_unattested_cancellation', d: { ...O, audience: 'business' }, to: { screen: 'Main' }, why: 'store — a cancelled order may still hold an MMG payment; their Main is the dashboard' },
  // `d` must mirror what the API actually SENDS. The drift check compares only
  // `kind` strings, so a payload that grows a field goes unnoticed here and the
  // case then grades a shape nothing produces.
  { k: 'agent_vendor_ping', d: { ...O, audience: 'business' }, to: { screen: 'VendorOrderDetail', params: { orderId: 'o1' } }, why: 'the STORE — "order waiting on you" belongs on their order desk. The API now tags audience:business; untagged it carried only an orderId and fell through to the CUSTOMER tracking screen, a route VendorStack never mounts' },
  { k: 'agent_delay_notice', d: O, to: DELIVERY('o1'), why: 'customer — order delayed' },
  { k: 'claim_over_gate', d: O, to: { screen: 'GetHelp', params: { category: 'PAYMENT', subject: 'Delivery guarantee claim', orderId: 'o1' } }, why: 'rider — the body says "support will follow up"; this is the door for someone who would rather not wait. GetHelp is mounted in every navigator. Was Delivery, which MoverStack never mounts' },
  { k: 'guardian_checkin', d: { ...O, sessionId: 's1', level: 'SOFT' }, to: { screen: 'Taxi' }, why: 'passenger mid-RIDE — the check-in card lives on Taxi, which asks the server whether one is outstanding. Was Delivery, a screen a ride never renders on, so the person being asked if they are safe could not answer' },
  { k: 'guardian_driver_confirm', d: { ...O, sessionId: 's1', cycleId: 'cy1', nonce: 'n1', respondBy: '2026-09-03T12:00:00.000Z' }, to: { screen: 'GuardianDriverConfirm', params: { sessionId: 's1', cycleId: 'cy1', nonce: 'n1', respondBy: '2026-09-03T12:00:00.000Z', orderId: 'o1' } }, why: '[TST-001] the DRIVER, on a screen MoverStack mounts. This used to route to Delivery — which MoverStack never mounts — and this census asserted that dead end as passing, on a SAFETY path, while POST /safety/guardian/driver-confirm sat with no caller. It carries the cycle and the nonce so the screen answers THAT check' },
  { k: 'guardian_deescalation', d: { ...O, sessionId: 's1', cycleId: 'cy1' }, to: DELIVERY('o1'), why: 'admins — [S-04] a passenger never answered a hard check and the driver de-escalated; the review is an ops surface, not mobile' },
  { k: 'guardian_checkin_undelivered', d: { ...O, sessionId: 's1', cycleId: 'cy1', delivery: 'PENDING' }, to: DELIVERY('o1'), why: 'admins — [S-06] a hard check-in that never reached the passenger; the deadline is held and a human looks — an ops surface' },
  { k: 'incident_duplicate_intake', d: { clusters: [] }, to: null, why: 'admins — [S-08] likely duplicate intakes that drove enforcement; review and merge is an ops surface' },
  { k: 'legal_hold_partial', d: { partial: [], failedVault: 0 }, to: null, why: 'admins — [S-09] a held case and its evidence disagree; deletion is frozen; an ops surface' },
  { k: 'safety_escrow_review', d: { holds: [] }, to: null, why: 'admins — [AG-XF-013] a deleted account\u2019s emergency contact details are still escrowed because a safety hold never closed. Confirming the hold is still real, or closing the case so erasure completes, is an ops act — and the person it concerns has already left, so there is no mobile destination' },
  { k: 'not_my_driver_discrepancy', d: { missingCase: [], missingDispatch: [], repaired: [] }, to: null, why: 'admins — [S-13] a not-my-driver decision lacked its case or its dispatch command; an ops surface' },
  { k: 'trip_share_rotated', d: { ...O }, to: DELIVERY('o1'), why: 'sharer — [S-16] their share link was reset; routes by orderId like every trip kind (the trip screen is Taxi — GAP shared with guardian_checkin)' },
  { k: 'ops_alert_escalated', d: { opsAlertId: 'a1', sosAlertId: 'a1', level: 1 }, to: null, why: 'admins — [S-19] an ops page nobody acknowledged by its deadline; the alert list is an ops surface' },
  { k: 'ops_alert_drill', d: { opsAlertId: 'a1' }, to: null, why: 'admins — [S-19] a scheduled or manual drill of the paging path; an ops surface' },
  { k: 'safety_sweep_slo', d: { workType: 'guardian.open', stalled: true, passAgeSeconds: 1200 }, to: null, why: 'admins — [S-05] a safety sweep whose pass stalled past the SLO or whose rows keep failing; an ops surface, not mobile' },
  { k: 'incident_interim_suspension', d: { ...O, caseNumber: 'INC-1' }, to: { screen: 'GetHelp', params: { category: 'ACCOUNT', subject: 'Account suspended pending review' } }, why: 'suspended mover — the body says "contact Swift support to respond", and support is the ONLY way back. Same destination as liveness_locked, for the same reason. Was Delivery, which MoverStack never mounts' },
  { k: 'support_ticket', d: { ...O, ticketId: 't1' }, to: DELIVERY('o1'), why: 'admins — ops queue lives on the web console' },
  { k: 'sos_active', d: { ...O, sosAlertId: 'a1' }, to: DELIVERY('o1'), why: 'admins — SOS war room is not a mobile surface' },
  { k: 'agent_approval_needed', d: O, to: DELIVERY('o1'), why: 'admins/agent approval queue' },
  { k: 'agent_ops_alert', d: O, to: DELIVERY('o1'), why: 'admins' },
  { k: 'ops_delivery_rider_dropped', d: O, to: DELIVERY('o1'), why: 'admins' },
  { k: 'ops_dispatch_exhausted', d: O, to: DELIVERY('o1'), why: 'admins' },
  { k: 'ops_food_too_old', d: O, to: DELIVERY('o1'), why: 'admins — [ALG-06] an order too old to deliver was cancelled by the system and needs a person' },
  { k: 'ops_taxi_driver_dropped', d: O, to: DELIVERY('o1'), why: 'admins' },
  { k: 'RATING_REMINDER', d: O, to: DELIVERY('o1'), why: 'customer — rate a finished order (the one SHOUTY kind)', scan: false },
  { k: 'ops_mover_session_ended:o1', d: O, to: DELIVERY('o1'), why: 'admins — kind is built with the orderId appended', scan: false },

  // ── Rides: the taxi screen reads the active ride itself.
  { k: 'ride_queue_matched', d: { ...O, audience: 'customer' }, to: { screen: 'Taxi' }, why: 'customer — a driver took their queued ride' },
  { k: 'ride_queue_expired', d: { audience: 'customer', rideClass: 'STANDARD' }, to: { screen: 'Taxi' }, why: 'customer — queue timed out, request again' },
  { k: 'ride_released_no_drivers', d: { ...O, audience: 'customer' }, to: { screen: 'Taxi' }, why: 'customer — ride released' },
  { k: 'dispatch_offer', d: { ...O, audience: 'earner', offerAttemptId: 'a1' }, to: { screen: 'Main' }, why: 'earner — the live offer card is on their Main' },

  // ── Bookings + service jobs [the S0 this pass closed].
  { k: 'booking_requested', d: { jobId: 'j1' }, to: { screen: 'ServiceJobs' }, why: 'provider — a customer asked them to quote; the first rung of the ladder, and the one that used to send nothing at all' },
  { k: 'booking_to_confirm', d: { jobId: 'j1' }, to: { screen: 'ServiceJobs' }, why: 'provider — accept or move the customer’s slot' },
  { k: 'booking_confirmed', d: { jobId: 'j1' }, to: { screen: 'ServiceJobs' }, why: 'customer — provider took the slot' },
  { k: 'booking_slot_declined', d: { jobId: 'j1' }, to: { screen: 'ServiceJobs' }, why: 'customer — pick another time' },
  { k: 'booking_completed', d: { jobId: 'j1' }, to: { screen: 'ServiceJobs' }, why: 'both — job done, rate it' },
  { k: 'booking_cancelled', d: { jobId: 'j1' }, to: { screen: 'ServiceJobs' }, why: 'the other side — job cancelled' },
  { k: 'booking_reminder', d: { refId: 'j1' }, to: { screen: 'ServiceJobs' }, why: 'both, 24h out — GAP when refId is an APPOINTMENT: no customer appointments screen exists' },
  { k: 'booking_rescheduled', d: { bookingId: 'b1' }, to: { screen: 'Schedule' }, why: 'store — the moved slot on their agenda; the customer half has no screen [GAP]' },

  // ── Money the recipient must act on — no deep screen wired yet [GAPS].
  { k: 'billing_mmg_pending', d: { subscriptionId: 's1' }, to: null, why: 'GAP: vendor/mover weekly fee — a billing screen exists but is unrouted' },
  { k: 'billing_success', d: { subscriptionId: 's1' }, to: null, why: 'GAP: same' },
  { k: 'billing_failed', d: { subscriptionId: 's1' }, to: null, why: 'GAP: same' },
  { k: 'billing_final_warning', d: { subscriptionId: 's1' }, to: null, why: 'GAP: suspension is imminent — the highest-value unrouted push' },
  { k: 'billing_suspended', d: { subscriptionId: 's1' }, to: null, why: 'GAP: they cannot earn until they pay' },
  { k: 'billing_suspended_nudge', d: { subscriptionId: 's1' }, to: null, why: 'GAP: same' },
  { k: 'billing_reinstated', d: { subscriptionId: 's1' }, to: null, why: 'GAP: same' },
  { k: 'billing_reminder', d: { subscriptionId: 's1' }, to: null, why: 'GAP: same' },
  { k: 'billing_banked', d: { subscriptionId: 's1' }, to: null, why: 'GAP: same' },
  { k: 'billing_churned', d: { subscriptionId: 's1' }, to: null, why: 'GAP: same' },
  { k: 'billing_topup', d: { subscriptionId: 's1' }, to: null, why: 'GAP: same' },
  { k: 'trial_fee_education', d: { subscriptionId: 's1', stage: 'MID' }, to: null, why: 'GAP: same' },
  { k: 'fx_change_notice', d: { subscriptionId: 's1', fxRateId: 'f1' }, to: null, why: 'GAP: same' },
  { k: 'usd_migration_notice', d: { subscriptionId: 's1', mode: 'A' }, to: null, why: 'GAP: same' },
  { k: 'claim', d: { claimId: 'c1' }, to: null, why: 'GAP: rider cash-guarantee claim — no claims screen' },
  { k: 'claim_update', d: { claimId: 'c1' }, to: null, why: 'GAP: same' },

  // ── Verification / liveness / safety of the person receiving it [GAPS].
  { k: 'verification_approved', d: { docId: 'd1' }, to: null, why: 'GAP: IdentityVerification screen exists and is unrouted' },
  { k: 'verification_rejected', to: null, why: 'GAP: same — they must re-upload' },
  { k: 'verification_expired', d: { docId: 'd1' }, to: null, why: 'GAP: same' },
  { k: 'verification_expiry_reminder', d: { docId: 'd1' }, to: null, why: 'GAP: same' },
  { k: 'verification_forced_offline', d: { audience: 'earner' }, to: null, why: 'GAP: they were put offline' },
  { k: 'verification_vehicle_lapsed', d: { docId: 'd1', subjectId: 's1', suspended: 3 }, to: null, why: 'GAP: a fleet owner learns their vehicle document lapsed' },
  { k: 'verification_l2', d: { audience: 'customer' }, to: null, why: 'GAP: assurance level raised' },
  { k: 'trust_l3', to: null, why: 'GAP: rider trust tier raised' },
  { k: 'liveness_midshift_prompt', d: { respondBy: '2026-01-01T00:00:00.000Z', profile: 'DRIVER' }, to: { screen: 'LivenessCheck', params: { profile: 'DRIVER', respondBy: '2026-01-01T00:00:00.000Z' } }, why: 'E12: the timed selfie check, deadline riding along' },
  { k: 'liveness_midshift_missed', to: { screen: 'LivenessCheck', params: { profile: 'DRIVER' } }, why: 'E12: a fresh PASS is the only way back online' },
  { k: 'liveness_locked', to: { screen: 'GetHelp', params: { category: 'ACCOUNT', subject: 'Identity check locked my account' } }, why: 'E12: only support clears a lock' },
  { k: 'incident_interim_lifted', d: { caseNumber: 'INC-1' }, to: null, why: 'GAP: suspension lifted' },
  { k: 'incident_shadow_restricted', d: { caseNumber: 'INC-1' }, to: null, why: 'GAP: account restricted' },
  { k: 'compliance_review_failed', d: { audience: 'earner', caseId: 'c1' }, to: null, why: 'GAP: earner compliance failure' },

  // ── Store / advertiser business surfaces [GAPS].
  { k: 'low_stock', d: { itemId: 'i1', remaining: 2 }, to: null, why: 'GAP: store — the item editor exists and is unrouted' },
  { k: 'staff_added', d: { vendorId: 'v1' }, to: null, why: 'GAP: store team screen' },
  { k: 'review_response', d: { ratingId: 'r1', vendorId: 'v1' }, to: null, why: 'GAP: store reviews' },
  { k: 'rating_removed', to: null, why: 'GAP: a rating was removed' },
  { k: 'category_request_resolved', to: null, why: 'GAP: store category request answered' },
  { k: 'support_update', d: { ticketId: 't1' }, to: null, why: 'GAP: support thread reply — no support screen wired' },
  { k: 'supply_returned', d: { audience: 'customer', pool: 'RIDER' }, to: null, why: 'GAP: movers are back — no order to open, so nothing to route to' },
  { k: 'agent_cancel', to: null, why: 'GAP: the agent asked to cancel an order but sends no orderId' },
  { k: 'ad_campaign_scheduled', d: { campaignId: 'c1' }, to: null, why: 'GAP: advertiser — CampaignDetail exists and is unrouted' },
  { k: 'ad_campaign_live', d: { campaignId: 'c1' }, to: null, why: 'GAP: same' },
  { k: 'ad_campaign_completed', d: { campaignId: 'c1' }, to: null, why: 'GAP: same' },
  { k: 'ad_campaign_paused', d: { campaignId: 'c1' }, to: null, why: 'GAP: same' },
  { k: 'ad_campaign_resumed', d: { campaignId: 'c1' }, to: null, why: 'GAP: same' },
  { k: 'ad_campaign_cancelled', d: { campaignId: 'c1' }, to: null, why: 'GAP: same' },
  { k: 'ad_campaign_killed', d: { campaignId: 'c1' }, to: null, why: 'GAP: same' },
  { k: 'ad_campaign_auto_cancelled', d: { campaignId: 'c1' }, to: null, why: 'GAP: same' },
  { k: 'ad_creative_rejected', d: { creativeId: 'c1', reason: 'POLICY' }, to: null, why: 'GAP: advertiser must re-upload' },
  { k: 'ad_invoice_receipt', d: { campaignId: 'c1', invoiceNumber: 'INV-1' }, to: null, why: 'GAP: advertiser receipt' },
  { k: 'ad_reservation_expiring', d: { campaignId: 'c1' }, to: null, why: 'GAP: a 5-minute money deadline' },
  { k: 'ad_late_capture', d: { campaignId: 'c1', invoiceId: 'i1' }, to: null, why: 'GAP: advertiser — a payment captured after the hold expired became a refund obligation (R045-ADS-05); no advertiser surface routes it yet' },
  { k: 'ad_weekly_report', d: { campaignId: 'c1', weekStart: '2026-01-05' }, to: null, why: 'GAP: advertiser report' },

  // ── Admin / ops pages. null is CORRECT: there is no mobile admin app.
  { k: 'ops_error_spike', to: null, why: 'admins' },
  { k: 'ops_collusion_affinity', to: null, why: 'admins' },
  { k: 'ops_billing_failures', to: null, why: 'admins' },
  { k: 'ops_pool_saturation', to: null, why: 'admins' },
  // Backups are stale, or are running but never leaving the machine they
  // protect. Admin-only and acted on from the server, not the phone.
  { k: 'ops_backup_stale', to: null, why: 'admins' },
  { k: 'ops_reaper_stale', d: { ageHours: 50 }, to: null, why: 'admins — the document reaper is behind by two cycles (DOC-1 §9.2)' },
  { k: 'ops_reaper_failed', d: { error: 'x' }, to: null, why: 'admins — the document reaper threw (DOC-1 §9.2)' },
  { k: 'ops_image_policy_failed', d: { error: 'boom' }, to: null, why: 'GAP: ops page, admin only' },
  { k: 'ops_extraction_breaker_open', d: { profileCode: 'GY_ID', rate: 0.2 }, to: null, why: 'GAP: ops page, admin only' },
  // Its sibling from the same heartbeat: a background job exhausted its retries
  // (N4/WS-8.1). Admin-only, and the surface that acts on it is the ADMIN web
  // console's Background jobs page — there is no mobile admin surface, so the
  // app opening normally is the correct destination, not a gap.
  { k: 'ops_dlq_non_empty', to: null, why: 'admins — acted on in the admin console, no mobile surface exists' },
  // Third alarm from the same heartbeat: OSRM is unreachable and every fare,
  // ETA and dispatch ranking has quietly reverted to straight-line distance.
  // Admin-only, and the action is on the OSRM host, not in any app.
  { k: 'ops_osrm_fallback', to: null, why: 'admins — the fix is on the routing host, not on a screen' },
  { k: 'ops_scheduler_stall', to: null, why: 'admins — kind built from a ternary', scan: false },
  { k: 'ops_scheduler_never_booted', to: null, why: 'admins — kind built from a ternary', scan: false },
  { k: 'billing_dunning_ops_task', to: null, why: 'admins' },
  { k: 'billing_invariants', to: null, why: 'admins' },
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
    guardian_driver_confirm: 'the driver is asked to confirm the trip status',
    dispatch_offer: 'the earner has an offer with a running clock',
    claim_over_gate: 'the rider is owed a delivery guarantee',
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
    const sent = new Set<string>();
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
