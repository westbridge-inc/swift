import type { PrismaClient, Prisma } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { isReviewAccount, refuseReviewAccountRoleGrant } from '../review/demo-policy';

// ---------------------------------------------------------------------------
// [Row 55] Store team invites.
//
// Adding a team member by phone used to answer "no Swift account" (404) for an
// unknown number and the person's name for a known one, and the member was
// added on the spot, so the team list showed their name and photo straight
// away. Typing any number told an owner whether it was a Swift user, and who.
//
// Now every number gets the same reply. With STAFF_INVITE_ACCEPT on, a known
// account receives an invite in its inbox and becomes a member only when it
// taps Accept; nothing pending is listed to the owner. With the switch off
// (the default, for the app build that has no Accept card) a known account is
// still added at once, as before, but the reply no longer differs.
//
// The invite IS its notification row: data.kind = 'staff_invite' with the
// store, role, inviter, expiry and a state that moves PENDING → ACCEPTED |
// DECLINED | CLOSED exactly once, under a row lock. No schema change.
// ---------------------------------------------------------------------------

export const STAFF_INVITE_KIND = 'staff_invite';
const STAFF_INVITE_REVOKED = 'STAFF_INVITE_REVOKED';
const STAFF_INVITES_WITHDRAWN = 'STAFF_INVITES_WITHDRAWN';
const grantKey = (vendorId: string, userId: string) => JSON.stringify([vendorId, userId]);
export const STAFF_INVITE_TTL_MS = 72 * 60 * 60 * 1000;

export type StaffInviteRole = 'MANAGER' | 'STAFF';
type InviteState = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CLOSED';

/** The launch switch. Off until the app build with the Accept card is live. */
export function staffInviteAcceptEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['STAFF_INVITE_ACCEPT'] === '1';
}

/** The one reply every add gets — known number, unknown number, already on
 *  the team, already invited. Nothing in it depends on the phone typed. */
export function staffAddReply(role: StaffInviteRole) {
  return {
    success: true as const,
    data: {
      status: 'SENT_IF_ACCOUNT' as const,
      role,
      message: 'If this number has a Swift account, they will get an invite to join your team.',
    },
  };
}

interface InviteData {
  kind: typeof STAFF_INVITE_KIND;
  vendorId: string;
  storeName: string;
  role: StaffInviteRole;
  invitedBy: string;
  expiresAt: string;
  state: InviteState;
  decidedAt?: string;
  audience?: string;
}

function readInvite(data: Prisma.JsonValue | null): InviteData | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d['kind'] !== STAFF_INVITE_KIND) return null;
  if (typeof d['vendorId'] !== 'string' || typeof d['invitedBy'] !== 'string' || typeof d['expiresAt'] !== 'string') return null;
  if (d['role'] !== 'MANAGER' && d['role'] !== 'STAFF') return null;
  return d as unknown as InviteData;
}

const inviteWhere = (userId: string, vendorId?: string): Prisma.NotificationWhereInput => ({
  userId,
  AND: [
    { data: { path: ['kind'], equals: STAFF_INVITE_KIND } },
    { data: { path: ['state'], equals: 'PENDING' } },
    ...(vendorId ? [{ data: { path: ['vendorId'], equals: vendorId } }] : []),
  ],
});

interface InviteSender {
  publishPersisted(notificationId: string): Promise<boolean>;
}

/** One grant lock is shared by issuance, answers and owner revocation. A
 * notification-row lock alone cannot serialize two different invite rows. */
