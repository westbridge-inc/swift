// ---------------------------------------------------------------------------
// [D-12] A DEAD JOB IS NOT A BUTTON, AND ITS PAYLOAD IS NOT A CAPTION.
//
// The health screen offered "Requeue" identically on all 53 job classes and
// printed the job's payload straight into the page:
//
//     <p className="truncate">{j.data}</p>
//
// Two separate problems, one row.
//
// THE BUTTON. The API already refuses 45 of those classes (A-08's certified
// recovery matrix) and SENDS its verdict with every dead job — `recovery:
// { policy, why }`. The page ignored it, so an operator clicked, waited, and
// got a 409 explaining what the page could have told them before they asked.
// Worse, it read as an offer: the console appeared to believe the retry was
// safe.
//
// THE PAYLOAD. A job's data carries whatever the job was about: a phone
// number, a delivery address, a payer reference, a token. `truncate` is CSS —
// the whole string is in the DOM, selectable, copyable, and in any screenshot
// of the page. An ops console showing the queue does not need to show the
// contents; it needs the shape.
// ---------------------------------------------------------------------------

export type RecoveryPolicy = 'SAFE_REPLAY' | 'RECONCILE_FIRST' | 'NOT_CERTIFIED';

export interface DeadJobRecovery {
  readonly policy?: unknown;
  readonly why?: unknown;
}

export interface DeadJob {
  readonly queue: string;
  readonly id: string;
  readonly name: string;
  readonly failedReason?: unknown;
  readonly attemptsMade?: unknown;
  readonly data?: unknown;
  readonly recovery?: DeadJobRecovery | null;
}

export interface ReplayVerdict {
  readonly policy: RecoveryPolicy;
  /** May the operator press Requeue at all? */
  readonly offered: boolean;
  /** Must they first confirm they reconciled the half-finished outcome? */
  readonly needsAcknowledgement: boolean;
  readonly label: string;
  /** Why, in the words the API gave — never re-derived here. */
  readonly why: string;
}

const POLICIES: readonly RecoveryPolicy[] = ['SAFE_REPLAY', 'RECONCILE_FIRST', 'NOT_CERTIFIED'];

/**
 * What this console may offer for one dead job.
 *
 * The classification is the SERVER's (A-08). A job that arrives without one —
 * an older API, a new class, a mangled response — is `NOT_CERTIFIED`, because
 * the one thing a retry button must never do is assume.
 */
export function replayVerdict(job: DeadJob): ReplayVerdict {
  const raw = job.recovery?.policy;
  const policy: RecoveryPolicy = POLICIES.includes(raw as RecoveryPolicy) ? (raw as RecoveryPolicy) : 'NOT_CERTIFIED';
  const why = typeof job.recovery?.why === 'string' && job.recovery.why
    ? job.recovery.why
    : 'This job class carries no replay certification, so repeating it could repeat whatever it already did.';
  if (policy === 'SAFE_REPLAY') {
    return { policy, offered: true, needsAcknowledgement: false, label: 'Requeue', why };
  }
  if (policy === 'RECONCILE_FIRST') {
    return {
      policy,
      offered: true,
      needsAcknowledgement: true,
      label: 'Reconcile, then requeue',
      why,
    };
  }
  return { policy, offered: false, needsAcknowledgement: false, label: 'Cannot be replayed', why };
}

/** What the operator must confirm before a RECONCILE_FIRST retry is sent. */
export function acknowledgementPrompt(job: DeadJob, verdict: ReplayVerdict): string {
  return `"${job.name}" may have half-finished before it failed.\n\n${verdict.why}\n\n`
    + 'Confirm ONLY if you have checked the outcome and it did not complete. Retrying an action that already happened does it twice.';
}

// ── The payload ─────────────────────────────────────────────────────────────

/** Values that must never be printed, by shape rather than by field name — a
 *  field called `x` holding a phone number is still a phone number. */
const SENSITIVE_VALUE = [
  { re: /^\+?\d[\d\s().-]{6,}$/, as: 'phone' },
  { re: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, as: 'email' },
  { re: /^[A-Za-z0-9_-]{24,}$/, as: 'token' },
  { re: /\d+\s+[A-Za-z].*\s(street|st|road|rd|avenue|ave|lane|drive|dr)\b/i, as: 'address' },
] as const;

/** Keys whose value is sensitive whatever it looks like. */
const SENSITIVE_KEY = /(phone|msisdn|email|address|token|secret|password|otp|code|nonce|pin|lat|lng|latitude|longitude|comment|note|reason|name)/i;

function summariseValue(key: string, value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === 'object') return '{…}';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return SENSITIVE_KEY.test(key) ? '«redacted»' : String(value);
  const text = String(value);
  if (SENSITIVE_KEY.test(key)) return '«redacted»';
  for (const { re, as } of SENSITIVE_VALUE) if (re.test(text)) return `«${as}»`;
  // An id is the one string worth showing: it is what an operator searches by.
  if (/^[A-Za-z0-9_-]{1,23}$/.test(text)) return text;
  return '«text»';
}

/**
 * What the console prints instead of the payload: the keys, and the shape of
 * each value. Enough to tell one dead job from another; never the contents.
 */
export function payloadSummary(raw: unknown): string {
  if (raw == null || raw === '') return '(no payload)';
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    // An unparsable payload is never echoed — that is exactly the case where
    // nobody knows what is in it.
    return '(payload not readable — not shown)';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return '(payload not an object — not shown)';
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) return '(empty payload)';
  return entries.map(([k, v]) => `${k}: ${summariseValue(k, v)}`).join(' · ');
}

/**
 * The failure text, which is a message from a stack trace and can quote the
 * data that caused it. Kept short and stripped of anything value-shaped.
 */
export function failureSummary(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const cleaned = raw
    .replace(/\+?\d[\d\s().-]{6,}/g, '«phone»')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '«email»')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '«token»');
  return cleaned.length > 300 ? `${cleaned.slice(0, 300)}…` : cleaned;
}
