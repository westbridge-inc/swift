// ---------------------------------------------------------------------------
// WHETHER A DEAD JOB MAY BE RETRIED.
//
// The DLQ page said, as a plain statement of fact:
//
//   "Retrying is safe: every Swift job is written to be idempotent, which is
//    why they retry with backoff by default."
//
// Nobody had established that. There are 53 job classes; the claim covered all
// of them, and the page offered one-click retry on every dead job on the
// strength of it. A job that failed AFTER an external side effect — a
// notification sent, a provider called, money moved — and is then retried does
// that side effect twice, and the operator was told it could not happen.
//
// So retry-safety is now a PROPERTY EACH CLASS HAS TO EARN, and the default is
// refusal. That is the register's own rollout: disable replay for unclassified
// jobs, certify classes one by one.
//
// THE METHOD, so the next certification is not a guess either. A class is
// SAFE_REPLAY only when its handler was read and one of these is true of it:
//   * it only DELETES rows already past a deadline (a second run finds none);
//   * it RECOMPUTES from a window of inputs, so the output depends on the
//     inputs and not on how many times it ran;
//   * it drains an OUTBOX or claims work under a lease, which is idempotent by
//     construction; or
//   * every external effect it has goes through an explicitly deduped path.
// "The comment says idempotent" is NOT evidence — that is the claim being
// checked, not a proof of it.
//
// 8 of 53 classes are certified today. The rest are NOT_CERTIFIED, which is a
// statement about what has been VERIFIED, not an accusation that they are
// unsafe. Certifying one is a small piece of work: read the handler, find the
// property, name it here, and the button turns back on.
// ---------------------------------------------------------------------------

/** What an operator may do with a dead job of this class. */
export type RecoveryPolicy =
  /** Re-running it cannot produce a second effect. One click. */
  | 'SAFE_REPLAY'
  /** It may have half-finished. Reconcile the outcome before replaying, and
   *  say so — the API takes an explicit acknowledgement, never a default. */
  | 'RECONCILE_FIRST'
  /** Nobody has established either of the above for this class yet. Replay is
   *  refused rather than guessed at. */
  | 'NOT_CERTIFIED';

export interface Recovery {
  policy: RecoveryPolicy;
  /** Why — in the words of whoever certified it, or why it has not been. */
  why: string;
}

/** Every job class this worker dispatches, and what may be done with a dead one.
 *  The census test asserts this covers exactly the names queue.ts handles, so a
 *  new job cannot ship without an answer here. */
export const JOB_RECOVERY: Record<JobName, Recovery> = {
  'ads-lifecycle': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'ads-release-expired': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'ads-stats-rollup': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'ads-weekly-report': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'agent-cash-sla': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'agent-ops-scan': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'algo-decision-retention': { policy: 'SAFE_REPLAY', why: 'Purges decision-log rows past their retention. A second run finds nothing left to purge.' },
  'auto-cancel': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'auto-complete': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'reaper-lag': { policy: 'SAFE_REPLAY', why: 'Reads the reaper heartbeat, sets a gauge and pages through opsPageOnce, which dedupes. It writes no business rows.' },
  'backup-freshness': { policy: 'SAFE_REPLAY', why: 'Reads backup state and pages through opsPageOnce, which is explicitly deduped. It writes no business rows.' },
  'batching-shadow-scan': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'billing-fx-notices': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'billing-invariants': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'booking-reminders': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'checkout-outbox': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'collusion-affinity-scan': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'compliance-sample': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'convert-trials': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'cw-scan': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'discovery-ai-classify': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'discovery-backfill': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'discovery-derivation': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'dispatch-order': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'eta-pad-weekly': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'evidence-retention': { policy: 'SAFE_REPLAY', why: 'Repairs holds, drains the legal-hold VAULT OUTBOX (idempotent by construction) and deletes only unsealed, case-less bundles past their window; the database triggers refuse anything else.' },
  'expiry-sweep': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'flag-ratings': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'guardian-sweep': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'incident-pattern-scan': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'incident-sla-watch': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'incident-weekly-digest': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'liveness-midshift': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'mmg-link-apply': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'mover-revocation-outbox': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'offer-timeout': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'poll-mmg-billing': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'prep-shadow-grade': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'prep-stats-nightly': { policy: 'SAFE_REPLAY', why: 'Recomputes every vendor prep-time distribution from a trailing window. The input is the window, not the previous run.' },
  'process-billing': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'promote-sos-grace': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'qr-attribution-purge': { policy: 'SAFE_REPLAY', why: 'Hard-deletes attribution rows already past their expiry. A second run finds nothing left to delete.' },
  'rating-actor-fold': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'rating-reminder-sweep': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'rating-stats-recompute': { policy: 'SAFE_REPLAY', why: 'A full recompute whose contract is that it lands IDENTICAL to the incremental path. Running it twice produces the same aggregates.' },
  'reconcile-dispatch': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'reconcile-earnings': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'release-held-orders': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'retention-sweep': { policy: 'SAFE_REPLAY', why: 'Seeds retention defaults (an upsert) and deletes rows past their window. A second run deletes nothing new.' },
  'route-match': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'scheduler-heartbeat': { policy: 'SAFE_REPLAY', why: 'Writes one Redis key and pages on pool saturation through opsPageOnce, which dedupes. A second run overwrites the same key.' },
  'stale-movers': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'supply-watch-scan': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
  'tier-recalc': { policy: 'NOT_CERTIFIED', why: 'Not yet certified — see the method in this file.' },
};

