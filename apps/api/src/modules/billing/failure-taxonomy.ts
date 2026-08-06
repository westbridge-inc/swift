// TOLLGATE PART 5.2 — the normalized failure taxonomy: the single vocabulary
// every collection rail maps into and everything downstream (dunning branches,
// retry policy, Command queues, metrics) reads. Adapters translate their
// native codes HERE; an unmapped provider code maps to PROVIDER_DOWN so new
// codes surface loudly instead of silently misbehaving.

export type NormalizedFailure =
  | 'INSUFFICIENT_FUNDS'
  | 'PAYER_REJECTED'
  | 'PAYER_UNREACHABLE'
  | 'REQUEST_EXPIRED'
  | 'INVALID_ACCOUNT'
  | 'LIMIT_EXCEEDED'
  | 'PROVIDER_DOWN'
  | 'TIMEOUT_UNKNOWN'
  | 'AMOUNT_MISMATCH'
  | 'DUPLICATE'
  | 'UNSUPPORTED';

/** What the scheduler may do about a failure — dunning reads this, not the code. */
export type RetryClass = 'RETRY_LATER' | 'NO_AUTO_RETRY' | 'NO_RETRY' | 'RETRY_BACKOFF' | 'POLLER_OWNED' | 'HELD_FOR_HUMAN';

export const RETRY_CLASS: Record<NormalizedFailure, RetryClass> = {
  INSUFFICIENT_FUNDS: 'RETRY_LATER',
  PAYER_REJECTED: 'NO_AUTO_RETRY',
  PAYER_UNREACHABLE: 'NO_RETRY',
  REQUEST_EXPIRED: 'RETRY_LATER',
  INVALID_ACCOUNT: 'NO_RETRY',
  LIMIT_EXCEEDED: 'NO_RETRY',
  PROVIDER_DOWN: 'RETRY_BACKOFF',
  TIMEOUT_UNKNOWN: 'POLLER_OWNED',
  AMOUNT_MISMATCH: 'HELD_FOR_HUMAN',
  DUPLICATE: 'NO_RETRY',
  UNSUPPORTED: 'NO_RETRY',
};

/** MMG merchant-initiated: map a terminal lookup/initiate outcome to the
 *  taxonomy. `reason` sharpens the mapping where MMG's status alone is too
 *  coarse (the Q10 register answer will extend this table — the mechanism is
 *  already the law). */
export function mapMmgFailure(status: string, reason?: string): NormalizedFailure {
  const r = (reason ?? '').toLowerCase();
  if (r.includes('insufficient') || r.includes('balance')) return 'INSUFFICIENT_FUNDS';
  if (r.includes('invalid') && (r.includes('msisdn') || r.includes('payer') || r.includes('account'))) return 'PAYER_UNREACHABLE';
  if (r.includes('limit')) return 'LIMIT_EXCEEDED';
  switch (status) {
    case 'declined':
      return 'PAYER_REJECTED';
    case 'reversed':
      return 'PAYER_REJECTED';
    case 'expired':
      return 'REQUEST_EXPIRED';
    case 'error':
      return 'TIMEOUT_UNKNOWN'; // transport-shaped: the request MAY have landed
    default:
      return 'PROVIDER_DOWN';
  }
}

/** Card rail (PowerTranz/Stripe/Sandbox behind PaymentProvider). */
export function mapCardFailure(reason?: string): NormalizedFailure {
  const r = (reason ?? '').toLowerCase();
  if (r.includes('insufficient')) return 'INSUFFICIENT_FUNDS';
  if (r.includes('declin')) return 'PAYER_REJECTED';
  if (r.includes('expired card') || r.includes('invalid') || r.includes('token')) return 'INVALID_ACCOUNT';
  if (r.includes('limit')) return 'LIMIT_EXCEEDED';
  if (r.includes('timeout') || r.includes('unreachable') || r.includes('unavailable')) return 'PROVIDER_DOWN';
  return 'PAYER_REJECTED';
}
