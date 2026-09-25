import type { Prisma } from '@prisma/client';
import { gpsEvidence } from '../cash/cash-rules.service';

// ---------------------------------------------------------------------------
// [Q8 · DS269 F1] A moved store pin leaves a trace. PUT /vendor/profile lets a
// manager (or anyone holding a manager session) move the pin riders and
// customers are sent to. Without a record, a store could be relocated with no
// way to tell who moved it, from where, or when. So a move writes an audit row
// in the transaction that makes it, and when the mover is not the owner the
// owner is told, with a notice that commits with the move and is fanned out
// after it.
// ---------------------------------------------------------------------------

type Tx = Prisma.TransactionClient;

export const VENDOR_PIN_MOVED = 'VENDOR_PIN_MOVED';

/** The store row, locked for this write: the pin it holds now, its name and its owner. */
export async function lockStorePin(tx: Tx, vendorId: string) {
  await tx.$queryRaw`SELECT id FROM "vendors" WHERE id = ${vendorId} FOR UPDATE`;
  // Read under the lock, so the audit "from" is the pin this write replaces,
  // even when two moves race.
  return tx.vendor.findUniqueOrThrow({
    where: { id: vendorId },
    select: { name: true, latitude: true, longitude: true, owner: { select: { userId: true } } },
  });
}

export type LockedStorePin = Awaited<ReturnType<typeof lockStorePin>>;

/**
 * Record a pin move, inside the transaction that writes it. An unchanged pin
 * records nothing. The audit positions use the one evidence format for a
 * position (cash-rules gpsEvidence: 5 decimal places, about 1 m). A store pin
 * is published to every customer at full precision, so the trail exposes
 * nothing new. Returns the id of the owner notice to fan out after commit,
 * or null when the owner moved it themselves.
 */
export async function recordStorePinMove(
  tx: Tx,
  input: {
    vendorId: string;
    before: LockedStorePin;
    to: { latitude: number; longitude: number };
    actorUserId: string;
    actorRole: string;
  },
): Promise<string | null> {
  const { before, to } = input;
  if (before.latitude === to.latitude && before.longitude === to.longitude) return null;
  const ownerUserId = before.owner.userId;
  const ownerNotified = ownerUserId !== input.actorUserId;
  await tx.auditLog.create({
    data: {
      userId: input.actorUserId,
      action: VENDOR_PIN_MOVED,
      entity: 'Vendor',
      entityId: input.vendorId,
      changes: {
        from: gpsEvidence(before.latitude, before.longitude),
        to: gpsEvidence(to.latitude, to.longitude),
        actorRole: input.actorRole,
        ownerNotified,
      },
    },
  });
  if (!ownerNotified) return null;
  const actor = await tx.user.findUnique({ where: { id: input.actorUserId }, select: { firstName: true, lastName: true } });
  const who = [actor?.firstName, actor?.lastName].filter(Boolean).join(' ') || 'A manager on your team';
  const notice = await tx.notification.create({
    data: {
      userId: ownerUserId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Your store pin was moved',
      body: `${who} moved the map pin for ${before.name}. Riders and customers now go to the new spot. If that is wrong, open Account, Store location and move it back.`,
      data: { kind: 'store_pin_moved', vendorId: input.vendorId, audience: 'business' },
    },
    select: { id: true },
  });
  return notice.id;
}
