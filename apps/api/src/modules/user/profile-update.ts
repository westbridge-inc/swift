import type { FastifyInstance } from 'fastify';
import { Prisma, type UserStatus } from '@prisma/client';
import { requireStepUp } from '../auth/step-up';
import { AppError } from '../../utils/errors';
import { isAdminAccount, sendAdminEmailChangeNotice } from '../admin/admin-email-change';
import { insertNoticeFor } from '../../lib/owner-wall-notices';
import { getChannels } from '../../providers/notifications/channels';
import { smsDestinationAllowed } from '../../utils/sms-budget';
import { withTimeout } from '../../utils/async-lifecycle';
import { notificationFailuresCounter } from '../../plugins/observability';
import { NotificationService } from '../notification/notification.service';

type ProfileUpdate = { firstName?: string; lastName?: string; email?: string };
const INACTIVE: readonly UserStatus[] = ['DEACTIVATED', 'BANNED', 'SUSPENDED'];
const PROFILE_SELECT = {
  id: true, phone: true, firstName: true, lastName: true,
  email: true, avatar: true, activeRole: true, lastMoverRole: true, updatedAt: true,
} as const;

/**
 * PUT /customer/profile.
 *
 * [OWNER #13 · Opus money review S2 · L04 #1550] An account's email is where
 * receipts, notices and (for an admin) solo-approval warnings go, and a second
 * sign-in identifier. A session alone (stolen, or left signed in) must never
 * move it, on ANY account:
 *
 *   - a real email change takes a fresh sign-in code, spent by it;
 *   - an ADMIN account's OLD address is told first: a notice that cannot go
 *     refuses the change (nothing is written; no provider is called while a
 *     row is held);
 *   - every change leaves an inbox notice written with it ("If this wasn't
 *     you, contact Swift support"), pushed after commit, and a bounded,
 *     best-effort text to the phone and note to the old address;
 *   - every email change is dated (users.emailChangedAt): solo approval stays
 *     off for seven days after one.
 *
 * The app re-sends the same address on every name edit; that is not a change.
 */
export async function updateCustomerProfile(app: FastifyInstance, userId: string, sessionId: string | null, body: ProfileUpdate) {
  if (body.email) {
    const existing = await app.prisma.user.findFirst({ where: { email: body.email, id: { not: userId } }, select: { id: true } });
    if (existing) throw emailTaken();
  }

  const previous = body.email !== undefined
    ? await app.prisma.user.findUnique({ where: { id: userId }, select: { email: true, roles: true, activeRole: true, phone: true } })
    : null;
  const emailChanged = previous !== null && body.email !== previous.email;
  const admin = previous !== null && isAdminAccount(previous);
  const changedAt = new Date();
  if (previous && emailChanged) {
    // Cheap refusals first (above); then the code, then (admins) the old address.
    await requireStepUp(app, { user: { userId }, authSessionId: sessionId }, { consume: true });
    if (admin && previous.email) await sendAdminEmailChangeNotice(previous.email, body.email!, changedAt);
  }

  // [REPORT-022 F-022-21] conditional write: a deletion that finished between
  // auth and here cannot be re-personalised. When an email is sent, the write
  // is also conditional on the address read above: an address that moved in
  // between was never the one the code and the notice were for.
  // The inbox notice commits with the change: a changed address always leaves one.
  const { updated, noticeId } = await app.prisma.$transaction(async (tx) => {
    const written = await tx.user.updateMany({
      where: {
        id: userId, status: { notIn: [...INACTIVE] },
        ...(previous !== null && { email: previous.email }),
      },
      data: {
        ...(body.firstName !== undefined && { firstName: body.firstName }),
        ...(body.lastName !== undefined && { lastName: body.lastName }),
        ...(body.email !== undefined && { email: body.email }),
        ...(emailChanged && { emailChangedAt: changedAt }),
      },
    });
    const notice = written.count > 0 && emailChanged
      ? await insertNoticeFor(tx, { userId, type: 'SYSTEM_ANNOUNCEMENT', title: EMAIL_CHANGED_TITLE, body: EMAIL_CHANGED_BODY, data: { kind: 'email_changed' } })
      : null;
    return { updated: written, noticeId: notice?.id ?? null };
  }).catch((error: unknown) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw emailTaken();
    throw error;
  });
  if (updated.count === 0) {
    const now = await app.prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
    if (previous !== null && now && !INACTIVE.includes(now.status)) {
      throw new AppError(409, 'EMAIL_CHANGED_MEANWHILE', 'Your email was changed from somewhere else at the same moment. Reload and check it.');
    }
    throw new AppError(409, 'ACCOUNT_INACTIVE', 'This account is not active.');
  }
  if (noticeId && previous) await tellOfEmailChange(app, userId, noticeId, { phone: previous.phone, oldEmail: admin ? null : previous.email });
  return app.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: PROFILE_SELECT });
}

const EMAIL_CHANGED_TITLE = 'Your email address was changed';
const EMAIL_CHANGED_BODY = "Your Swift account email address was just changed. If this wasn't you, contact Swift support now.";

/**
 * After the change commits: push the inbox notice, text the phone on the
 * account, and (customers; an admin's old address was already told, strictly)
 * note the old address. Bounded and best-effort: a provider failure never
 * reports a committed change as failed, and the inbox notice already holds.
 */
async function tellOfEmailChange(app: FastifyInstance, userId: string, noticeId: string, to: { phone: string; oldEmail: string | null }): Promise<void> {
  // Channels are resolved inside each attempt: a provider that cannot even be
  // built (a mailbox with no host) is one failed attempt, not a failed request.
  const attempts: Array<{ channel: string; send: () => Promise<unknown> }> = [
    { channel: 'fanout', send: () => new NotificationService(app.prisma, app.io).publishPersisted(noticeId) },
  ];
  // The launch-market destination gate every other text passes.
  if (smsDestinationAllowed(to.phone)) attempts.push({ channel: 'sms', send: () => getChannels().sms.sendSms(to.phone, EMAIL_CHANGED_BODY) });
  if (to.oldEmail) {
    const oldEmail = to.oldEmail;
    attempts.push({ channel: 'email', send: () => getChannels().email.sendEmail(oldEmail, EMAIL_CHANGED_TITLE, EMAIL_CHANGED_BODY) });
  }
  await Promise.all(attempts.map(async ({ channel, send }) => {
    try {
      await withTimeout(Promise.resolve().then(send), 3_000, 'Email-change notice');
    } catch {
      // Provider errors can carry contact details: record only the channel.
      app.log.error({ userId, channel }, 'Email-change notice delivery failed');
      notificationFailuresCounter.inc({ channel, stage: 'email_change' });
    }
  }));
}

function emailTaken(): AppError {
  return new AppError(409, 'EMAIL_TAKEN', 'This email is already in use by another account');
}
