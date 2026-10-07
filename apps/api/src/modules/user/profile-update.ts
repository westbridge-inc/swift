import type { FastifyInstance } from 'fastify';
import { Prisma, type UserStatus } from '@prisma/client';
import { requireStepUp } from '../auth/step-up';
import { AppError } from '../../utils/errors';
import { getChannels } from '../../providers/notifications/channels';
import { smsDestinationAllowed } from '../../utils/sms-budget';
import { withTimeout } from '../../utils/async-lifecycle';
import { notificationFailuresCounter } from '../../plugins/observability';
import { NotificationService } from '../notification/notification.service';

type ProfileUpdate = { firstName?: string; lastName?: string; email?: string };
const inactive: ReadonlySet<UserStatus> = new Set(['DEACTIVATED', 'BANNED', 'SUSPENDED']);
const title = 'Your email address was changed';
const message = "Your Swift account email address was just changed. If this wasn't you, contact Swift support now.";

/** The previous contacts and the durable inbox notice belong to the same
 * committed change. No external provider is called while account locks are held. */
export async function updateCustomerProfile(app: FastifyInstance, userId: string, sessionId: string | null, body: ProfileUpdate) {
  const changed = await app.prisma.$transaction(async (tx) => {
    const [previous] = await tx.$queryRaw<Array<{ email: string | null; phone: string; isPhoneVerified: boolean; status: UserStatus }>>`
      SELECT "email", "phone", "isPhoneVerified", "status" FROM "users" WHERE "id" = ${userId} FOR UPDATE
    `;
    if (!previous || inactive.has(previous.status)) throw new AppError(409, 'ACCOUNT_INACTIVE', 'This account is not active.');
    const emailChanged = body.email !== undefined && body.email !== previous.email;
    if (emailChanged) {
      // Authentication may precede a logout/reset. Recheck its exact session
      // under the same User -> Session lock order as credential changes.
      const [session] = await tx.$queryRaw<Array<{ expiresAt: Date }>>`
        SELECT "expiresAt" FROM "sessions" WHERE "id" = ${sessionId} AND "userId" = ${userId} FOR UPDATE
      `;
      if (!session || session.expiresAt <= new Date()) throw new AppError(401, 'UNAUTHORIZED', 'This device session is no longer active');
      await requireStepUp(app, { user: { userId }, authSessionId: sessionId }, { consume: true });
    }
    const user = await tx.user.update({
      where: { id: userId }, data: body,
      select: { id: true, phone: true, firstName: true, lastName: true, email: true, avatar: true, activeRole: true, lastMoverRole: true, updatedAt: true },
    });
    const notice = emailChanged ? await tx.notification.create({ data: {
      userId, type: 'SYSTEM_ANNOUNCEMENT', title, body: message, data: { kind: 'email_changed' },
    }, select: { id: true } }) : null;
    return { user, previous, notice };
  }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
      && Array.isArray(error.meta?.['target']) && error.meta['target'].includes('email')) {
      throw new AppError(409, 'EMAIL_TAKEN', 'This email is already in use by another account');
    }
    throw error;
  });

  if (changed.notice) {
    const channels = getChannels();
    // External delivery is bounded and best-effort, like password notices.
    // Its failure never reports a committed profile change as a failed write.
    // The inbox fact is atomic with the update and survives delivery failures.
    const attempts: Array<{ channel: string; send: () => Promise<unknown> }> = [{
      channel: 'fanout', send: () => new NotificationService(app.prisma, app.io).publishPersisted(changed.notice!.id),
    }];
    if (changed.previous.email) attempts.push({ channel: 'email', send: () => channels.email.sendEmail(changed.previous.email!, title, message) });
    if (changed.previous.isPhoneVerified && smsDestinationAllowed(changed.previous.phone)) {
      attempts.push({ channel: 'sms', send: () => channels.sms.sendSms(changed.previous.phone, message) });
    }
    await Promise.all(attempts.map(async ({ channel, send }) => {
      try { await withTimeout(Promise.resolve().then(send), 3_000, 'Email-change notice'); }
      catch {
        // Provider errors may contain contact details: record only the channel.
        app.log.error({ userId, channel }, 'Email-change notice delivery failed');
        notificationFailuresCounter.inc({ channel, stage: 'email_change' });
      }
    }));
  }
  return changed.user;
}
