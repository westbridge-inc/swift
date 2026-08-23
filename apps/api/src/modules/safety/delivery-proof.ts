/**
 * [F-028-06] Did an SOS actually REACH anyone? The one honest answer.
 *
 * `SosAlert.deliveryReceipts` records what each fan-out channel did. Deciding
 * what counts as "help was reached" from that object has now produced two
 * S0-grade false positives in a row:
 *
 *   · F-027-16 — "the receipts object has ANY key" accepted a total failure
 *     ({opsPaged: 0, socketListeners: 0}) as proof of reach.
 *   · F-028-06 — the repaired oracle judged ARRAYS by length, but production
 *     writes one `{ok:false}` entry per FAILED emergency-contact SMS, so an
 *     all-failed contact list — every text bounced — still read as a
 *     successful channel. And `socketListeners` was judged like any count,
 *     though it measures room MEMBERSHIP: no shipped client (web, mobile,
 *     admin, or the desktop ops console — which polls REST and has no socket
 *     layer at all) has a handler for sos:active / sos:retrigger / incident:*,
 *     so a logged-in socket can sit in the room while the app discards the
 *     event.
 *
 * A proof oracle that is wrong twice in the same direction is not unlucky; it
 * is structured wrong. So the judgement now lives HERE, once, typed and
 * tested, and both the B14 baseline and anything ops-facing must import it
 * rather than re-deriving "seems delivered" locally.
 *
 * The rules, stated so the next reader can refute them:
 *   · numbers count when > 0 — EXCEPT `socketListeners`, which counts for
 *     nothing until a real consumer ships (registered follow-on: a socket
 *     client in the desktop war room). Membership is not delivery.
 *   · arrays count only if SOME entry succeeded (`ok === true`). Length is
 *     attempt count, not reach.
 *   · strings are reasons ("skipped:guardian-default"), never deliveries.
 *   · booleans pass through — a channel may legitimately record a plain fact.
 */

/** Receipt keys that are TELEMETRY, not evidence anyone was reached. */
const NON_EVIDENCE_KEYS = new Set(['socketListeners']);

function entrySucceeded(v: unknown): boolean {
  return typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === true;
}

export function channelDelivered(key: string, value: unknown): boolean {
  if (NON_EVIDENCE_KEYS.has(key)) return false;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.some(entrySucceeded);
  return false;
}

/**
 * True iff at least one channel is POSITIVE evidence a human surface received
 * the emergency: an ops notification row was written, a contact SMS actually
 * sent, or the alert produced persisted notices.
 */
export function sosReachedAnyone(
  receipts: Record<string, unknown> | null | undefined,
  noticeCount = 0,
): boolean {
  if (noticeCount > 0) return true;
  if (!receipts) return false;
  return Object.entries(receipts).some(([k, v]) => channelDelivered(k, v));
}
