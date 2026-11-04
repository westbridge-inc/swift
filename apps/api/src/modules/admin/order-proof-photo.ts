import type { PrismaClient } from '@prisma/client';
import { assertClearOfParties } from '../integrity/party-authority';
import { requireIdentityAuthority } from '../integrity/identity-review';
import { documentScanState, evidenceObjectKey, uploadScanRefusal } from '../../lib/upload-scan-debt';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { lockTaxiOrderForCustodyDecision } from '../rides/passenger-custody';
import { AppError, NotFoundError } from '../../utils/errors';
import { assertReason } from './order-contact';

// ---------------------------------------------------------------------------
// [BUG-HUNT-2 G11] One proof photo for support. A photo is stored as an opaque key, never a public link, so the only way
// to see it is a short signed link minted here: a stated reason, the people on the order refused, a photo the scanner has
// not cleared never served, and the read recorded before the link exists. The audit row names the photo, not its key.
// ---------------------------------------------------------------------------

export const PROOF_PHOTO_NAMES = ['pickup', 'door', 'return'] as const;
export type ProofPhotoName = (typeof PROOF_PHOTO_NAMES)[number];

const LINK_SECONDS = 300;

export async function openProofPhoto(
  deps: { prisma: PrismaClient },
  input: { orderId: string; photo: ProofPhotoName; actorId: string; reason: string | null; ip: string | undefined; userAgent: string | undefined },
): Promise<{ url: string; expiresInSeconds: number; auditId: string }> {
  const reason = assertReason(input.reason, 'this photo');
  const { key, auditId } = await deps.prisma.$transaction(async (tx) => {
    await lockTaxiOrderForCustodyDecision(tx, input.orderId);
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      select: {
        id: true, orderNumber: true, customerId: true,
        courierPickupProofPhotoUrl: true, courierProofPhotoUrl: true, courierReturnProofPhotoUrl: true,
        rider: { select: { userId: true } }, driver: { select: { userId: true } },
      },
    });
    if (!order) throw new NotFoundError('Order', input.orderId);
    await requireIdentityAuthority(tx, input.actorId);
    await assertClearOfParties(tx, input.actorId, [order.customerId, ...(order.rider ? [order.rider.userId] : []), ...(order.driver ? [order.driver.userId] : [])], {
      own: new AppError(403, 'OWN_ORDER', 'You are on this order. Someone else at Swift must open its photo.'),
      staff: new AppError(403, 'STAFF_ON_ORDER', 'A staff account is on this order. Only a SUPER_ADMIN who is not on it can open its photo.'),
    });
    const stored = { pickup: order.courierPickupProofPhotoUrl, door: order.courierProofPhotoUrl, return: order.courierReturnProofPhotoUrl }[input.photo];
    if (!stored) throw new AppError(404, 'NO_PROOF_PHOTO', 'This order has no such photo.');
    const refusal = uploadScanRefusal(await documentScanState(tx, stored));
    if (refusal) throw refusal;
    // Evidence the scanner could not read is held; once clean its bytes move, and the order keeps the key it was issued.
    const objectKey = await evidenceObjectKey(tx, stored);
    if (!objectKey) throw new AppError(409, 'PROOF_PHOTO_HELD', 'This photo is held until the malware scan clears it.');
    const row = await tx.auditLog.create({
      data: {
        userId: input.actorId, action: 'VIEW_PROOF_PHOTO', entity: 'Order', entityId: order.id,
        changes: { reason, photo: input.photo, orderNumber: order.orderNumber, linkSeconds: LINK_SECONDS },
        ipAddress: input.ip ?? null, userAgent: input.userAgent ?? null,
      },
    });
    return { key: objectKey, auditId: row.id };
  });
  return { url: await getStorageProvider().getSignedUrl(key, LINK_SECONDS), expiresInSeconds: LINK_SECONDS, auditId };
}
