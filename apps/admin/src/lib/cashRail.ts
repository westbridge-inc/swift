// ---------------------------------------------------------------------------
// [SAN spec Part 4] The agent-cash rail — how Swift actually gets paid.
//
// A partner pays their weekly fee IN CASH at an MMG agent, quoting their SAN.
// Three channels feed one pipeline (agent webhook, settlement file, an admin
// typing it in) and SO-6 governs the end of it: money that cannot be resolved
// to an account is RECORDED as UNMATCHED with an honest diagnosis. It is never
// rejected, because rejecting it would mean a partner paid and Swift has no
// record of the money at all.
//
// Which makes the unmatched queue the sharp end of the whole rail. Every row in
// it is a person who paid and is being treated as unpaid — and it had no
// screen, so nothing could be attached and the queue could only grow.
//
// The decisions live here rather than in the page so they can be graded without
// a DOM, and because two of them are easy to get quietly wrong: what a 202
// means, and which diagnoses may be attached at all.
// ---------------------------------------------------------------------------

export type UnmatchedFailureCode =
  | 'SAN_CHECKSUM_FAILED' | 'SAN_MALFORMED' | 'SAN_UNKNOWN'
  | 'TOMBSTONED' | 'ACCOUNT_CLOSED' | string;

export interface UnmatchedPayment {
  id: string;
  channel: 'MMG_AGENT_WEBHOOK' | 'MMG_SETTLEMENT_FILE' | 'MANUAL_ADMIN';
  sanRaw: string;
  amount: number;
  currencyCode: string;
  paidAt: string;
  createdAt: string;
  mmgTxnId: string | null;
  agentRef: string | null;
  payerMsisdn: string | null;
  failureCode: UnmatchedFailureCode | null;
  /** The server's own plain-language reading of the failure. */
  diagnosis: string;
  hoursOld: number;
  /** Server-computed: older than 24h. */
  breachesSla: boolean;
  refundFlaggedAt?: string | null;
  note?: string | null;
}

/**
 * What the operator should DO with this row.
 *
 * The diagnosis explains what went wrong; this says what fixes it. They are
 * different questions, and an operator working a queue at speed needs the
 * second one. It is derived from `failureCode`, never from the diagnosis
 * string — prose is for people, codes are for logic, and matching on prose is
 * how a wording change silently reroutes money.
 */
export type Remedy = 'attach' | 'refund' | 'investigate';

export function remedyFor(row: UnmatchedPayment): Remedy {
  switch (row.failureCode) {
    // A failed checksum cannot belong to anyone: the digits are not a SAN at
    // all. There is nobody to attach it to, so the money goes back.
    case 'SAN_CHECKSUM_FAILED':
    case 'SAN_MALFORMED':
      return 'refund';
    // The account is gone. Attaching would credit a closed subscription.
    case 'TOMBSTONED':
    case 'ACCOUNT_CLOSED':
      return 'refund';
    // A valid SAN nobody holds — a mis-key that beat the checksum. Somebody
    // meant to pay; find who by amount, phone and time.
    case 'SAN_UNKNOWN':
      return 'attach';
    default:
      return 'investigate';
  }
}

export const REMEDY_COPY: Record<Remedy, string> = {
  attach: 'Find who meant to pay and attach it — the SAN is valid, so a real account is one digit away.',
  refund: 'This cannot belong to anyone. Flag it for refund rather than attaching it somewhere plausible.',
  investigate: 'No standard diagnosis. Look at the raw record before deciding.',
};

/**
 * May this row be attached to an account?
 *
 * Deliberately narrow. "Plausible" is not a standard for moving money: a
 * failed-checksum payment attached to whichever account looks close credits
 * the wrong partner and leaves the right one still unpaid, with an audit trail
 * that says an admin did it on purpose.
 */
export const attachable = (row: UnmatchedPayment): boolean => remedyFor(row) === 'attach';

/** A SAN as typed at the counter, grouped for reading. Never re-derived —
 *  this is display only, and the raw value is what gets sent. */
export const formatSan = (raw: string): string =>
  raw.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();

export type Age = 'fresh' | 'aging' | 'breached';

/** The SLA is the server's (`breachesSla`, 24h). `aging` is a warning ahead of
 *  it so a queue worked once a day still catches rows before they breach. */
export function ageOf(row: UnmatchedPayment): Age {
  if (row.breachesSla) return 'breached';
  return row.hoursOld >= 12 ? 'aging' : 'fresh';
}

// ── What a 202 means here ──────────────────────────────────────────────────

/**
 * Attaching, refund-flagging, importing a settlement file and confirming a
 * deposit are all C4 (money): they need a SECOND admin. The server answers
 * 202 with APPROVAL_REQUIRED and queues the request.
 *
 * That is not an error, and a console that renders it as one is worse than
 * unhelpful — the operator retries, each retry queues another approval, and a
 * colleague arrives to a queue of duplicates for one payment.
 */
