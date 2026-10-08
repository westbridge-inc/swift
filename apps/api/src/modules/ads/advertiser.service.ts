import type { PrismaClient, Prisma, Advertiser, AdvertiserStatus, AdvertiserMemberRole } from '@prisma/client';
import { refuseReviewAccountRoleGrant } from '../review/demo-policy';
import type { Server } from 'socket.io';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { log } from '../../utils/logger';

/** [MASTER-064] The advertiser role matrix (spec §14.6: the OWNER invites a
 *  MANAGER, who runs campaigns, and an ANALYST, who reads stats), by named
 *  capability. Anything that books inventory, issues an invoice or creates a
 *  refund obligation is the OWNER's alone.
 *    read     — dashboards, stats, invoices, the team list, the refund preview
 *    campaign — draft a campaign, upload creatives, pause, resume
 *    finance  — reserve inventory, check out, cancel (with its refund)
 *    team     — add or change members */
export type AdvertiserCapability = 'read' | 'campaign' | 'finance' | 'team';
export const ADVERTISER_ROLE_MATRIX: Readonly<Record<AdvertiserCapability, readonly AdvertiserMemberRole[]>> = Object.freeze({
  read: ['OWNER', 'MANAGER', 'ANALYST'],
  campaign: ['OWNER', 'MANAGER'],
  finance: ['OWNER'],
  team: ['OWNER'],
});

function assertRoleHolds(role: AdvertiserMemberRole | null | undefined, capability: AdvertiserCapability): void {
  const allowed = ADVERTISER_ROLE_MATRIX[capability];
  if (!role || !allowed || !allowed.includes(role)) {
    throw new AppError(403, 'ADVERTISER_ROLE_FORBIDDEN', 'Your role on this advertiser account does not allow this.');
  }
}

/** [MASTER-064] The money operations' second check, INSIDE their own
 *  transaction: the member row is read with FOR SHARE, so a removal or a
 *  downgrade that committed after the route's check is obeyed here, and one
 *  that arrives while this transaction runs waits for it to finish (the
 *  action is decided on the role it locked, never on a stale read). */
export async function assertCapabilityWithin(
  tx: Prisma.TransactionClient,
  advertiserId: string,
  userId: string,
  capability: AdvertiserCapability,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ role: AdvertiserMemberRole }>>`
    SELECT "role" FROM "advertiser_members"
     WHERE "advertiserId" = ${advertiserId} AND "userId" = ${userId}
     FOR SHARE`;
  if (rows.length === 0) throw new AppError(403, 'ADVERTISER_ROLE_FORBIDDEN', 'You are no longer a member of this advertiser account.');
  assertRoleHolds(rows[0]!.role, capability);
}

// Advertiser lifecycle (ads-platform spec §4). A logged-in user registers a
// company and becomes its first OWNER member; the application lands
// PENDING_REVIEW in the founder's queue. Ad-management access is keyed on
// AdvertiserMember (the data model's own access primitive) — NOT a new
// UserRole, so the platform role enum stays clean (reconciled from the spec's
// "role picker" framing, which only ever needs the membership row).
//
// State machine (§4.3):
//   register → PENDING_REVIEW → approve → APPROVED → suspend → SUSPENDED → reinstate → APPROVED
//                             → reject  → REJECTED
// No documents in v1 — advertisers are paying customers, not custodial actors;
// the founder approves on the company being real. Every admin action is
// audited to AdsAuditLog with a reason and pages the applicant with due copy.

const INDUSTRIES = ['Retail', 'Food & Beverage', 'Entertainment', 'Telecom', 'Financial', 'Automotive', 'Real Estate', 'Services', 'Other'] as const;

export interface AdvertiserRegisterInput {
  companyName: string;
  legalName?: string | null;
  registrationNo?: string | null;
  industry: string;
  website?: string | null;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  city?: string | null;
}

export class AdvertiserService {
  private notifications: NotificationService;
  constructor(private prisma: PrismaClient, private io: Server) {
    this.notifications = new NotificationService(prisma, io);
  }

  static readonly INDUSTRIES = INDUSTRIES;

  /** §4.2 register — creates the Advertiser (PENDING_REVIEW) + the caller as
   *  OWNER member, in one transaction, then pages the admin queue. One live
   *  application per user is enough for v1; a second registration by the same
   *  user for the same company name is refused. */
  async register(userId: string, input: AdvertiserRegisterInput): Promise<Advertiser> {
    // [REVIEW-PARTNER] A demo account never becomes an advertiser (an OWNER membership, an admin page).
    await refuseReviewAccountRoleGrant(this.prisma, userId);
    const existing = await this.prisma.advertiser.findFirst({
      where: { createdByUserId: userId, companyName: input.companyName, status: { in: ['PENDING_REVIEW', 'APPROVED', 'SUSPENDED'] } },
    });
    if (existing) throw new AppError(409, 'ADVERTISER_EXISTS', 'You already registered this company — check your advertiser dashboard.');

    const advertiser = await this.prisma.$transaction(async (tx) => {
      const a = await tx.advertiser.create({
        data: {
          companyName: input.companyName,
          legalName: input.legalName ?? null,
          registrationNo: input.registrationNo ?? null,
          industry: input.industry,
          website: input.website ?? null,
          contactName: input.contactName,
          contactEmail: input.contactEmail,
          contactPhone: input.contactPhone,
          city: input.city ?? null,
          createdByUserId: userId,
        },
      });
      await tx.advertiserMember.create({ data: { advertiserId: a.id, userId, role: 'OWNER' } });
      return a;
    });

    await notifyAdmins(this.prisma, this.notifications, {
      tenantId: advertiser.tenantId ?? null,
      title: 'New advertiser application',
      body: `${input.companyName} (${input.industry}) applied to advertise on Swift. Review in the advertiser queue.`,
      data: { kind: 'advertiser_application', advertiserId: advertiser.id, companyName: input.companyName },
    }).catch(() => {});
    log().info({ advertiserId: advertiser.id, userId }, 'advertiser registered — PENDING_REVIEW');
    return advertiser;
  }

