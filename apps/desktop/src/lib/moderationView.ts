// ---------------------------------------------------------------------------
// [D-17] A CHILD-SAFETY REPORT CANNOT BE CLOSED BY TYPING NOTHING.
//
// Two defects on one screen.
//
// THE CRASH. The reported content was summarised with:
//
//     `${'★'.repeat(Number(t['score']) || 0)} "${t['comment'] ?? ''}"`
//
// `String.prototype.repeat` THROWS `RangeError` on a negative count. A rating
// row whose score arrives negative — a bad migration, a hostile client, a
// schema change — does not render badly; it takes the whole moderation queue
// down, including the child-safety reports sorted to the top of it. A huge
// score floods the row instead. The formatter that renders a moderation queue
// must be total: it is the surface people report abuse to.
//
// THE CLOSURE. "Mark handled" and "Dismiss" sent `{ status, note? }` with the
// note OPTIONAL, on every report including CSAE. The API has since required a
// coded disposition and the evidence that disposition implies (A-17), so this
// console's CSAE closures are refused by the server — and before that rule
// existed, a child-safety report could be closed with an empty string.
//
// The law stays where it is enforced. This file builds the shape the server
// asks for and lets the server be the authority on whether it is complete;
// re-deriving the rule here would be a second copy to keep honest, which is
// how the tag vocabularies drifted in R048-008.
// ---------------------------------------------------------------------------

/** Bounded, total, and never throws — whatever arrives in `score`. */
export const MAX_STARS = 5;

export function stars(score: unknown): string {
  const n = typeof score === 'number' ? score : Number(score);
  if (!Number.isFinite(n)) return '';
  const whole = Math.floor(n);
  if (whole <= 0) return '';
  return '★'.repeat(Math.min(whole, MAX_STARS));
}

export interface ReportTarget { readonly [key: string]: unknown }

export interface ReportLike {
  readonly targetType: string;
  readonly targetId: string;
  readonly target?: ReportTarget | null;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : value == null ? '' : String(value));

/** One honest line per reported thing — and never a crash. */
export function targetSummary(r: ReportLike): string {
  const t = r.target;
  if (!t) return '(content already removed)';
  if (r.targetType === 'RATING') {
    const rating = stars(t['score']);
    const comment = text(t['comment']);
    return [rating, comment ? `"${comment}"` : ''].filter(Boolean).join(' ') || '(no rating text)';
  }
  if (r.targetType === 'CHAT_MESSAGE') return `"${text(t['message'])}"`;
  if (r.targetType === 'USER') return [t['firstName'], t['lastName']].map(text).filter(Boolean).join(' ') || text(t['id']);
  if (r.targetType === 'VENDOR') return text(t['name']);
  if (r.targetType === 'ITEM') return text(t['name']);
  return r.targetId;
}

// ── The closure ─────────────────────────────────────────────────────────────

/** The dispositions the API accepts (A-17). A closure states WHICH. */
export const CSAE_DISPOSITIONS = ['ENFORCED', 'ENFORCED_AND_REPORTED', 'NO_VIOLATION', 'DUPLICATE'] as const;
export type CsaeDisposition = (typeof CSAE_DISPOSITIONS)[number];

export type ClosureStatus = 'ACTIONED' | 'DISMISSED' | 'PROPOSE_DISMISS' | 'REVIEWING';

export interface CsaeClosureInput {
  readonly disposition?: CsaeDisposition | '';
  readonly enforcementRef?: string;
  readonly authorityRef?: string;
  readonly evidencePreserved?: boolean;
}

export interface ClosureBody {
  [key: string]: unknown;
  status: ClosureStatus;
  note?: string;
  disposition?: CsaeDisposition;
  enforcementRef?: string;
  authorityRef?: string;
  evidencePreserved?: boolean;
}

/**
 * The request body for a resolution.
 *
 * A CSAE row carries the disposition and its evidence; an ordinary row does
 * not, and must not — sending empty evidence fields on a spam report would
 * make the CSAE contract look satisfied everywhere.
 */
export function closureBody(
  status: ClosureStatus,
  note: string,
  csae?: CsaeClosureInput | null,
): ClosureBody {
  const body: ClosureBody = { status };
  const trimmedNote = note.trim();
  if (trimmedNote) body.note = trimmedNote;
  if (!csae) return body;
  if (csae.disposition) body.disposition = csae.disposition;
  const enforcement = csae.enforcementRef?.trim();
  const authority = csae.authorityRef?.trim();
  if (enforcement) body.enforcementRef = enforcement;
  if (authority) body.authorityRef = authority;
  if (csae.evidencePreserved) body.evidencePreserved = true;
  return body;
}

/**
 * Which fields a disposition asks the operator for. This is the FORM, not the
 * rule: the server decides whether a closure is complete and says what is
 * missing. Showing the right boxes is this file's job; judging them is not.
 */
export function fieldsFor(disposition: CsaeDisposition | '' | undefined): {
  enforcementRef: boolean; authorityRef: boolean; evidence: boolean;
} {
  switch (disposition) {
    case 'ENFORCED': return { enforcementRef: true, authorityRef: false, evidence: true };
    case 'ENFORCED_AND_REPORTED': return { enforcementRef: true, authorityRef: true, evidence: true };
    case 'NO_VIOLATION': return { enforcementRef: false, authorityRef: false, evidence: true };
    case 'DUPLICATE': return { enforcementRef: false, authorityRef: false, evidence: false };
    default: return { enforcementRef: false, authorityRef: false, evidence: false };
  }
}

/**
 * What a CSAE row's buttons are. Dismissing a child-safety report takes two
 * people (A-17), so this console PROPOSES a dismissal — it does not perform
 * one — and says so on the button.
 */
export function csaeActions(): ReadonlyArray<{ status: ClosureStatus; label: string }> {
  return [
    { status: 'ACTIONED', label: 'Record decision' },
    { status: 'PROPOSE_DISMISS', label: 'Propose dismissal (needs a second reviewer)' },
  ];
}
