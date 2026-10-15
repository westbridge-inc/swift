import type { Prisma, PrismaClient } from '@prisma/client';
import { staffInviteAcceptEnabled } from '../vendor/staff-invites';

// ---------------------------------------------------------------------------
// [Owner ruling 13 Oct #15 · continues #1367 (loud alerts 2/4)] WHO hears a
// store: its team. The owner and every member of the team of THAT store
// (VendorStaff, MANAGER or STAFF), read from the database every time an alert,
// a re-alert or a store-room event goes out, never carried in a job or cached
// in a socket room. So a member removed from the store, or whose account stops
// being ACTIVE, stops hearing it at the very next send.
//
// A person is on the team only while their account is ACTIVE and belongs to
// the tenant of the store: a team row pointing across tenants carries nothing
// to the people of another tenant. Owner first, then the team in the order they were
// added; nobody twice.
//
// RINGING (owner, 15 Oct: "on duty" = the whole active team of an OPEN store):
// an order is placed only while its store is open (checkout refuses a closed,
// paused or suspended store). Closing the store later stops NEW orders, not
// the alerts for the orders it already has: those keep ringing until they are
// handled (coordinator ruling on review S4-1: an unattended paid order is
// worse). A store that Swift has suspended or closed down (status not ACTIVE)
// rings nobody, the owner included.
//
// CONSENT (coordinator ruling on review S3-1): managers and staff are rung only
// while STAFF_INVITE_ACCEPT is on, when every team member is someone who
// accepted an invite. While it is off, an owner can add an account directly,
// without its consent, so only the owner is rung, as before. The store room
// still admits the whole team: a member opens the board themselves.
// ---------------------------------------------------------------------------

/** The one read of the team of a store. Callers that must keep the read inline
 *  (the tenant census of the socket door) pass this select themselves. */
export const STORE_TEAM_SELECT = {
  tenantId: true,
  status: true,
  owner: { select: { userId: true, user: { select: { status: true, tenantId: true } } } },
  staff: {
    orderBy: { createdAt: 'asc' },
    select: { userId: true, user: { select: { status: true, tenantId: true } } },
  },
} satisfies Prisma.VendorSelect;

export type StoreTeamRow = Prisma.VendorGetPayload<{ select: typeof STORE_TEAM_SELECT }>;

export interface StoreTeam {
  tenantId: string;
  /** The ACTIVE same-tenant owner, when there is one. */
  ownerUserId: string | null;
  /** Owner first, then managers and staff in the order they were added. */
  userIds: string[];
  /** The store is ACTIVE (not suspended or closed down by Swift): its orders ring. */
  ringing: boolean;
}

export function teamOf(row: StoreTeamRow): StoreTeam {
  const onTeam = (user: { status: string; tenantId: string }) => user.status === 'ACTIVE' && user.tenantId === row.tenantId;
  const ownerUserId = onTeam(row.owner.user) ? row.owner.userId : null;
  const userIds = ownerUserId ? [ownerUserId] : [];
  for (const member of row.staff) {
    if (onTeam(member.user) && !userIds.includes(member.userId)) userIds.push(member.userId);
  }
  return { tenantId: row.tenantId, ownerUserId, userIds, ringing: row.status === 'ACTIVE' };
}

export async function storeTeam(db: Pick<PrismaClient, 'vendor'>, vendorId: string): Promise<StoreTeam | null> {
  const row = await db.vendor.findUnique({ where: { id: vendorId }, select: STORE_TEAM_SELECT });
  return row ? teamOf(row) : null;
}

/** Who a store order RINGS (alert, re-alert): nobody while the store is not
 *  ACTIVE; the whole team while staff invites need acceptance (consent); the
 *  owner alone while they do not. */
export function ringRecipients(team: StoreTeam, env: Record<string, string | undefined> = process.env): string[] {
  if (!team.ringing) return [];
  if (staffInviteAcceptEnabled(env)) return team.userIds;
  return team.ownerUserId ? [team.ownerUserId] : [];
}
