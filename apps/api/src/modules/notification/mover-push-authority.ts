import type { Prisma } from '@prisma/client';
import { AppError } from '../../utils/errors';

/** Called under the mover User lock. Preferences and a live registration are
 * checked at GO's commit boundary; the token lock serializes deactivation.
 * Uses build 9's existing registration, without a new request field. */
export async function assertMoverPushReady(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { notificationPrefs: true } });
  const prefs = user.notificationPrefs as { push?: boolean } | null;
  const registrations = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM device_tokens WHERE "userId" = ${userId} AND "isActive" = true FOR SHARE`;
  if (prefs?.push === false || registrations.length === 0) {
    throw new AppError(403, 'PUSH_REQUIRED', 'Enable push notifications and reopen Swift before going online.');
  }
}
