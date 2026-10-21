import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import { getChannels, type SmsProvider } from '../../providers/notifications/channels';
import { runWithTenant } from '../../plugins/tenant-context';
import { AccountService } from './account.service';

/**
 * [R23 · research C10 · DPA s.4(1)(e)] A CUSTOMER account nobody has used for 12 months is
 * closed, after a notice.
 *
 *  1. Notice: a customer-only account with no use for the window (12 months unless the
 *     setting says otherwise) is told in the app and by text that it closes in 30 days.
 *  2. Any use after the notice (a sign-in, a session refresh, an order or a service job)
 *     cancels it.
 *  3. Thirty days after the notice, with no use, the ORDINARY account-deletion pipeline runs
 *     (AccountService.deleteAccount): its own blockers (live orders or jobs) keep the account,
 *     and a safety hold is escrowed exactly as for a person who asked.
 *
 * Never touched: partners and staff of any kind (any role besides CUSTOMER, a rider, driver,
 * store-owner, service-provider or admin profile, a store team membership, an advertiser
 * account; research C10: partners need longer while documents and fee records run, a period
 * not yet decided), store-review and crawler tenants, synthetic people, an already-closed
 * account, anyone under a document legal hold, and anyone Swift still has an open matter
 * with (a refund owed, an open MMG payment claim, an open support ticket).
 *
 * DARK until the owner switches it on (PlatformConfig accounts.inactive_closure = true),
 * which waits for the Privacy Policy and Terms to say it (GUARDRAILS 7(1)). The clock starts
 * only on a text the SMS provider accepted, so nobody is closed on a notice that never left.
 * Each closure writes an audit row (ACCOUNT_CLOSED_INACTIVE); every run writes a retention
 * receipt (accounts.inactive_customers).
 */

export const INACTIVE_CUSTOMER_DAYS_KEY = 'accounts.inactive_customer_days';
/** The switch: only `true` turns the sweep on. */
export const INACTIVE_CLOSURE_SWITCH_KEY = 'accounts.inactive_closure';
export const DEFAULT_INACTIVE_CUSTOMER_DAYS = 365;
export const INACTIVITY_NOTICE_DAYS = 30;
export const INACTIVITY_RECEIPT_CLASS = 'accounts.inactive_customers';
export const INACTIVITY_NOTICE_TITLE = 'Your Swift account will be closed';
const DAY_MS = 86_400_000;
const BATCH = 200;

type Db = PrismaClient;
export type InactivityDeps = {
  prisma: Db;
  io: FastifyInstance['io'];
  log: Pick<FastifyInstance['log'], 'info' | 'warn' | 'error'>;
  sms?: SmsProvider;
};
export type InactivityRun = { noticed: number; deleted: number; blocked: number; revived: number };

/** The window in days: a setting between 180 and 3650 days, else 12 months (a typo never closes everyone). */
export async function inactiveCustomerDays(prisma: Db): Promise<number> {
  const row = await prisma.platformConfig.findUnique({ where: { key: INACTIVE_CUSTOMER_DAYS_KEY }, select: { value: true } });
  const value = row?.value;
  return typeof value === 'number' && Number.isInteger(value) && value >= 180 && value <= 3650 ? value : DEFAULT_INACTIVE_CUSTOMER_DAYS;
}

/** Who this sweep may ever touch: an active, real, customer-only account in a production tenant, not under a legal hold. */
const IN_SCOPE: Prisma.UserWhereInput = {
  status: 'ACTIVE',
  isSynthetic: false,
  roles: { equals: ['CUSTOMER'] },
  tenant: { kind: 'PRODUCTION' },
  NOT: { phone: { startsWith: 'deleted:' } },
  // A partner or staff member can be a CUSTOMER-only user with a profile or a membership.
  rider: { is: null }, driver: { is: null }, vendorOwner: { is: null }, serviceProvider: { is: null }, admin: { is: null },
  vendorStaffMemberships: { none: {} },
  docLegalHolds: { none: { releasedAt: null } },
  // An open matter with Swift keeps the account: a refund owed, an open MMG payment claim, an open ticket.
  orders: { none: { OR: [
    { refundOwedAt: { not: null }, refundSettledAt: null },
    { customerMmgClaimAt: { not: null }, mmgClaimResolvedAt: null },
  ] } },
  supportTickets: { none: { status: { not: 'RESOLVED' } } },
};

