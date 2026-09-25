import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALERT_CLASS_KINDS, alertClassOf, pushOptionsFor, type AlertClass } from '../providers/notifications/alert-class';

// ---------------------------------------------------------------------------
// [Q10 loud alerts 1/4] THE ALERT-CLASS CENSUS. How loudly a push travels is
// a decision per kind, exactly like where its tap lands (the mobile tap-router
// census, apps/mobile/src/services/notification-router.test.ts). This scans
// apps/api/src the way that census does, so a kind shipped tomorrow fails
// here until someone decides whether it rings, needs the person now, can
// wait, or is ordinary. The runtime fallback (standard) is a safety net for a
// kind the scan cannot see, never a substitute for the decision.
// ---------------------------------------------------------------------------

const API_SRC = join(process.cwd(), 'src');

// The kind-property literals that are NOT push kinds: the same discriminant
// list the mobile census names (NOT_PUSH_KINDS there), so the two censuses
// agree on what "a kind the API sends" is.
const NOT_PUSH_KINDS = new Set([
  'pub', 'sub',
  'invalid', 'reuse', 'success', 'insufficient_assurance',
  'low', 'out',
  'rider',
  'stall',
  'advanced', 'banked', 'held', 'lost',
  'churned', 'dunned', 'nudged', 'preserved', 'skipped',
]);