export async function lockStaffInviteGrant(tx: Prisma.TransactionClient, vendorId: string, userId: string) {
  const key = JSON.stringify(['staff-invite-grant', vendorId, userId]);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/** A store-wide lock between invite delivery (shared) and the owner's
 * "withdraw every pending invite" (exclusive). Taken after the account locks
 * and before any grant lock, in that order everywhere. */
async function lockStaffInviteStore(tx: Prisma.TransactionClient, vendorId: string, mode: 'shared' | 'exclusive') {
  const key = JSON.stringify(['staff-invite-store', vendorId]);
  if (mode === 'shared') await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`;
  else await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/** Revocations live in the append-only audit trail. Capture this token on
 * the request path; a delayed delivery must still match it under the lock.
 * It counts removals of this person from this store AND the owner's
 * store-wide withdrawals, so neither can be outrun by a delivery already
 * requested. The same query runs for every number. */
export async function staffInviteRevocationVersion(prisma: Pick<Prisma.TransactionClient, 'auditLog'>, vendorId: string, userId: string) {
  // Count is monotonic under the grant and store locks even when transaction
  // timestamps or clocks differ. Audit rows are append-only and cannot disappear.
  return prisma.auditLog.count({
    where: { OR: [
      { action: STAFF_INVITE_REVOKED, entity: 'VendorStaffGrant', entityId: grantKey(vendorId, userId) },
      { action: STAFF_INVITES_WITHDRAWN, entity: 'VendorStaffInvites', entityId: vendorId },
    ] },
  });
}

/** Caller holds the grant lock; commit this marker with membership removal. */
export async function recordStaffInviteRevocation(tx: Prisma.TransactionClient, vendorId: string, userId: string, actorId: string) {
  await tx.auditLog.create({ data: {
    userId: actorId, action: STAFF_INVITE_REVOKED, entity: 'VendorStaffGrant', entityId: grantKey(vendorId, userId),
  } });
}

/** Account deletion takes the user row exclusively before its authority
 * cutoff. Hold shared locks in a stable order through the membership write. */
async function lockStaffInviteAccounts(tx: Prisma.TransactionClient, inviterId: string, userId: string) {
  await tx.$queryRaw`SELECT id FROM "users" WHERE id IN (${inviterId}, ${userId}) ORDER BY id FOR SHARE`;
}

/** Caller holds the grant lock. Close even legacy duplicates, including
 * expired rows, so no old invitation can outlive acceptance or revocation. */
export async function closePendingStaffInvites(
  tx: Prisma.TransactionClient, vendorId: string, userId: string, now: Date, exceptId?: string,
) {
  const rows = await tx.notification.findMany({
    where: inviteWhere(userId, vendorId), select: { id: true, data: true },
  });
  for (const row of rows) {
    if (row.id === exceptId) continue;
    await tx.notification.update({ where: { id: row.id }, data: {
      isRead: true, readAt: now,
      data: { ...(row.data as Record<string, unknown>), state: 'CLOSED', decidedAt: now.toISOString() },
    } });
  }
}

/**
 * Send one invite, unless the person is already on the team or already holds
 * a live invite from this store. Runs OFF the request path (the caller does
 * not await it), so a known number and an unknown one answer in the same time.
 */
export async function deliverStaffInvite(
  prisma: PrismaClient,
  sender: InviteSender,
  input: { vendorId: string; targetUserId: string; role: StaffInviteRole; inviterId: string; now: Date; revocationVersion: number },
): Promise<'SENT' | 'ALREADY_MEMBER' | 'ALREADY_INVITED' | 'NOT_INVITABLE'> {
  // [REVIEW-PARTNER] A demo account never receives a store membership invite.
  if (await isReviewAccount(prisma, input.targetUserId)) return 'NOT_INVITABLE';
  const committed = await prisma.$transaction(async (tx) => {
    await lockStaffInviteAccounts(tx, input.inviterId, input.targetUserId);
    await lockStaffInviteStore(tx, input.vendorId, 'shared');
    await lockStaffInviteGrant(tx, input.vendorId, input.targetUserId);
    if (await staffInviteRevocationVersion(tx, input.vendorId, input.targetUserId) !== input.revocationVersion) {
      return { result: 'NOT_INVITABLE' as const };
    }
    const vendor = await tx.vendor.findUnique({
      where: { id: input.vendorId },
      select: { name: true, suspensionSource: true, owner: { select: { userId: true, user: { select: { status: true } } } } },
    });
    const recipient = await tx.user.findUnique({ where: { id: input.targetUserId }, select: { status: true } });
    if (!vendor || vendor.owner.userId !== input.inviterId || vendor.owner.user.status !== 'ACTIVE'
      || vendor.suspensionSource === 'WIND_DOWN' || recipient?.status !== 'ACTIVE') {
      return { result: 'NOT_INVITABLE' as const };
    }
    const member = await tx.vendorStaff.findUnique({
      where: { vendorId_userId: { vendorId: input.vendorId, userId: input.targetUserId } },
      select: { id: true },
    });
    if (member) return { result: 'ALREADY_MEMBER' as const };
    const live = await tx.notification.findMany({
      where: inviteWhere(input.targetUserId, input.vendorId), select: { data: true },
    });
    if (live.some((n) => {
      const d = readInvite(n.data);
      return d !== null && new Date(d.expiresAt).getTime() > input.now.getTime();
    })) return { result: 'ALREADY_INVITED' as const };

    const roleWords = input.role === 'MANAGER' ? 'a manager' : 'staff';
    // The invite must be persisted by the SAME transaction holding the grant
    // lock; sender.send would write through a separate client and fan out early.
    const notification = await tx.notification.create({ data: {
      userId: input.targetUserId, type: 'SYSTEM_ANNOUNCEMENT', title: 'Team invite',
      body: `${vendor.name} invited you to join their team as ${roleWords}. Open your notifications to accept or decline.`,
      data: {
        kind: 'staff_invite', vendorId: input.vendorId, storeName: vendor.name,
        role: input.role, invitedBy: input.inviterId,
        expiresAt: new Date(input.now.getTime() + STAFF_INVITE_TTL_MS).toISOString(),
        state: 'PENDING', audience: 'customer',
      } satisfies InviteData,
    }, select: { id: true } });
    return { result: 'SENT' as const, notificationId: notification.id };
  });
  if ('notificationId' in committed && committed.notificationId) {
    await sender.publishPersisted(committed.notificationId);
  }
  return committed.result;
}

/** The caller's own live invites, newest first. */
export async function listMyStaffInvites(prisma: PrismaClient, userId: string, now: Date) {
  const rows = await prisma.notification.findMany({
    where: inviteWhere(userId),
    orderBy: { createdAt: 'desc' },
    select: { id: true, data: true, createdAt: true },
  });
  return rows.flatMap((row) => {
    const d = readInvite(row.data);
    if (!d || new Date(d.expiresAt).getTime() <= now.getTime()) return [];
    return [{ id: row.id, storeName: d.storeName, role: d.role, expiresAt: d.expiresAt, createdAt: row.createdAt }];
  });
}

/**
 * The owner takes back every unanswered invite from one store. Nothing pending
 * is ever listed to the owner (that would say which typed numbers are Swift
 * accounts), so an owner who typed a wrong digit withdraws them all at once,
 * and the caller answers the same however many there were.
 *
 * Under the store lock (exclusive) a delivery already in flight finishes first
 * and its invite is closed here; one requested earlier but not yet written is
 * refused afterwards, because the withdrawal is counted in the revocation
 * version it captured. Each person's invites close under their grant lock, the
 * same lock Accept holds, so Accept and the withdrawal have one winner.
 * Only invites young enough to be accepted are looked for (an expired one is
 * closed by Accept itself and grants nothing), which keeps the scan on the
 * notifications' createdAt index.
 */
export async function withdrawPendingStaffInvites(
  prisma: PrismaClient,
  input: { vendorId: string; actorId: string; now: Date },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockStaffInviteStore(tx, input.vendorId, 'exclusive');
    await tx.auditLog.create({ data: {
      userId: input.actorId, action: STAFF_INVITES_WITHDRAWN, entity: 'VendorStaffInvites', entityId: input.vendorId,
    } });
    const rows = await tx.notification.findMany({
      where: {
        createdAt: { gte: new Date(input.now.getTime() - STAFF_INVITE_TTL_MS - 60 * 60 * 1000) },
        AND: [
          { data: { path: ['kind'], equals: STAFF_INVITE_KIND } },
          { data: { path: ['state'], equals: 'PENDING' } },
          { data: { path: ['vendorId'], equals: input.vendorId } },
        ],
      },
      select: { userId: true },
    });
    for (const userId of [...new Set(rows.map((row) => row.userId))].sort()) {
      await lockStaffInviteGrant(tx, input.vendorId, userId);
      await closePendingStaffInvites(tx, input.vendorId, userId, input.now);
    }
  });
}

/**
 * Accept or decline one invite. The notification row is locked first, so a
 * double tap, or Accept racing Decline, has exactly one winner. Accepting
 * re-checks that the store still exists and that the person who invited is
 * still its owner; otherwise the invite is closed and nothing is granted.
 */
export async function decideStaffInvite(
  prisma: PrismaClient,
  input: { inviteId: string; userId: string; decision: 'ACCEPT' | 'DECLINE'; now: Date },
  sender?: InviteSender,
) {
  // [REVIEW-PARTNER] Accepting is a membership grant: never to a demo account.
  if (input.decision === 'ACCEPT') await refuseReviewAccountRoleGrant(prisma, input.userId);
  const candidate = await prisma.notification.findFirst({
    where: { id: input.inviteId, userId: input.userId }, select: { data: true },
  });
  const candidateInvite = candidate && readInvite(candidate.data);
  if (!candidateInvite) throw new NotFoundError('Invite', input.inviteId);
  const outcome = await prisma.$transaction(async (tx) => {
    await lockStaffInviteAccounts(tx, candidateInvite.invitedBy, input.userId);
    await lockStaffInviteGrant(tx, candidateInvite.vendorId, input.userId);
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "notifications" WHERE id = ${input.inviteId} AND "userId" = ${input.userId} FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundError('Invite', input.inviteId);
    const row = await tx.notification.findUniqueOrThrow({ where: { id: input.inviteId }, select: { data: true } });
    const invite = readInvite(row.data);
    if (!invite || invite.vendorId !== candidateInvite.vendorId || invite.invitedBy !== candidateInvite.invitedBy) throw new NotFoundError('Invite', input.inviteId);
    if (invite.state !== 'PENDING') {
      throw new AppError(409, 'INVITE_CLOSED', 'This invite has already been answered.');
    }
    const close = async (state: InviteState) => {
      await tx.notification.update({
        where: { id: input.inviteId },
        data: {
          isRead: true,
          readAt: input.now,
          data: { ...(row.data as Record<string, unknown>), state, decidedAt: input.now.toISOString() },
        },
      });
    };
    if (new Date(invite.expiresAt).getTime() <= input.now.getTime()) {
      await close('CLOSED');
      return { error: new AppError(410, 'INVITE_EXPIRED', 'This invite has expired. Ask the store owner to send a new one.') };
    }
    if (input.decision === 'DECLINE') {
      await close('DECLINED');
      return { decision: 'DECLINED' as const };
    }

    const vendor = await tx.vendor.findUnique({
      where: { id: invite.vendorId },
      select: { id: true, name: true, suspensionSource: true, owner: { select: { userId: true, user: { select: { status: true } } } } },
    });
    const recipient = await tx.user.findUnique({ where: { id: input.userId }, select: { status: true } });
    if (!vendor || vendor.owner.userId !== invite.invitedBy || vendor.owner.userId === input.userId
      || vendor.owner.user.status !== 'ACTIVE' || vendor.suspensionSource === 'WIND_DOWN'
      || recipient?.status !== 'ACTIVE') {
      await close('CLOSED');
      return { error: new AppError(409, 'INVITE_CLOSED', 'This invite is no longer valid.') };
    }
    const existing = await tx.vendorStaff.findUnique({
      where: { vendorId_userId: { vendorId: vendor.id, userId: input.userId } },
      select: { role: true },
    });
    let ownerNoticeId: string | undefined;
    if (!existing) {
      await tx.vendorStaff.create({
        data: { vendorId: vendor.id, userId: input.userId, role: invite.role, invitedBy: invite.invitedBy },
      });
      // The owner learns who joined only now, after the person said yes, and
      // only their first name. Written with the membership; sent after commit.
      const joiner = await tx.user.findUnique({ where: { id: input.userId }, select: { firstName: true } });
      const notice = await tx.notification.create({ data: {
        userId: vendor.owner.userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'New team member',
        body: `${joiner?.firstName?.trim() || 'Someone you invited'} joined ${vendor.name} as ${invite.role === 'MANAGER' ? 'a manager' : 'staff'}.`,
        data: { kind: 'staff_joined', vendorId: vendor.id, audience: 'business' },
      }, select: { id: true } });
      ownerNoticeId = notice.id;
    }
    await closePendingStaffInvites(tx, vendor.id, input.userId, input.now, input.inviteId);
    await close('ACCEPTED');
    return { decision: 'ACCEPTED' as const, storeName: vendor.name, role: (existing?.role ?? invite.role) as StaffInviteRole, ownerNoticeId };
  });
  // Rejected-but-closed invitations must commit before returning the HTTP
  // error; throwing inside the transaction would resurrect the pending card.
  if ('error' in outcome) throw outcome.error;
  if ('ownerNoticeId' in outcome) {
    const { ownerNoticeId, ...answer } = outcome;
    // The membership is committed; a failed push never undoes the answer.
    if (ownerNoticeId && sender) await sender.publishPersisted(ownerNoticeId).catch(() => false);
    return answer;
  }
  return outcome;
}
