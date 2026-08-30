/**
 * [ALG-12 / FMC §12.2] The customer's ETA promise, as the screens read it.
 *
 * The server owns the promise and its range; the client renders it and does
 * three honest things with the clock (recomputed from Date.now() on every
 * tick, never decremented):
 *   R-12.2.1  a RANGE, never "arriving at 7:42";
 *   R-12.2.4  once the window has passed, never show it as still coming —
 *             say it is running later than promised;
 *   L7        a countdown reads the promise, never the live ETA — the live
 *             line is labelled as live, the promise line is the commitment.
 */

export interface PromiseView {
  at: string;
  windowStart: string;
  windowEnd: string;
  revisedAt: string | null;
  revisionReason: string | null;
  revisions: number;
}

export type PromiseLine =
  | { kind: 'window'; label: string; start: Date; end: Date }
  | { kind: 'passed'; label: string; end: Date };

const parse = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

function clock(d: Date): string {
  try {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

/** "7:40–7:55 PM" — the range as a person reads it. */
export function rangeLabel(start: Date, end: Date): string {
  const a = clock(start);
  const b = clock(end);
  // Drop a shared AM/PM suffix from the first half so it reads as one span.
  const suffix = /\s?([AP]M)$/i.exec(b)?.[1];
  const aTrim = suffix && a.toUpperCase().endsWith(suffix.toUpperCase()) ? a.replace(/\s?[AP]M$/i, '') : a;
  return `${aTrim}–${b}`;
}

/** What the screen shows for the promise right now. Null when the server sent nothing usable — never invented. */
export function promiseLine(p: PromiseView | null | undefined, nowMs: number): PromiseLine | null {
  const start = parse(p?.windowStart);
  const end = parse(p?.windowEnd);
  if (!start || !end || end.getTime() < start.getTime()) return null;
  if (nowMs > end.getTime()) {
    return { kind: 'passed', label: 'Running later than promised — arriving shortly', end };
  }
  return { kind: 'window', label: `Arriving ${rangeLabel(start, end)}`, start, end };
}

/** The quiet note under the range when the promise has moved — the server's reason, verbatim. */
export function promiseNote(p: PromiseView | null | undefined): string | null {
  if (!p || !(p.revisions > 0)) return null;
  return p.revisionReason ? `Updated — ${p.revisionReason}` : 'Updated';
}
