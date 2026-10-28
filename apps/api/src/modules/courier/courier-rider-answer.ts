import { withCounterpartPhones } from '../calls/counterpart-phone';
import { HANDOVER_SECRETS_OMIT } from '../handover/handover-security';

type Headers = Record<string, string | string[] | undefined>;

/**
 * [F20 · 28 Oct 2026] THE shape of every answer the assigned courier rider gets
 * from a custody step (pickup proof, delivery proof, return, return proof).
 *
 * - The parcel recipient's number the sender typed (courierRecipientPhone) and
 *   any party phone follow the O-1 counterpart-phone rule (withCounterpartPhones):
 *   with the call bridge on, a bridge-aware client, and every client once old
 *   apps are retired, is sent none; with the bridge off, nothing changes.
 * - Never a handover code or the MMG destination snapshot, whatever row the
 *   caller holds (a lost-answer retry inside the cash rail answers the row it
 *   read, not the canonical transition's stripped one).
 * - The sender appears as id + first name only: the rider's app reads neither
 *   the sender's account facts nor their number from these answers.
 *
 * Builds 9-12 read only `claim.status` from the proof answer and nothing from
 * the other three (ActiveJobScreen onSuccess handlers), so no field they read
 * goes away.
 */
export function courierRiderAnswer<T extends object>(request: { headers: Headers }, row: T): T {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const key of Object.keys(HANDOVER_SECRETS_OMIT)) delete out[key];
  const sender = out['customer'];
  if (sender && typeof sender === 'object') {
    const s = sender as { id?: unknown; firstName?: unknown };
    out['customer'] = { id: s.id ?? null, firstName: s.firstName ?? null };
  }
  return withCounterpartPhones(request, out as T);
}
