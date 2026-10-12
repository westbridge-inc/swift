import type { Prisma } from '@prisma/client';
import { AppError } from '../../utils/errors';

/** [L07 · build-9 guardrail] The push-before-GO rule is a server switch, OFF
 * unless MOVER_PUSH_REQUIRED says exactly 'true'. A phone that was never asked
 * for notifications has no token, and on iOS no Settings switch to turn on, so
 * a refusal would lock out movers who tapped Not now, new or reinstalled
 * phones, ops-created accounts and the store reviewers' demo logins, with an
 * instruction they cannot follow (App Store guideline 4.5.4). Turning it on is
 * an owner decision, after a build that can prompt or open Settings is live in
 * both stores. */
export function moverPushRequired(env: Record<string, string | undefined> = process.env): boolean {
  return env['MOVER_PUSH_REQUIRED'] === 'true';
}

/** Called under the mover User lock. Preferences and a live registration are
 * checked at GO's commit boundary; the token lock serializes deactivation.
 * Uses build 9's existing registration, without a new request field. */
export async function assertMoverPushReady(
  tx: Prisma.TransactionClient,
  userId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  // Off: exactly the GO of today. No read, no lock, no refusal.
  if (!moverPushRequired(env)) return;
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { notificationPrefs: true } });
  const prefs = user.notificationPrefs as { push?: boolean } | null;
  const registrations = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM device_tokens WHERE "userId" = ${userId} AND "isActive" = true FOR SHARE`;
  if (prefs?.push === false || registrations.length === 0) {
    throw new AppError(403, 'PUSH_REQUIRED', 'Enable push notifications and reopen Swift before going online.');
  }
}