// Classified kinds the lower-case scan cannot see, each with the reason.
const UNSCANNED: Record<string, string> = {
  RATING_REMINDER: 'upper-case (rating-reminder.ts), so the lower-case scan both censuses share misses it',
  test_alert: 'reserved for the settings test ring (loud alerts 3/4): nothing sends it yet, and when something does it must ring',
};

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return filesUnder(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

const sources = filesUnder(API_SRC).map((file) => readFileSync(file, 'utf8'));
const sent = new Set<string>();
for (const text of sources) {
  for (const m of text.matchAll(/kind: '([a-z][a-z0-9_]*)'/g)) {
    if (!NOT_PUSH_KINDS.has(m[1]!)) sent.add(m[1]!);
  }
}

const classified = new Map<string, AlertClass>(
  (Object.entries(ALERT_CLASS_KINDS) as Array<[AlertClass, readonly string[]]>)
    .flatMap(([alertClass, kinds]) => kinds.map((kind) => [kind, alertClass] as const)),
);

const sorted = (kinds: readonly string[]) => [...kinds].sort();

describe('the alert-class census: every kind the API sends has a deliberate loudness', () => {
  it('the scan itself found the sends', () => {
    // UNVERIFIED beats a fake PASS: a scan that found nothing proves nothing.
    expect(sent.size).toBeGreaterThan(100);
    expect(sent.has('vendor_order_alert') && sent.has('dispatch_offer')).toBe(true);
  });

  it('every kind the API sends is classified by name, not left to the fallback', () => {
    const unclassified = [...sent].filter((kind) => !classified.has(kind)).sort();
    expect(unclassified, 'API kinds with no alert class: decide how loudly each one travels').toEqual([]);
  });

  it('nothing is classified that nothing sends, and each exception is still true', () => {
    const phantom = [...classified.keys()].filter((kind) => !sent.has(kind) && !(kind in UNSCANNED)).sort();
    expect(phantom, 'classified kinds the API no longer sends').toEqual([]);
    for (const kind of Object.keys(UNSCANNED)) expect(classified.has(kind), `${kind} is excused but not classified`).toBe(true);
    expect(sources.some((text) => text.includes("kind: 'RATING_REMINDER'")), 'RATING_REMINDER is no longer sent').toBe(true);
    expect(sent.has('test_alert'), 'test_alert is sent now: drop it from UNSCANNED').toBe(false);
  });

  it('no kind sits in two classes', () => {
    const all = Object.values(ALERT_CLASS_KINDS).flat();
    expect(all.length).toBe(new Set(all).size);
  });

  it('the ringing set is frozen', () => {
    // Ringing is the loudest thing Swift can do to a phone. A kind added here
    // rings partners for it; a kind removed stops ringing a store that must
    // answer. Either is a product decision, made by editing this line.
    expect(sorted(ALERT_CLASS_KINDS.ring_order)).toEqual(['booking_requested', 'test_alert', 'vendor_order_alert']);
    expect(sorted(ALERT_CLASS_KINDS.ring_offer)).toEqual(['dispatch_offer']);
  });

  it('the urgent job set and the quiet set are pinned too', () => {
    // Demoting a kind to quiet makes it silent and lets Android hold it; that
    // is reviewed here, not discovered on a phone.
    expect(sorted(ALERT_CLASS_KINDS.job_update)).toEqual([
      'booking_to_confirm', 'guardian_driver_confirm', 'liveness_midshift_prompt', 'prep_ready',
    ]);
    expect(sorted(ALERT_CLASS_KINDS.quiet)).toEqual([
      'RATING_REMINDER', 'ad_campaign_completed', 'ad_campaign_live', 'ad_campaign_resumed', 'ad_campaign_scheduled',
      'ad_invoice_receipt', 'ad_weekly_report', 'trial_fee_education', 'vendor_tier_nudge',
    ]);
  });

  it('an unknown or missing kind is standard: delivered promptly, never silenced', () => {
    expect(alertClassOf('a_kind_shipped_tomorrow')).toBe('standard');
    expect(alertClassOf(undefined)).toBe('standard');
    expect(alertClassOf(42)).toBe('standard');
    const standard = { alertClass: 'standard', priority: 'high', sound: 'default' };
    expect(pushOptionsFor({ kind: 'a_kind_shipped_tomorrow' })).toEqual(standard);
    expect(pushOptionsFor({ orderId: 'o1' })).toEqual(standard);
    expect(pushOptionsFor(null)).toEqual(standard);
  });
});

describe('the delivery each class asks for', () => {
  const at = (iso: string) => Date.parse(iso);

  it('ring_order: high priority, the device sound, and it dies at respondBy', () => {
    expect(pushOptionsFor({ kind: 'vendor_order_alert', orderId: 'o1', respondBy: '2026-09-24T20:10:00.000Z' }))
      .toEqual({ alertClass: 'ring_order', priority: 'high', sound: 'default', deadlineMs: at('2026-09-24T20:10:00.000Z') });
    // A booking request carries no deadline: it rings with the provider default.
    expect(pushOptionsFor({ kind: 'booking_requested', jobId: 'j1' }))
      .toEqual({ alertClass: 'ring_order', priority: 'high', sound: 'default' });
  });

  it('ring_offer: high priority, the device sound, and it dies at the offer expiry', () => {
    expect(pushOptionsFor({ kind: 'dispatch_offer', orderId: 'o1', offerAttemptId: 'a1', expiresAt: '2026-09-24T20:00:20.000Z' }))
      .toEqual({ alertClass: 'ring_offer', priority: 'high', sound: 'default', deadlineMs: at('2026-09-24T20:00:20.000Z') });
  });

  it('job_update: high priority, the device sound, an hour at most, and never past respondBy', () => {
    expect(pushOptionsFor({ kind: 'prep_ready', orderId: 'o1', audience: 'earner' }))
      .toEqual({ alertClass: 'job_update', priority: 'high', sound: 'default', ttlSeconds: 3600 });
    expect(pushOptionsFor({ kind: 'liveness_midshift_prompt', respondBy: '2026-09-24T20:05:00.000Z', profile: 'DRIVER' }))
      .toEqual({ alertClass: 'job_update', priority: 'high', sound: 'default', ttlSeconds: 3600, deadlineMs: at('2026-09-24T20:05:00.000Z') });
  });

  it('standard: high priority, the device sound, the provider default ttl', () => {
    expect(pushOptionsFor({ orderId: 'o1', orderNumber: 'SW-1', status: 'ACCEPTED' }))
      .toEqual({ alertClass: 'standard', priority: 'high', sound: 'default' });
  });

  it('quiet: normal priority, no sound, a day', () => {
    expect(pushOptionsFor({ kind: 'RATING_REMINDER', orderId: 'o1' }))
      .toEqual({ alertClass: 'quiet', priority: 'normal', ttlSeconds: 86_400 });
  });

  it('a malformed deadline, or one a class does not read, never cuts a push short', () => {
    expect(pushOptionsFor({ kind: 'dispatch_offer', orderId: 'o1', expiresAt: 'soon' }))
      .toEqual({ alertClass: 'ring_offer', priority: 'high', sound: 'default' });
    // The passenger safety check-in carries a respondBy, but it is standard:
    // a late check-in still reaches the passenger.
    expect(pushOptionsFor({ kind: 'guardian_checkin', level: 'HARD', respondBy: '2020-01-01T00:00:00.000Z' }))
      .toEqual({ alertClass: 'standard', priority: 'high', sound: 'default' });
  });
});
