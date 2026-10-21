import type { PrismaClient, Advertiser, AdvertiserStatus } from '@prisma/client';
import { isReviewAccount, refuseReviewAccountRoleGrant } from '../review/demo-policy';
import type Redis from 'ioredis';
import type { Server } from 'socket.io';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { log } from '../../utils/logger';

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

/** [ads security] Team invitations an advertiser may send in one UTC day. Every attempt counts,
 *  whether or not the number has an account, so the cap says nothing about who exists. */
export const ADS_TEAM_INVITES_PER_DAY = 10;
/** [ads security · #1995 REVIEW-F S4-1] An invitation not accepted within this many days is gone: it is
 *  not listed, cannot be accepted, and the lifecycle tick deletes it (it holds the person's id). */
export const ADS_TEAM_INVITE_DAYS = 14;
const inviteCutoff = (now = Date.now()) => new Date(now - ADS_TEAM_INVITE_DAYS * 86_400_000);

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
      await tx.advertiserMember.create({ data: { advertiserId: a.id, userId, role: 'OWNER', acceptedAt: new Date() } });
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

  /** Every advertiser this user is a member of (accepted), with their role. */
  async listForUser(userId: string) {
    const members = await this.prisma.advertiserMember.findMany({
      where: { userId, acceptedAt: { not: null } },
      include: { advertiser: true },
      orderBy: { createdAt: 'desc' },
    });
    return members.map((m) => ({ ...m.advertiser, memberRole: m.role }));
  }

  /** Assert the user may manage this advertiser (any member role can read;
   *  callers requiring OWNER pass requireOwner). */
  async assertMember(advertiserId: string, userId: string, requireOwner = false) {
    const member = await this.prisma.advertiserMember.findUnique({
      where: { advertiserId_userId: { advertiserId, userId } },
    });
    // [ads security] An open invitation is not a membership: it opens nothing.
    if (!member || member.acceptedAt === null) throw new NotFoundError('Advertiser', advertiserId);
    if (requireOwner && member.role !== 'OWNER') {
      throw new AppError(403, 'OWNER_REQUIRED', 'Only the account owner can do this.');
    }
    return member;
  }

  // ── [ads security] The team grows by invitation and acceptance ───────────────
  // An OWNER invites by phone; the reply never says whether the number has an account. The
  // invitation grants nothing (assertMember refuses it) until the person accepts it. The team list
  // names accepted members only.

  /** OWNER only. Silent for an unknown number or a demo account; never changes an existing row. */
  async inviteToTeam(
    deps: { redis: Redis; notifications: NotificationService },
    advertiserId: string, ownerUserId: string, phone: string, role: 'MANAGER' | 'ANALYST',
  ): Promise<void> {
    await this.assertMember(advertiserId, ownerUserId, true);
    // [REVIEW-PARTNER] No membership is granted by a demo account (about the caller alone).
    await refuseReviewAccountRoleGrant(this.prisma, ownerUserId);
    // Every attempt counts against the day, known number or not.
    const key = `ads:team-invites:${advertiserId}:${new Date().toISOString().slice(0, 10)}`;
    const sent = await deps.redis.incr(key);
    if (sent === 1) await deps.redis.expire(key, 2 * 86_400);
    if (sent > ADS_TEAM_INVITES_PER_DAY) {
      throw new AppError(429, 'TEAM_INVITE_LIMIT', `An advertiser can send ${ADS_TEAM_INVITES_PER_DAY} team invitations a day. Try again tomorrow.`);
    }
    const invited = await this.prisma.user.findUnique({ where: { phone }, select: { id: true } });
    if (!invited || await isReviewAccount(this.prisma, invited.id)) return;
    // An expired invitation is gone: a new one starts afresh.
    await this.prisma.advertiserMember.deleteMany({ where: { advertiserId, userId: invited.id, acceptedAt: null, createdAt: { lt: inviteCutoff() } } });
    // An accepted member is never changed by an invitation, and an open one stays as it was.
    const row = await this.prisma.advertiserMember.upsert({
      where: { advertiserId_userId: { advertiserId, userId: invited.id } },
      create: { advertiserId, userId: invited.id, role, acceptedAt: null },
      update: {},
    });
    if (row.acceptedAt !== null) return;
    const advertiser = await this.prisma.advertiser.findUnique({ where: { id: advertiserId }, select: { companyName: true } });
    await deps.notifications.send({
      userId: invited.id,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'An advertiser team invitation',
      body: `${advertiser?.companyName ?? 'An advertiser'} invited you to join their advertiser team as ${role === 'MANAGER' ? 'a manager' : 'an analyst'}. Nothing changes unless you accept.`,
      data: { kind: 'ad_team_invite', advertiserId },
    }).catch(() => {});
  }

  /** The invited person accepts their own open invitation. */
  async acceptTeamInvite(advertiserId: string, userId: string): Promise<void> {
    const r = await this.prisma.advertiserMember.updateMany({ where: { advertiserId, userId, acceptedAt: null, createdAt: { gte: inviteCutoff() } }, data: { acceptedAt: new Date() } });
    if (r.count === 0) throw new NotFoundError('Invitation', advertiserId);
  }

  /** The invited person declines: the invitation is gone. */
  async declineTeamInvite(advertiserId: string, userId: string): Promise<void> {
    const r = await this.prisma.advertiserMember.deleteMany({ where: { advertiserId, userId, acceptedAt: null } });
    if (r.count === 0) throw new NotFoundError('Invitation', advertiserId);
  }

  /** The caller's own open invitations. */
  async listTeamInvites(userId: string) {
    const rows = await this.prisma.advertiserMember.findMany({
      where: { userId, acceptedAt: null, createdAt: { gte: inviteCutoff() } }, include: { advertiser: { select: { companyName: true } } }, orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({ advertiserId: r.advertiserId, companyName: r.advertiser.companyName, role: r.role, invitedAt: r.createdAt }));
  }

  /** The team, for a member: accepted members by name and phone; an open invitation by role only. */
  async teamList(advertiserId: string, viewerUserId: string) {
    await this.assertMember(advertiserId, viewerUserId);
    const members = await this.prisma.advertiserMember.findMany({
      where: { advertiserId, OR: [{ acceptedAt: { not: null } }, { createdAt: { gte: inviteCutoff() } }] }, orderBy: { createdAt: 'asc' },
    });
    const accepted = members.filter((m) => m.acceptedAt !== null);
    const users = await this.prisma.user.findMany({
      where: { id: { in: accepted.map((m) => m.userId) } }, select: { id: true, firstName: true, lastName: true, phone: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));
    return members.map((m) => {
      if (m.acceptedAt === null) return { role: m.role, status: 'PENDING' as const };
      const u = userById.get(m.userId);
      return { userId: m.userId, role: m.role, status: 'ACCEPTED' as const, name: u ? `${u.firstName} ${u.lastName}`.trim() : null, phone: u?.phone ?? null };
    });
  }

  /** The lifecycle tick: delete every invitation past its days (each holds a person's id). */
  async purgeExpiredTeamInvites(): Promise<number> {
    const r = await this.prisma.advertiserMember.deleteMany({ where: { acceptedAt: null, createdAt: { lt: inviteCutoff() } } });
    return r.count;
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
