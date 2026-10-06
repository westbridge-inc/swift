import type { PrismaClient, Prisma } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';

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
  send(payload: {
    userId: string;
    type: 'SYSTEM_ANNOUNCEMENT';
    title: string;
    body: string;
    audience: 'customer';
    data: Record<string, unknown>;
  }): Promise<string>;
}

/**
 * Send one invite, unless the person is already on the team or already holds
 * a live invite from this store. Runs OFF the request path (the caller does
 * not await it), so a known number and an unknown one answer in the same time.
 */
export async function deliverStaffInvite(
  prisma: PrismaClient,
  sender: InviteSender,
  input: { vendorId: string; targetUserId: string; role: StaffInviteRole; inviterId: string; now: Date },
): Promise<'SENT' | 'ALREADY_MEMBER' | 'ALREADY_INVITED'> {
  const member = await prisma.vendorStaff.findUnique({
    where: { vendorId_userId: { vendorId: input.vendorId, userId: input.targetUserId } },
    select: { id: true },
  });
  if (member) return 'ALREADY_MEMBER';
  const live = await prisma.notification.findMany({
    where: inviteWhere(input.targetUserId, input.vendorId),
    select: { data: true },
  });
  if (live.some((n) => {
    const d = readInvite(n.data);
    return d !== null && new Date(d.expiresAt).getTime() > input.now.getTime();
  })) return 'ALREADY_INVITED';

  const vendor = await prisma.vendor.findUniqueOrThrow({ where: { id: input.vendorId }, select: { name: true } });
  const roleWords = input.role === 'MANAGER' ? 'a manager' : 'staff';
  await sender.send({
    userId: input.targetUserId,
    type: 'SYSTEM_ANNOUNCEMENT',
    title: 'Team invite',
    body: `${vendor.name} invited you to join their team as ${roleWords}. Open your notifications to accept or decline.`,
    audience: 'customer',
    data: {
      // A literal, so the push-kind censuses (alert class, tap router) see it.
      kind: 'staff_invite',
      vendorId: input.vendorId,
      storeName: vendor.name,
      role: input.role,
      invitedBy: input.inviterId,
      expiresAt: new Date(input.now.getTime() + STAFF_INVITE_TTL_MS).toISOString(),
      state: 'PENDING',
    } satisfies Omit<InviteData, 'audience'>,
  });
  return 'SENT';
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
 * Accept or decline one invite. The notification row is locked first, so a
 * double tap, or Accept racing Decline, has exactly one winner. Accepting
 * re-checks that the store still exists and that the person who invited is
 * still its owner; otherwise the invite is closed and nothing is granted.
 */
export async function decideStaffInvite(
  prisma: PrismaClient,
  input: { inviteId: string; userId: string; decision: 'ACCEPT' | 'DECLINE'; now: Date },
) {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "notifications" WHERE id = ${input.inviteId} AND "userId" = ${input.userId} FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundError('Invite', input.inviteId);
    const row = await tx.notification.findUniqueOrThrow({ where: { id: input.inviteId }, select: { data: true } });
    const invite = readInvite(row.data);
    if (!invite) throw new NotFoundError('Invite', input.inviteId);
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
      throw new AppError(410, 'INVITE_EXPIRED', 'This invite has expired. Ask the store owner to send a new one.');
    }
    if (input.decision === 'DECLINE') {
      await close('DECLINED');
      return { decision: 'DECLINED' as const };
    }

    const vendor = await tx.vendor.findUnique({
      where: { id: invite.vendorId },
      select: { id: true, name: true, owner: { select: { userId: true } } },
    });
    if (!vendor || vendor.owner.userId !== invite.invitedBy || vendor.owner.userId === input.userId) {
      await close('CLOSED');
      throw new AppError(409, 'INVITE_CLOSED', 'This invite is no longer valid.');
    }
    const existing = await tx.vendorStaff.findUnique({
      where: { vendorId_userId: { vendorId: vendor.id, userId: input.userId } },
      select: { role: true },
    });
    if (!existing) {
      await tx.vendorStaff.create({
        data: { vendorId: vendor.id, userId: input.userId, role: invite.role, invitedBy: invite.invitedBy },
      });
    }
    await close('ACCEPTED');
    return { decision: 'ACCEPTED' as const, storeName: vendor.name, role: (existing?.role ?? invite.role) as StaffInviteRole };
  });
}
