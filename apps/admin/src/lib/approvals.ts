// ---------------------------------------------------------------------------
// [ADM-005] What a second admin is actually being asked to sign.
//
// The decision rules live here rather than in the page so they can be graded
// without a DOM — and because getting one of them wrong turns a control into a
// rubber stamp, which is worse than having no control at all.
//
// The server enforces every rule below and is the authority. This mirrors them
// so the queue can say WHY a row cannot be decided, instead of offering a
// button that returns 403. During a money decision, a console that offers an
// action it knows will fail is teaching the operator to click through errors.
// ---------------------------------------------------------------------------

export interface ApprovalRow {
  id: string;
  /** "<METHOD> <route template>" — the classified action, never a raw URL. */
  action: string;
  /** C4 money · C5 platform. Nothing else reaches this queue. */
  cls: string;
  capability: string;
  entityId: string | null;
  fingerprint: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'APPLIED' | 'EXPIRED';
  requestedBy: string;
  /** The requester's stated reason — the thing the approver is here to read. */
  reason: string;
  /** [DS110-13] The canonical `{ params, body, query }` of the reviewed
   *  request. The approver reads THIS and apply replays THIS — one stored
   *  body. */
  bodySnapshot?: unknown;
  approvedBy: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
  appliedAt: string | null;
  expiresAt: string;
  createdAt: string;
  /** Server-computed: the approver raised this one themselves. */
  isOwnRequest?: boolean;
}

export type BlockReason = 'own-request' | 'expired' | 'already-decided' | null;

/**
 * Why this row cannot be decided, or null when it can.
 *
 * Order matters. "You raised this" is checked FIRST because it is the reason a
 * person most needs to understand: it is not a timing problem they can retry
 * past, it is the whole point of the control.
 */
export function blockedBecause(row: ApprovalRow, now = new Date()): BlockReason {
  if (row.isOwnRequest) return 'own-request';
  if (row.status !== 'PENDING') return 'already-decided';
  if (new Date(row.expiresAt).getTime() <= now.getTime()) return 'expired';
  return null;
}

export const BLOCK_COPY: Record<Exclude<BlockReason, null>, string> = {
  'own-request': 'You raised this. A money or platform action needs a second person — that is the control, not an obstacle.',
  expired: 'This request has expired. The requester has to ask again, so the reason is re-stated and re-read.',
  'already-decided': 'Already decided. An approval is single-use; re-deciding it would leave two answers on one record.',
};

export const decidable = (row: ApprovalRow, now = new Date()): boolean => blockedBecause(row, now) === null;

/** Minutes left before the request expires; negative once it has. */
export function minutesLeft(row: ApprovalRow, now = new Date()): number {
  return Math.round((new Date(row.expiresAt).getTime() - now.getTime()) / 60_000);
}

export type Urgency = 'expired' | 'soon' | 'ok';

/** A window closing inside 30 minutes is worth showing differently: the
 *  requester is blocked until someone looks, and an expiry means they start
 *  the whole ask again. */
export function urgencyOf(row: ApprovalRow, now = new Date()): Urgency {
  const m = minutesLeft(row, now);
  if (m <= 0) return 'expired';
  return m <= 30 ? 'soon' : 'ok';
}

export const CLASS_MEANING: Record<string, string> = {
  C4: 'Money — moves, forgives, or claims settlement of value',
  C5: 'Platform — pricing, config, algorithms, or broadcasts',
};

/**
 * "PUT /billing/agent-payments/:id/refund-flag" → a sentence.
 *
 * The stored `action` is a route template, which is precise and unreadable. An
 * approver deciding a money action should not have to parse an HTTP method to
 * know whether they are about to forgive a fee or publish a price.
 */
export function describeAction(action: string): string {
  const [method, route = ''] = action.split(' ');
  const parts = route.split('/').filter((p) => p && !p.startsWith(':'));
  const subject = parts.map(humanise).join(' → ') || 'an admin action';
  const verb =
    method === 'DELETE' ? 'Delete'
    : method === 'POST' ? 'Create or run'
    : method === 'PUT' || method === 'PATCH' ? 'Change'
    : 'Read';
  return `${verb}: ${subject}`;
}

function humanise(segment: string): string {
  return segment
    .replace(/[-_]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A short, stable label for the record this action names, when it names one. */
export function entityLabel(row: ApprovalRow): string | null {
  if (!row.entityId) return null;
  return row.entityId.length > 14 ? `${row.entityId.slice(0, 10)}…${row.entityId.slice(-4)}` : row.entityId;
}

/**
 * The fingerprint, shortened for display.
 *
 * It covers the method, route, params AND body that were reviewed, so an
 * approved settlement cannot be re-aimed at a different beneficiary or amount
 * afterwards. Showing it is not decoration: it is the approver's proof that
 * what they are signing is what will happen.
 */
export const shortFingerprint = (fp: string): string => (fp.length > 16 ? `${fp.slice(0, 16)}…` : fp);

/**
 * A decision needs a stated reason — for BOTH answers.
 *
 * Deciding an approval is itself a classified action: `POST
 * /approvals/:id/decide` is C3, and C3 requires a reason (ADM-006). The server
 * reads it from a `reason` field or the reason header and returns 400 without
 * one, so a decision note is NOT optional even when approving — an earlier
 * draft of this screen treated it as optional and every button would have
 * failed at the wire.
 *
 * Which is the right rule anyway. "Approved" with nothing attached tells the
 * next person reading the record that a second admin clicked a button, not
 * that a second admin agreed.
 */
export const NOTE_MAX = 500;
// [DS110-14] Deciding is itself C3: the server floor is the same 12
// characters as every other consequential action, not 5 — a 5-character note
// passed the screen's check and 400'd at the gate.
export const NOTE_MIN = 12;

export function noteProblem(note: string, approve: boolean): string | null {
  if (note.length > NOTE_MAX) return `Keep the note under ${NOTE_MAX} characters.`;
  if (note.trim().length < NOTE_MIN) {
    return approve
      ? 'Say why you agree. The record keeps this, and "approved" on its own does not show that anyone checked.'
      : 'Say why you are refusing. The requester sees only this, and "no" without a reason means they ask again identically.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// [DS110-13] What the second admin is actually reading — the stored body.
//
// The fingerprint binds the stored body to the reviewed one; `bodySnapshot`
// is that body. The card renders its fields (amount, beneficiary, reference,
// …) so the approver sees exactly what they are signing — not an opaque id —
// and apply replays the same stored value, so what executes is what was
// displayed.
// ---------------------------------------------------------------------------

export interface SnapshotEntry {
  label: string;
  value: string;
}

/** The stored body's fields, keyed by a human label, with the reason left out
 *  (it is already the largest thing on the card). Empty for legacy rows. */
export function snapshotEntries(row: ApprovalRow): SnapshotEntry[] {
  const snapshot = row.bodySnapshot as { body?: Record<string, unknown> } | null | undefined;
  const body = snapshot?.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  return Object.entries(body)
    .filter(([key]) => key !== 'reason')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ({ label: humanise(key), value: formatSnapshotValue(value) }));
}

function formatSnapshotValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** May this row be executed now? APPROVED, unexpired, and with a body on
 *  record — a row raised before the snapshot existed has no body to replay. */
export function canApply(row: ApprovalRow, now = new Date()): boolean {
  if (row.status !== 'APPROVED') return false;
  if (new Date(row.expiresAt).getTime() <= now.getTime()) return false;
  return !!row.bodySnapshot;
}