  /** Every advertiser this user is a member of, with their role. */
  async listForUser(userId: string) {
    const members = await this.prisma.advertiserMember.findMany({
      where: { userId },
      include: { advertiser: true },
      orderBy: { createdAt: 'desc' },
    });
    return members.map((m) => ({ ...m.advertiser, memberRole: m.role }));
  }

  /** [MASTER-064] Assert the user is a member of THIS advertiser whose role
   *  holds the named capability (see ADVERTISER_ROLE_MATRIX). Every caller
   *  names its capability — there is no permissive default. A non-member gets
   *  the same 404 as a missing account; a member whose role lacks the
   *  capability gets 403 ADVERTISER_ROLE_FORBIDDEN. */
  async assertCapability(advertiserId: string, userId: string, capability: AdvertiserCapability) {
    const member = await this.prisma.advertiserMember.findUnique({
      where: { advertiserId_userId: { advertiserId, userId } },
    });
    if (!member) throw new NotFoundError('Advertiser', advertiserId);
    assertRoleHolds(member.role, capability);
    return member;
  }

  // ── Admin queue actions (§4.3) — all audited, all page the applicant ──────

  /** The founder's review queue: applications awaiting a decision, oldest first. */
  async queue(status: AdvertiserStatus = 'PENDING_REVIEW', limit = 50) {
    return this.prisma.advertiser.findMany({
      where: { status },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  async approve(advertiserId: string, adminUserId: string) {
    const a = await this.transition(advertiserId, ['PENDING_REVIEW', 'SUSPENDED'], 'APPROVED', adminUserId, 'ADVERTISER_APPROVE');
    await this.notifyOwners(a.id, "You're approved — launch your first campaign", 'Your Swift advertiser account is approved. You can now book placements and pay to go live.', 'advertiser_approved');
    return a;
  }

  async reject(advertiserId: string, adminUserId: string, reason: string) {
    const a = await this.transition(advertiserId, ['PENDING_REVIEW'], 'REJECTED', adminUserId, 'ADVERTISER_REJECT', reason);
    await this.notifyOwners(a.id, 'Advertiser application not approved', `${reason} Your drafts are preserved — contact support to appeal.`, 'advertiser_rejected');
    return a;
  }

  /** §4.3 suspend — auto-PAUSE all LIVE/SCHEDULED campaigns (audited); the
   *  serving pool purge rides Phase 4 (nothing serves yet). */
  async suspend(advertiserId: string, adminUserId: string, reason: string) {
    const a = await this.transition(advertiserId, ['APPROVED'], 'SUSPENDED', adminUserId, 'ADVERTISER_SUSPEND', reason);
    const paused = await this.prisma.adCampaign.updateMany({
      where: { advertiserId, status: { in: ['LIVE', 'SCHEDULED'] } },
      data: { status: 'PAUSED', statusReason: `Advertiser suspended: ${reason}` },
    });
    if (paused.count > 0) {
      await this.prisma.adsAuditLog.create({
        data: { actorUserId: adminUserId, action: 'ADVERTISER_SUSPEND_CASCADE', entityType: 'Advertiser', entityId: advertiserId, reason: `${paused.count} campaign(s) auto-paused` },
      });
    }
    await this.notifyOwners(a.id, 'Advertiser account suspended', `${reason} Your live campaigns are paused — contact support.`, 'advertiser_suspended');
    return a;
  }

  async reinstate(advertiserId: string, adminUserId: string) {
    // Paused campaigns STAY paused until the advertiser resumes them (§4.3).
    const a = await this.transition(advertiserId, ['SUSPENDED'], 'APPROVED', adminUserId, 'ADVERTISER_REINSTATE');
    await this.notifyOwners(a.id, 'Advertiser account reinstated', 'Your account is active again. Resume your paused campaigns when ready.', 'advertiser_reinstated');
    return a;
  }

  /** CAS transition + audit log with a before/after snapshot. */
  private async transition(id: string, from: AdvertiserStatus[], to: AdvertiserStatus, adminUserId: string, action: string, reason?: string): Promise<Advertiser> {
    const before = await this.prisma.advertiser.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Advertiser', id);
    const moved = await this.prisma.advertiser.updateMany({
      where: { id, status: { in: from } },
      data: { status: to, statusReason: reason ?? null },
    });
    if (moved.count === 0) {
      throw new AppError(409, 'INVALID_ADVERTISER_TRANSITION', `Cannot move an advertiser from ${before.status} to ${to}.`);
    }
    const after = await this.prisma.advertiser.findUniqueOrThrow({ where: { id } });
    await this.prisma.adsAuditLog.create({
      data: { actorUserId: adminUserId, action, entityType: 'Advertiser', entityId: id, before: { status: before.status } as never, after: { status: to } as never, reason: reason ?? null },
    }).catch(() => {});
    return after;
  }

  private async notifyOwners(advertiserId: string, title: string, body: string, kind: string) {
    const { notifyAdvertiserOwners } = await import('./ads-notify');
    await notifyAdvertiserOwners(this.prisma, this.notifications, advertiserId, { title, body, kind, data: { advertiserId } });
  }
}
