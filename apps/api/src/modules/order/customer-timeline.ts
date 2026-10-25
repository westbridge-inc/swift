import { HANDED_TO_RIDER_NOTE } from './store-handover-log';

/**
 * [O-2 · REVIEW-F S3-2 on #2055] The position evidence the server appends to a mover's step note
 * (" — gps:…", " — no GPS fix on file", the stale/not-geocoded variants all start with one of the
 * two). It is the rider's position, kept for support and appeals; the customer's timeline never
 * shows it.
 */
const POSITION_EVIDENCE_SUFFIX = / — (?:gps:-?\d|no GPS fix on file)[\s\S]*$/;

/** [REVIEW-F S4-2 on #2055] A step note as a customer or passenger reads it: the position evidence cut. */
export function withoutPositionEvidence(note: string | null): string | null {
  return note ? note.replace(POSITION_EVIDENCE_SUFFIX, '') : note;
}

/** The customer's view of the order's status log:
 *  - the store's "Handed to rider" row is left out: it carries the order's status at the tap, so it
 *    would read as a second "Rider assigned" / "Ready" step;
 *  - a step's position evidence is cut from its note. */
export function customerTimeline(
  rows: ReadonlyArray<{ status: string; note: string | null; createdAt: Date }>,
): Array<{ status: string; note: string | null; timestamp: Date }> {
  return rows
    .filter((row) => row.note !== HANDED_TO_RIDER_NOTE)
    .map((row) => ({ status: row.status, note: withoutPositionEvidence(row.note), timestamp: row.createdAt }));
}
