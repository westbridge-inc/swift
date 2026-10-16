import type { FastifyInstance } from 'fastify';
import { Prisma, type UserStatus } from '@prisma/client';
import { requireStepUp } from '../auth/step-up';
import { AppError } from '../../utils/errors';
import { isAdminAccount, sendAdminEmailChangeNotice } from '../admin/admin-email-change';

type ProfileUpdate = { firstName?: string; lastName?: string; email?: string };
const INACTIVE: readonly UserStatus[] = ['DEACTIVATED', 'BANNED', 'SUSPENDED'];
const PROFILE_SELECT = {
  id: true, phone: true, firstName: true, lastName: true,
  email: true, avatar: true, activeRole: true, lastMoverRole: true, updatedAt: true,
} as const;

/**
 * PUT /customer/profile.
 *
 * Same module and signature as the confirmed-email-change work held for build
 * 10 (#1550, which asks EVERY account for a code once the apps can show the
 * prompt). This is the part that cannot wait for build 10, for ADMIN accounts
 * only [OWNER #13 · Opus money review S2]: solo approval warns the owner at
 * the account's email, so a session alone must never move it —
 *
 *   - an admin account's email change takes a fresh sign-in code, spent by it;
 *   - the OLD address is told first: a notice that cannot go refuses the
 *     change (nothing is written; no provider is called while a row is held);
 *   - every email change, on any account, is dated (users.emailChangedAt):
 *     solo approval stays off for seven days after one.
 *
 * The app re-sends the same address on every name edit; that is not a change.
 * Customers are unchanged until #1550: no code, no notice.
 */
export async function updateCustomerProfile(app: FastifyInstance, userId: string, sessionId: string | null, body: ProfileUpdate) {
  if (body.email) {
    const existing = await app.prisma.user.findFirst({ where: { email: body.email, id: { not: userId } }, select: { id: true } });
    if (existing) throw emailTaken();
  }

  const previous = body.email !== undefined
    ? await app.prisma.user.findUnique({ where: { id: userId }, select: { email: true, roles: true, activeRole: true } })
    : null;
  const emailChanged = previous !== null && body.email !== previous.email;
  const changedAt = new Date();
  if (previous && emailChanged && isAdminAccount(previous)) {
    // Cheap refusals first (above); then the code, then the old address.
    await requireStepUp(app, { user: { userId }, authSessionId: sessionId }, { consume: true });
    if (previous.email) await sendAdminEmailChangeNotice(previous.email, body.email!, changedAt);
  }

  // [REPORT-022 F-022-21] conditional write: a deletion that finished between
  // auth and here cannot be re-personalised. When an email is sent, the write
  // is also conditional on the address read above: an address that moved in
  // between was never the one the code and the notice were for.
  const updated = await app.prisma.user.updateMany({
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
  return app.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: PROFILE_SELECT });
}

function emailTaken(): AppError {
  return new AppError(409, 'EMAIL_TAKEN', 'This email is already in use by another account');
}
