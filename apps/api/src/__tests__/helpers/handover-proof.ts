/**
 * [SAFE-B] Real handover evidence for cash-outcome fixtures.
 *
 * A failed cash handover earns a strike, an auto-approval or a payout only on
 * evidence the SERVER holds: a photo proof minted by the server's own issuer
 * (bound to the order, tenant, customer and the assigned mover), and a fresh
 * device fix persisted under the mover's own auth session. Typed GPS and an
 * arbitrary photo URL are declarations; they never complete a bundle.
 *
 * These helpers build that evidence the way production does. The fix is the
 * row the location route writes (owned by the session that sent it, fresh at
 * filing). The photo goes through `issueHandoverPhoto`, the issuer both upload
 * routes call. Storage is synthetic: no bytes leave the process.
 *
 * Retained history: the issued proof, the filing and its claim are immutable,
 * lineage-bound evidence and are never deleted by a suite. Build every fixture
 * so that a database which keeps them stays correct for the next run.
 */
import { nanoid } from 'nanoid';
import type { PrismaClient } from '@prisma/client';
import { issueHandoverPhoto } from '../../modules/cash/handover-evidence';
import type { StorageProvider } from '../../providers/storage/storage-provider';

/** A PNG signature followed by synthetic bytes: it passes the issuer's magic-byte and size checks. */
export const SYNTHETIC_HANDOVER_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

/** Synthetic storage: a unique object key per upload, nothing written anywhere. The issuer uses only `upload`. */
export const syntheticProofStorage = {
  upload: async (input: { folder: string }) => ({ url: `storage://synthetic/${input.folder}/${nanoid(12)}.png` }),
} as unknown as StorageProvider;

/** The server issuer, exactly as `/orders/:id/handover-photo`, `/rides/:id/handover-photo` and the courier `/proof-photo` call it. */
export function issueSyntheticHandoverPhoto(
  prisma: PrismaClient,
  input: { orderId: string; actorId: string; role: 'RIDER' | 'DRIVER' },
): Promise<{ url: string; proofId: string }> {
  return issueHandoverPhoto(prisma, syntheticProofStorage, {
    ...input,
    buffer: SYNTHETIC_HANDOVER_PNG,
    mimeType: 'image/png',
  });
}

/** What the location route persists for a mover: a fix owned by its auth session, `ageMs` old. */
export async function persistSessionFix(
  prisma: PrismaClient,
  mover: { riderId: string } | { driverId: string },
  sessionId: string,
  at: { lat: number; lng: number },
  ageMs = 0,
): Promise<void> {
  const data = { currentLat: at.lat, currentLng: at.lng, lastLocationUpdate: new Date(Date.now() - ageMs), locationSessionId: sessionId };
  if ('riderId' in mover) await prisma.rider.update({ where: { id: mover.riderId }, data });
  else await prisma.driver.update({ where: { id: mover.driverId }, data });
}

/** A live auth session for a user that has none of its own (a service-level fixture). */
export async function syntheticMoverSession(prisma: PrismaClient, userId: string, label: string): Promise<string> {
  const session = await prisma.session.create({
    data: {
      userId, token: `${label}-${nanoid(24)}`, refreshToken: nanoid(48),
      deviceId: label, deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return session.id;
}