/** Advertisers are customer-role users with an advertiser account (no back-relation on the user). */
async function advertiserIds(prisma: Db, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const [owners, members] = await Promise.all([
    prisma.advertiser.findMany({ where: { createdByUserId: { in: ids } }, select: { createdByUserId: true } }),
    prisma.advertiserMember.findMany({ where: { userId: { in: ids }, acceptedAt: { not: null } }, select: { userId: true } }),
  ]);
  return new Set([...owners.map((r) => r.createdByUserId), ...members.map((r) => r.userId)]);
}

/** No use at or after `since`: no sign-in, no session made or refreshed, no order or service job touched. */
function unusedSince(since: Date): Prisma.UserWhereInput {
  return {
    OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: since } }],
    sessions: { none: { OR: [{ createdAt: { gte: since } }, { rotatedAt: { gte: since } }] } },
    orders: { none: { updatedAt: { gte: since } } },
    serviceJobs: { none: { updatedAt: { gte: since } } },
  };
}

/** "15 November 2026" (Guyana time) — no ordinals, nothing outside the GSM alphabet. */
function closingDay(at: Date): string {
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Guyana' });
}

/** The window said in months (365 days = 12 months). */
export const windowMonths = (days: number): number => Math.max(1, Math.round(days / 30.4375));

export function inactivityNoticeText(closesOn: Date, windowDays: number = DEFAULT_INACTIVE_CUSTOMER_DAYS): { title: string; body: string; sms: string } {
  const day = closingDay(closesOn);
  const months = windowMonths(windowDays);
  return {
    title: INACTIVITY_NOTICE_TITLE,
    body: `You have not used Swift for ${months} months. To keep your account, open the app and sign in before ${day}. If you do not, we close it on that day, in ${INACTIVITY_NOTICE_DAYS} days, and delete your data as the Privacy Policy explains.`,
    sms: `Swift: you have not used your account for ${months} months. Sign in before ${day} to keep it. Otherwise we close it in ${INACTIVITY_NOTICE_DAYS} days and delete your data.`,
  };
}

