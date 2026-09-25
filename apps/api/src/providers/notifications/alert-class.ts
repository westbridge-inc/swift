// ---------------------------------------------------------------------------
// Alert classes [Q10 loud alerts 1/4] — HOW URGENTLY one push travels.
//
// Until this file every push left as the same non-urgent Expo message: no
// priority (so Android delivered at its "normal" rate and a dozing phone held
// it for the next maintenance window), no expiry, one sound. A new order for a
// kitchen and a "rate your meal" nudge were the same message. Now each kind a
// push can carry belongs to ONE class, and the class decides the delivery:
//
//   ring_order  a store must answer an order or booking   high · sound · dies at respondBy
//   ring_offer  a mover has an offer with a running clock high · sound · dies at expiresAt
//   job_update  a live job needs the person now          high · sound · 1 h, and never past respondBy
//   standard    everything else                          high · sound · provider default
//   quiet       rating reminders, ad reports, nudges     normal · silent · 24 h
//
// Deliberately NOT here yet (they need a new app build, loud alerts 3/4):
// Android channels, bundled ring sounds and the iOS interruption level. Old
// builds only have the "default" channel, so no channel id is ever sent.
//
// A CENSUS, NOT A GUESS. Every kind the API sends is listed below under the
// class it was given, and alert-class-census.test.ts scans apps/api/src and
// fails until a new kind is placed. At runtime an unknown kind falls back to
// standard, never to silence. The lists hold plain strings on purpose: the
// mobile tap-router census reads kind-PROPERTY literals in apps/api/src as
// "a push the API sends", and classifying a kind here sends nothing.
// ---------------------------------------------------------------------------

import type { PushOptions } from './channels';

export type AlertClass = 'ring_order' | 'ring_offer' | 'job_update' | 'standard' | 'quiet';

/** Every kind the API sends, under the class that decides its delivery. */
export const ALERT_CLASS_KINDS: Readonly<Record<AlertClass, readonly string[]>> = {
  // A store or provider must answer, or the customer is failed. test_alert is
  // reserved for the settings screen test ring (loud alerts 3/4): nothing
  // sends it yet, and when something does it must ring like the real thing.
  ring_order: ['vendor_order_alert', 'booking_requested', 'test_alert'],

  // The one offer a mover gets, on a 20 s clock (12 s express).
  ring_offer: ['dispatch_offer'],

  // A job already in hand needs the person now.
  job_update: ['prep_ready', 'booking_to_confirm', 'guardian_driver_confirm', 'liveness_midshift_prompt'],

  // Nothing is lost if these land an hour late and silently.
  quiet: [
    'RATING_REMINDER',
    'ad_weekly_report', 'ad_invoice_receipt',
    'ad_campaign_scheduled', 'ad_campaign_live', 'ad_campaign_completed', 'ad_campaign_resumed',
    'vendor_tier_nudge', 'trial_fee_education',
  ],

  standard: [
    // Orders, the customer side of a journey
    'substitution_pending', 'line_refunded', 'strike', 'delivery_options', 'delivery_cash_settlement',
    'dispatch_retrying', 'dispatch_exhausted', 'converted_to_pickup', 'mover_session_revocation',
    'mmg_payment_confirmed', 'mmg_claim_disputed', 'mmg_claim_resolved', 'mmg_claim_mismatch',
    'mmg_unattested_cancellation', 'supply_returned',
    // Rides
    'ride_queue_matched', 'ride_queue_expired', 'ride_released_no_drivers',
    // Bookings and service jobs, other than the two that ring or need action now
    'booking_confirmed', 'booking_slot_declined', 'booking_completed', 'booking_cancelled',
    'booking_reminder', 'booking_rescheduled',
    // Safety of the person receiving it (the driver confirm is a job update)
    'guardian_checkin', 'trip_share_rotated', 'liveness_midshift_missed', 'liveness_locked',
    'incident_interim_suspension', 'incident_interim_lifted', 'incident_shadow_restricted',
    // Money a partner must act on (billing_suspended_nudge is about a suspension,
    // not a marketing nudge, so it stays loud)
    'billing_mmg_pending', 'billing_success', 'billing_failed', 'billing_final_warning',
    'billing_suspended', 'billing_suspended_nudge', 'billing_reminder', 'billing_banked',
    'billing_churned', 'billing_topup', 'fx_change_notice', 'usd_migration_notice',
    'claim', 'claim_update', 'claim_over_gate', 'rlp_suspended', 'rlp_reinstated',
    'mmg_link_change_staged', 'mmg_link_change_applied', 'mmg_link_change_cancelled',
    // Verification and trust
    'verification_approved', 'verification_rejected', 'verification_expired',
    'verification_expiry_reminder', 'verification_forced_offline', 'verification_vehicle_lapsed',
    'verification_l2', 'trust_l3', 'compliance_review_failed',
    // Store and advertiser business surfaces (an ad that needs action stays loud)
    'low_stock', 'staff_added', 'review_response', 'rating_removed', 'category_request_resolved',
    'category_backfill_review', 'vendor_tier_promoted', 'support_update', 'store_pin_moved',
    'ad_campaign_paused', 'ad_campaign_cancelled', 'ad_campaign_killed', 'ad_campaign_auto_cancelled',
    'ad_creative_rejected', 'ad_reservation_expiring', 'ad_late_capture',
    // Operations pages (admins)
    'support_ticket', 'sos_active', 'sos_marked_safe', 'guardian_deescalation',
    'guardian_checkin_undelivered', 'incident_duplicate_intake', 'legal_hold_partial',
    'safety_escrow_review', 'not_my_driver_discrepancy', 'ops_alert_escalated', 'ops_alert_drill',
    'safety_sweep_slo', 'ops_delivery_rider_dropped', 'ops_dispatch_exhausted', 'ops_food_too_old',
    'ops_taxi_driver_dropped', 'ops_error_spike', 'ops_collusion_affinity', 'ops_billing_failures',
    'ops_pool_saturation', 'ops_backup_stale', 'ops_reaper_stale', 'ops_reaper_failed',
    'ops_image_policy_failed', 'ops_extraction_breaker_open', 'ops_dlq_non_empty', 'ops_osrm_fallback',
    'handover_claims_unmatched', 'rlp_sla_breached', 'rlp_reserve_low', 'rlp_reserve_provisioned',
    'billing_dunning_ops_task', 'billing_invariants', 'billing_manual_reconciliation',
    'billing_unknown_intents_sla', 'reconcile_mismatch', 'settlement_trailer_mismatch',
    'settlement_deposit_mismatch', 'earnings_missing', 'agent_cash_sla',
    'incident_new', 'incident_sla_breach', 'incident_weekly_digest', 'incident_pattern_cross_reporter',
    'liveness_outage', 'liveness_review', 'compliance_violation', 'verification_pending',
    'verification_sla_breach', 'verification_legal_hold_overdue', 'audit_chain_broken',
    'audit_chain_anchor', 'integrity_appeal', 'dup_doc', 'vendor_pending', 'advertiser_application',
    'ad_review_sla_risk', 'ad_campaign_killed_ops', 'ad_refund_payout_task', 'ad_campaign_paid',
  ],
};