export type JobName =
  | 'ads-lifecycle'
  | 'ads-release-expired'
  | 'ads-stats-rollup'
  | 'ads-weekly-report'
  | 'agent-cash-sla'
  | 'agent-ops-scan'
  | 'algo-decision-retention'
  | 'auto-cancel'
  | 'auto-complete'
  | 'backup-freshness'
  | 'reaper-lag'
  | 'batching-shadow-scan'
  | 'billing-fx-notices'
  | 'billing-invariants'
  | 'booking-reminders'
  | 'checkout-outbox'
  | 'collusion-affinity-scan'
  | 'compliance-sample'
  | 'convert-trials'
  | 'cw-scan'
  | 'discovery-ai-classify'
  | 'discovery-backfill'
  | 'discovery-derivation'
  | 'dispatch-order'
  | 'eta-pad-weekly'
  | 'evidence-retention'
  | 'expiry-sweep'
  | 'flag-ratings'
  | 'guardian-sweep'
  | 'incident-pattern-scan'
  | 'incident-sla-watch'
  | 'incident-weekly-digest'
  | 'liveness-midshift'
  | 'mmg-link-apply'
  | 'mover-revocation-outbox'
  | 'offer-timeout'
  | 'poll-mmg-billing'
  | 'prep-shadow-grade'
  | 'prep-stats-nightly'
  | 'process-billing'
  | 'promote-sos-grace'
  | 'qr-attribution-purge'
  | 'rating-actor-fold'
  | 'rating-reminder-sweep'
  | 'rating-stats-recompute'
  | 'reconcile-dispatch'
  | 'reconcile-earnings'
  | 'release-held-orders'
  | 'retention-sweep'
  | 'route-match'
  | 'scheduler-heartbeat'
  | 'stale-movers'
  | 'supply-watch-scan'
  | 'tier-recalc';

/** The answer for a job name, including one this file has never heard of —
 *  which is refused, not assumed safe. */
export function recoveryFor(name: string): Recovery {
  return (JOB_RECOVERY as Record<string, Recovery>)[name]
    ?? { policy: 'NOT_CERTIFIED', why: 'Unknown job class — nothing is known about replaying it.' };
}

/** Whether a requeue may proceed, given what the operator acknowledged. */
export function requeueRefusal(name: string, acknowledgedReconciled: boolean): string | null {
  const { policy, why } = recoveryFor(name);
  if (policy === 'SAFE_REPLAY') return null;
  if (policy === 'RECONCILE_FIRST') {
    return acknowledgedReconciled
      ? null
      : `"${name}" may have half-finished before it failed. Reconcile the outcome first, then retry with that acknowledged. ${why}`;
  }
  return `"${name}" is not certified for replay, so this platform will not repeat it on a guess. ${why}`;
}