export async function inactivitySweep(deps: InactivityDeps, now: Date = new Date()): Promise<InactivityRun> {
  const { prisma } = deps;
  const started = Date.now();
  const run: InactivityRun = { noticed: 0, deleted: 0, blocked: 0, revived: 0 };
  const sw = await prisma.platformConfig.findUnique({ where: { key: INACTIVE_CLOSURE_SWITCH_KEY }, select: { value: true } });
  if (sw?.value !== true) return run;
  const days = await inactiveCustomerDays(prisma);
  const cutoff = new Date(now.getTime() - days * DAY_MS);

  // 1. Use after a notice cancels it.
  const noticed = await prisma.user.findMany({
    where: { inactivityNoticeAt: { not: null } }, select: { id: true, tenantId: true, inactivityNoticeAt: true },
    orderBy: { inactivityNoticeAt: 'asc' }, take: BATCH * 5,
  });
  const stillQuiet: Array<{ id: string; tenantId: string; noticeAt: Date }> = [];
  const advertisers = await advertiserIds(prisma, noticed.map((u) => u.id));
  for (const u of noticed) {
    const quiet = advertisers.has(u.id) ? 0 : await prisma.user.count({ where: { id: u.id, AND: [IN_SCOPE, unusedSince(u.inactivityNoticeAt!)] } });
    if (quiet === 1) { stillQuiet.push({ id: u.id, tenantId: u.tenantId, noticeAt: u.inactivityNoticeAt! }); continue; }
    const cleared = await prisma.user.updateMany({ where: { id: u.id, inactivityNoticeAt: u.inactivityNoticeAt }, data: { inactivityNoticeAt: null } });
    run.revived += cleared.count;
  }

  // 2. Thirty days after the notice, still unused: the ordinary deletion pipeline.
  const closeBefore = new Date(now.getTime() - INACTIVITY_NOTICE_DAYS * DAY_MS);
  const accounts = new AccountService({ prisma, io: deps.io, log: deps.log as FastifyInstance['log'] });
  for (const u of stillQuiet) {
    if (u.noticeAt.getTime() > closeBefore.getTime()) continue;
    try {
      // Narrowed to the person's tenant, like every other deletion caller (account-erasure-retry).
      await runWithTenant(u.tenantId, () => accounts.deleteAccount(u.id));
      run.deleted += 1;
    } catch (err) {
      run.blocked += 1;
      deps.log.warn({ userId: u.id, code: (err as { code?: string }).code ?? null }, '[R23] inactive account kept: the deletion pipeline refused it');
      continue;
    }
    // Closed: the notice has done its job (a later reactivation starts from no notice).
    await prisma.user.updateMany({ where: { id: u.id }, data: { inactivityNoticeAt: null } });
    // Per person: why this account was closed, and on what notice (append-only audit trail).
    await prisma.auditLog.create({ data: {
      userId: null, action: 'ACCOUNT_CLOSED_INACTIVE', entity: 'User', entityId: u.id,
      changes: { noticeAt: u.noticeAt.toISOString(), windowDays: days, noticeDays: INACTIVITY_NOTICE_DAYS, closedBy: 'inactivity-sweep' },
    } }).catch((err) => deps.log.error({ err, userId: u.id }, '[R23] inactive account closed but its audit row was not written'));
  }

  // 3. New notices: unused for the whole window (and older than it).
  const candidates = await prisma.user.findMany({
    // AND, never a spread: both filters constrain `orders` and must both hold.
    where: { AND: [IN_SCOPE, unusedSince(cutoff)], inactivityNoticeAt: null, createdAt: { lt: cutoff } },
    select: { id: true, phone: true }, orderBy: { createdAt: 'asc' }, take: BATCH,
  });
  const notAdvertisers = await advertiserIds(prisma, candidates.map((u) => u.id));
  const due = candidates.filter((u) => !notAdvertisers.has(u.id));
  const closesOn = new Date(now.getTime() + INACTIVITY_NOTICE_DAYS * DAY_MS);
  const text = inactivityNoticeText(closesOn, days);
  const sms = deps.sms ?? getChannels().sms;
  for (const u of due) {
    // The clock starts only on a text the provider accepted: a notice that never left is no
    // notice. Failed today = tried again tomorrow, nothing set.
    try {
      await sms.sendSms(u.phone, text.sms);
    } catch (err) {
      deps.log.warn({ err, userId: u.id }, '[R23] inactivity notice text not accepted; no notice, tried again next run');
      continue;
    }
    // The notice date is the clock: set once (a concurrent run cannot start it twice).
    const claimed = await prisma.user.updateMany({ where: { id: u.id, inactivityNoticeAt: null }, data: { inactivityNoticeAt: now } });
    if (claimed.count !== 1) continue;
    await prisma.notification.create({ data: { userId: u.id, type: 'SYSTEM_ANNOUNCEMENT', title: text.title, body: text.body } });
    run.noticed += 1;
  }

  await prisma.retentionSweepReceipt.create({
    data: { dataClass: INACTIVITY_RECEIPT_CLASS, cutoff, deleted: run.deleted, durationMs: Date.now() - started },
  });
  deps.log.info(run, '[R23] inactive-account sweep complete');
  return run;
}