const CLASS_OF = new Map<string, AlertClass>();
for (const [alertClass, kinds] of Object.entries(ALERT_CLASS_KINDS) as Array<[AlertClass, readonly string[]]>) {
  for (const kind of kinds) {
    const already = CLASS_OF.get(kind);
    if (already) throw new Error(`alert-class: ${kind} is listed as both ${already} and ${alertClass}`);
    CLASS_OF.set(kind, alertClass);
  }
}

/** The class a push kind belongs to. Unknown or missing kinds are standard:
 *  a push the table forgot is delivered promptly, never silenced. */
export function alertClassOf(kind: unknown): AlertClass {
  return (typeof kind === 'string' && CLASS_OF.get(kind)) || 'standard';
}

interface ClassPolicy {
  priority: PushOptions['priority'];
  sound?: PushOptions['sound'];
  /** Ceiling on how long a provider may hold the push for redelivery. */
  ttlSeconds?: number;
  /** The payload field holding the moment the push stops meaning anything. */
  deadlineField?: 'respondBy' | 'expiresAt';
}

const POLICY: Readonly<Record<AlertClass, ClassPolicy>> = {
  ring_order: { priority: 'high', sound: 'default', deadlineField: 'respondBy' },
  ring_offer: { priority: 'high', sound: 'default', deadlineField: 'expiresAt' },
  job_update: { priority: 'high', sound: 'default', ttlSeconds: 3600, deadlineField: 'respondBy' },
  standard: { priority: 'high', sound: 'default' },
  quiet: { priority: 'normal', ttlSeconds: 86_400 },
};

/** A deadline is only trusted when it is a real timestamp; anything else is
 *  ignored, so a malformed field can never silence a push. */
function deadlineOf(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** The delivery options for one push, read from the payload it carries.
 *  The deadline is absolute: the provider turns it into a ttl at the moment
 *  it sends, so a retry two seconds later asks for two seconds less. */
export function pushOptionsFor(data: Record<string, unknown> | null | undefined): PushOptions {
  const alertClass = alertClassOf(data?.['kind']);
  const policy = POLICY[alertClass];
  const deadlineMs = policy.deadlineField ? deadlineOf(data?.[policy.deadlineField]) : undefined;
  return {
    alertClass,
    priority: policy.priority,
    ...(policy.sound ? { sound: policy.sound } : {}),
    ...(policy.ttlSeconds !== undefined ? { ttlSeconds: policy.ttlSeconds } : {}),
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
  };
}
