import { bindTenantTransaction } from '../../plugins/prisma';
import { createHash } from 'node:crypto';
import type { Order, Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { ALLOWED_IMAGE_TYPES, looksLikeImage, stripImageMetadata } from '../../utils/images';
import type { StorageProvider } from '../../providers/storage/storage-provider';
import { NO_SHOW_EVIDENCE_MAX_AGE_MS, NO_SHOW_GRACE_MIN } from '../order/cancel-policy';
import { haversineDistance } from '../../utils/distance';

type Db = PrismaClient | Prisma.TransactionClient;
export const HANDOVER_POLICY_VERSION = 'cash-evidence-v1-taxi-wait-unresolved';
const CUSTODY: Record<string, readonly string[]> = {
  TAXI: ['RIDE_IN_PROGRESS'], COURIER: ['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED'],
  FOOD_DELIVERY: ['ARRIVED'], GROCERY_DELIVERY: ['ARRIVED'],
};

// Deliberately excludes mutable latest location and terminal status. The evidence
// freezes location at filing; a later device fix neither proves nor disproves it.
export function handoverBinding(order: Order): string {
  return createHash('sha256').update(JSON.stringify([
    order.id, order.tenantId, order.customerId, order.riderId, order.driverId,
    order.orderType, order.paymentMethod, order.courierPayer,
    order.deliveryLat, order.deliveryLng, order.pickupLat, order.pickupLng,
    String(order.subtotalBase), String(order.totalAmount), order.pickedUpAt, order.acceptedAt,
  ])).digest('hex');
}

export function assertFailureSource(order: Order, actor: { riderId: string | null; driverId: string | null }): void {
  if (order.riderId !== actor.riderId || order.driverId !== actor.driverId
      || !(CUSTODY[order.orderType] ?? []).includes(order.status)
      || order.paymentMethod !== 'CASH' || order.paymentStatus !== 'PENDING'
      || order.deliveredAt != null || (order.orderType === 'COURIER' && order.courierPayer !== 'RECIPIENT')) {
    throw new AppError(409, 'HANDOVER_AUTHORITY_CHANGED', 'The unpaid handover no longer matches this assignment.');
  }
}

/** Ownership before storage I/O; repeat under the order lock after upload. A lost
 * assignment/status race never returns an issued proof. Storage adapters strip
 * metadata; hash the same sanitized bytes, not a client-supplied digest. */
export async function issueHandoverPhoto(
  db: PrismaClient, storage: StorageProvider,
  input: { orderId: string; actorId: string; role: 'RIDER' | 'DRIVER'; buffer: Buffer; mimeType: string },
): Promise<{ url: string; proofId: string }> {
  const profile = input.role === 'DRIVER'
    ? await db.driver.findUnique({ where: { userId: input.actorId }, select: { id: true } })
    : await db.rider.findUnique({ where: { userId: input.actorId }, select: { id: true } });
  const order = profile ? await db.order.findFirst({ where: { id: input.orderId,
    ...(input.role === 'DRIVER' ? { driverId: profile.id, orderType: 'TAXI' } : { riderId: profile.id }) } }) : null;
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  if (!(CUSTODY[order.orderType] ?? []).includes(order.status)) {
    throw new AppError(409, 'NOT_AT_HANDOVER', 'Upload the photo at the handover.');
  }
  if (!ALLOWED_IMAGE_TYPES.has(input.mimeType) || !looksLikeImage(input.buffer)) {
    throw new AppError(400, 'BAD_IMAGE', 'Attach a JPEG, PNG or WebP photo.');
  }
  if (input.buffer.length > 10 * 1024 * 1024) throw new AppError(413, 'IMAGE_TOO_LARGE', 'Photo exceeds 10 MB.');
  const buffer = stripImageMetadata(input.buffer, input.mimeType);
  const bindingDigest = handoverBinding(order);
  const ext = input.mimeType === 'image/png' ? 'png' : input.mimeType === 'image/webp' ? 'webp' : 'jpg';
  const { url } = await storage.upload({ buffer, mimeType: input.mimeType, filename: `photo.${ext}`, folder: `handover-proof/${order.id}` });
  return db.$transaction(async (tx) => {
      await bindTenantTransaction(tx);
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE`;
    const current = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
    if (handoverBinding(current) !== bindingDigest || current.status !== order.status) {
      throw new AppError(409, 'HANDOVER_AUTHORITY_CHANGED', 'The assignment or handover changed during upload.');
    }
    const proof = await tx.handoverPhotoProof.create({ data: {
      tenantId: order.tenantId, orderId: order.id, customerId: order.customerId, actorId: input.actorId,
      riderId: order.riderId, driverId: order.driverId, purpose: 'HANDOVER', objectKey: url,
      contentHash: createHash('sha256').update(buffer).digest('hex'), mimeType: input.mimeType,
      byteSize: buffer.length, bindingDigest, sourceStatus: order.status,
    } });
    if (order.orderType === 'COURIER') {
      await tx.order.update({ where: { id: order.id }, data: { courierProofIssuedUrl: url, courierProofIssuedRiderId: order.riderId } });
    }
    return { url, proofId: proof.id };
  });
}

export async function captureHandoverEvidence(
  tx: Prisma.TransactionClient, order: Order,
  input: { actorId: string; sessionId?: string; outcome: 'no_show' | 'refused'; gps: { lat: number; lng: number }; photoUrl?: string },
  maxDistanceKm: number,
) {
  const filedAt = new Date();
  // Canonical transition already holds order then mover lock. Read the acting
  // profile, never whichever profile happens to exist on a dual-role account.
  const profile = order.orderType === 'TAXI'
    ? await tx.driver.findUnique({ where: { id: order.driverId! } })
    : await tx.rider.findUnique({ where: { id: order.riderId! } });
  if (!profile || profile.userId !== input.actorId) throw new AppError(409, 'ACTOR_NOT_ASSIGNED', 'Assignment changed.');
  const session = input.sessionId ? await tx.session.findFirst({
    where: { id: input.sessionId, userId: input.actorId, expiresAt: { gt: filedAt } }, select: { id: true },
  }) : null;
  const delivery = order.orderType === 'FOOD_DELIVERY' || order.orderType === 'GROCERY_DELIVERY';
  const arrival = delivery ? await tx.orderStatusLog.findFirst({
    where: { orderId: order.id, status: 'ARRIVED' }, orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true },
  }) : null;
  const proof = input.photoUrl ? await tx.handoverPhotoProof.findUnique({ where: { objectKey: input.photoUrl } }) : null;
  const validProof = proof && proof.tenantId === order.tenantId && proof.orderId === order.id
    && proof.customerId === order.customerId && proof.actorId === input.actorId
    && proof.riderId === order.riderId && proof.driverId === order.driverId
    && proof.purpose === 'HANDOVER' && (CUSTODY[order.orderType] ?? []).includes(proof.sourceStatus) && !proof.invalidatedAt && proof.issuedAt <= filedAt
    && proof.bindingDigest === handoverBinding(order);
  return tx.cashHandoverEvidence.create({ data: {
    tenantId: order.tenantId, orderId: order.id, customerId: order.customerId, actorId: input.actorId,
    riderId: order.riderId, driverId: order.driverId, orderType: order.orderType,
    outcome: input.outcome, sourceStatus: order.status, bindingDigest: handoverBinding(order), filedAt,
    locationLat: profile.currentLat, locationLng: profile.currentLng, locationAt: profile.lastLocationUpdate,
    locationSessionId: profile.locationSessionId, actorSessionId: session?.id ?? null,
    declaredLat: input.gps.lat, declaredLng: input.gps.lng,
    arrivalLogId: arrival?.id, arrivalAt: arrival?.createdAt,
    waitedMs: arrival ? filedAt.getTime() - arrival.createdAt.getTime() : null,
    photoProofId: validProof ? proof.id : null, policyVersion: HANDOVER_POLICY_VERSION,
    maxDistanceKm, maxLocationAgeMs: NO_SHOW_EVIDENCE_MAX_AGE_MS,
  } });
}

/** Both review and payout use these source records, never the claim JSON. */
export async function admittedHandoverEvidence(db: Db, order: Order, claim: {
  handoverEvidenceId?: string | null; riderId: string | null; driverId: string | null;
  customerId?: string; reason?: string;
}) {
  const evidence = claim.handoverEvidenceId
    ? await db.cashHandoverEvidence.findUnique({ where: { id: claim.handoverEvidenceId } }) : null;
  const actor = evidence ? (evidence.driverId
    ? await db.driver.findUnique({ where: { id: evidence.driverId }, select: { userId: true } })
    : await db.rider.findUnique({ where: { id: evidence.riderId! }, select: { userId: true } })) : null;
  const bound = actor?.userId === evidence?.actorId && !!evidence && !evidence.invalidatedAt && evidence.orderId === order.id
    && evidence.tenantId === order.tenantId && evidence.customerId === order.customerId
    && evidence.customerId === claim.customerId && evidence.riderId === claim.riderId
    && evidence.driverId === claim.driverId && evidence.outcome === claim.reason
    && evidence.orderType === order.orderType && evidence.bindingDigest === handoverBinding(order)
    && evidence.policyVersion === HANDOVER_POLICY_VERSION && evidence.filedAt <= new Date()
    && (CUSTODY[order.orderType] ?? []).includes(evidence.sourceStatus)
    && order.status === 'FAILED' && order.paymentStatus === 'FAILED' && order.deliveredAt == null
    && order.paymentMethod === 'CASH' && (order.orderType !== 'COURIER' || order.courierPayer === 'RECIPIENT');
  const fixAge = evidence?.locationAt ? evidence.filedAt.getTime() - evidence.locationAt.getTime() : null;
  const coords = evidence && [evidence.locationLat, evidence.locationLng, order.deliveryLat, order.deliveryLng];
  const finite = coords?.every((v) => v != null && Number.isFinite(v));
  const distanceKm = finite ? haversineDistance(evidence!.locationLat!, evidence!.locationLng!, order.deliveryLat, order.deliveryLng) : null;
  const location = bound && finite && Math.abs(evidence!.locationLat!) <= 90 && Math.abs(evidence!.locationLng!) <= 180
    && fixAge != null && fixAge >= 0 && fixAge <= evidence!.maxLocationAgeMs
    && evidence!.maxLocationAgeMs <= NO_SHOW_EVIDENCE_MAX_AGE_MS
    && !!evidence!.actorSessionId && evidence!.actorSessionId === evidence!.locationSessionId
    && distanceKm != null && distanceKm <= evidence!.maxDistanceKm;
  const proof = evidence?.photoProofId ? await db.handoverPhotoProof.findUnique({ where: { id: evidence.photoProofId } }) : null;
  const photo = bound && !!proof && !proof.invalidatedAt && proof.orderId === order.id
    && proof.tenantId === order.tenantId && proof.customerId === order.customerId
    && proof.actorId === evidence!.actorId && proof.riderId === order.riderId && proof.driverId === order.driverId
    && proof.purpose === 'HANDOVER' && (CUSTODY[order.orderType] ?? []).includes(proof.sourceStatus) && proof.bindingDigest === evidence!.bindingDigest
    && proof.issuedAt <= evidence!.filedAt;
  // Taxi destination wait semantics are an explicit owner policy gate. Pickup
  // arrival, estimated duration and device declarations cannot fill that gap.
  let wait = order.orderType !== 'TAXI';
  if (wait && order.orderType !== 'COURIER' && evidence?.outcome === 'no_show') {
    const arrival = evidence.arrivalLogId ? await db.orderStatusLog.findUnique({ where: { id: evidence.arrivalLogId } }) : null;
    wait = !!arrival && arrival.orderId === order.id && arrival.status === 'ARRIVED'
      && arrival.createdAt.getTime() === evidence.arrivalAt?.getTime()
      && evidence.waitedMs === evidence.filedAt.getTime() - arrival.createdAt.getTime()
      && evidence.waitedMs >= NO_SHOW_GRACE_MIN * 60_000;
  }
  return { bound, location: !!location, photo: !!photo, wait: bound && wait, evidence, distanceKm, fixAge };
}

/** The canonical courier delivery seam applies this to every payment rail and
 * alias, while holding the order lock. SHARE serializes invalidation. */
export async function admittedCourierPhoto(tx: Prisma.TransactionClient, source: Order, key: string | null): Promise<boolean> {
  if (!key || source.orderType !== 'COURIER' || !CUSTODY['COURIER']!.includes(source.status)) return false;
  await tx.$queryRaw`SELECT id FROM handover_photo_proofs WHERE "objectKey" = ${key} FOR SHARE`;
  const proof = await tx.handoverPhotoProof.findUnique({ where: { objectKey: key } });
  const actor = source.riderId ? await tx.rider.findUnique({ where: { id: source.riderId }, select: { userId: true } }) : null;
  return !!proof && !proof.invalidatedAt && proof.issuedAt <= new Date()
    && CUSTODY['COURIER']!.includes(proof.sourceStatus) && proof.purpose === 'HANDOVER'
    && proof.orderId === source.id && proof.tenantId === source.tenantId && proof.customerId === source.customerId
    && proof.riderId === source.riderId && proof.driverId === source.driverId && actor?.userId === proof.actorId
    && proof.bindingDigest === handoverBinding(source);
}