export interface MoneyActionOutcome {
  kind: 'done' | 'queued' | 'error';
  message: string;
  approvalId?: string;
}

export function outcomeOf(status: number, body: unknown): MoneyActionOutcome {
  const b = (body ?? {}) as {
    success?: boolean;
    error?: { code?: string; message?: string; details?: { approvalId?: string } };
  };
  if (status === 202 && b.error?.code === 'APPROVAL_REQUIRED') {
    return {
      kind: 'queued',
      message: 'Queued for a second admin. Nothing has moved yet — it happens when they approve.',
      ...(b.error.details?.approvalId ? { approvalId: b.error.details.approvalId } : {}),
    };
  }
  if (status >= 200 && status < 300 && b.success !== false) {
    return { kind: 'done', message: 'Recorded.' };
  }
  return { kind: 'error', message: b.error?.message ?? `The request failed (HTTP ${status}).` };
}

// ── Collections ────────────────────────────────────────────────────────────

export const COLLECTION_TABS = ['due72', 'pastdue', 'suspended', 'churned'] as const;
export type CollectionTab = (typeof COLLECTION_TABS)[number];

export const TAB_COPY: Record<CollectionTab, { label: string; meaning: string }> = {
  due72: { label: 'Due in 72h', meaning: 'Still active, fee lands within three days — a reminder now costs nothing.' },
  pastdue: { label: 'Past due', meaning: 'The fee did not arrive. They are still working; this is the window where a call helps.' },
  suspended: { label: 'Suspended', meaning: 'They have stopped earning. Every day here is a day of lost income for them and lost fee for Swift.' },
  churned: { label: 'Churned', meaning: 'Gone. Kept so the number is honest, not because anyone is chasing it.' },
};

export const CONTACT_OUTCOMES = ['PROMISED', 'REFUSED', 'NO_ANSWER', 'WRONG_NUMBER', 'RESOLVED'] as const;
export type ContactOutcome = (typeof CONTACT_OUTCOMES)[number];

/** A promise with no date is not a promise — it is a way to close a call. */
export function contactProblem(outcome: ContactOutcome | '', promisedDate: string): string | null {
  if (!outcome) return 'Say what happened on the call.';
  if (outcome === 'PROMISED' && !promisedDate) {
    return 'A promise needs a date, or nothing checks whether it was kept.';
  }
  return null;
}

// ── The numbers ────────────────────────────────────────────────────────────

export interface CashKpis {
  windowDays: number;
  channelMix: Array<{ channel: string; count: number; totalGyd: number }>;
  unmatched: { depth: number; oldestHours: number };
  collections: { contacts: number; promises: number; promisesKept: number; promiseKeptRate: number | null };
  subscriptionStates: Array<{ status: string; count: number }>;
}

/** GYD, whole units. The Guyanese convention writes it with a dollar sign. */
export const gyd = (n: number): string => `$${Math.round(n).toLocaleString('en-GY')}`;

/**
 * The one number that says whether the rail is healthy.
 *
 * Not the total collected — that goes up while the rail rots. Unmatched DEPTH
 * is money already paid that has reached nobody, and its age is how long a
 * partner has been treated as unpaid despite paying.
 */
export function railHealth(k: CashKpis | null): { state: 'ok' | 'watch' | 'bad'; line: string } {
  if (!k) return { state: 'ok', line: 'No figures yet.' };
  const { depth, oldestHours } = k.unmatched;
  if (depth === 0) return { state: 'ok', line: 'Every payment reached an account.' };
  const days = Math.floor(oldestHours / 24);
  const oldest = days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : `${oldestHours}h`;
  const line = `${depth} payment${depth === 1 ? '' : 's'} reached nobody — the oldest has waited ${oldest}.`;
  return { state: oldestHours >= 24 ? 'bad' : 'watch', line };
}

/**
 * The same reading, for how `apiFetch` actually surfaces a response.
 *
 * `apiFetch` THROWS whenever the body carries `success: false` — which a 202
 * APPROVAL_REQUIRED does. So the queued case arrives as an Error, not a return
 * value, and a page that only handles the throw as a failure will show a money
 * action as broken at the exact moment it worked.
 */
export function outcomeOfThrown(error: unknown): MoneyActionOutcome {
  const e = (error ?? {}) as { status?: number; code?: string; message?: string; details?: { approvalId?: string } };
  if (e.status === 202 && e.code === 'APPROVAL_REQUIRED') {
    return {
      kind: 'queued',
      message: 'Queued for a second admin. Nothing has moved yet — it happens when they approve.',
      ...(e.details?.approvalId ? { approvalId: e.details.approvalId } : {}),
    };
  }
  return { kind: 'error', message: e.message ?? 'The request failed.' };
}
