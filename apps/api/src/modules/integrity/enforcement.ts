import type { PrismaClient } from '@prisma/client';
import { IdentityService } from './identity.service';

// The enforcement ladder's read side (spec Part 4). Rungs 2–3 bite at
// ACTIVATION, not at signup: a held account's documents are never
// auto-approved — a human reviews them with the identity panel open. The
// user-facing copy lives here so every surface says exactly the same thing
// (glossary law), and the fraud-tier message never names the signal (never
// leak the tell).

const HOLD_WINDOW_DAYS = 30;

/** An account is "held" while a recent REVIEW_FIRST / BLOCK_PENDING_FOUNDER
 *  action stands un-overturned. Overturning (appeal) lifts it. */
export async function hasActiveHold(prisma: PrismaClient, accountId: string): Promise<{ held: boolean; level?: string }> {
  const action = await prisma.enforcementAction.findFirst({
    where: {
      accountId,
      level: { in: ['REVIEW_FIRST', 'BLOCK_PENDING_FOUNDER'] },
      appeal: { not: 'OVERTURNED' },
      createdAt: { gte: new Date(Date.now() - HOLD_WINDOW_DAYS * 24 * 3600_000) },
    },
    orderBy: { createdAt: 'desc' },
    select: { level: true },
  });
  return action ? { held: true, level: action.level } : { held: false };
}

// Part 4 copy — canonical, extend-don't-drift. #4 is deliberately generic.
export const ENFORCEMENT_COPY = {
  TRIAL_ACTIVE_ELSEWHERE: 'Your free trial is already running on your existing account. Sign in to use your remaining days.',
  TRIAL_CONSUMED: (weekly: string) => `Welcome back. Your free trial was used on a previous account, so billing starts once you're approved — ${weekly} per week.`,
  DEBT_REINSTATE_FIRST: 'Your previous account has an outstanding balance. Settle it to reactivate — your history and standing come back with it.',
  FRAUD_HELD: "This application needs a manual check. We'll get back to you within 24 hours.",
  RETROACTIVE_REVOKE: (date: string) => `Your free trial on this account ends ${date}. Weekly billing starts then — trials are one per business owner.`,
} as const;

export interface TrialPreview {
  willTrial: boolean;
  reason: string;
  /** User-facing copy — null when a trial is coming (nothing to warn about). */
  message: string | null;
}

/** The told-before-they-commit read (§3.3): what activation will do for this
 *  human, WITHOUT side effects — no cluster creation, no enforcement rows.
 *  Surfaces on the onboarding status payload so the apps can show copy #2/#3
 *  before the person commits. */
export async function previewTrial(
  prisma: PrismaClient,
  accountId: string,
  role: string,
  tenantId: string,
  weeklyRateLabel?: string,
): Promise<TrialPreview> {
  const identity = new IdentityService(prisma);
  const clusterId = await identity.resolveCluster(accountId);
  if (!clusterId) return { willTrial: true, reason: 'FIRST_TRIAL', message: null };

  // Same matrix decide() runs, minus every write. Kept in step by the shared
  // scenario tests (a drift between preview and decide is a failing test).
  const members = await prisma.identityClusterMember.findMany({ where: { clusterId }, select: { accountId: true } });
  const memberIds = members.map((m) => m.accountId);
  const banned = await prisma.user.findFirst({ where: { id: { in: memberIds }, status: 'BANNED' }, select: { id: true } });
  if (banned) return { willTrial: false, reason: 'FRAUD_HELD', message: ENFORCEMENT_COPY.FRAUD_HELD };

  const debt = await prisma.subscription.findFirst({
    where: {
      status: { in: ['PAST_DUE', 'SUSPENDED', 'CHURNED'] },
      OR: [
        { rider: { userId: { in: memberIds } } },
        { driver: { userId: { in: memberIds } } },
        { vendor: { owner: { userId: { in: memberIds } } } },
      ],
    },
    select: { id: true },
  });
  if (debt) return { willTrial: false, reason: 'DEBT_REINSTATE_FIRST', message: ENFORCEMENT_COPY.DEBT_REINSTATE_FIRST };

  const grants = await prisma.trialGrant.findMany({ where: { tenantId, clusterId, role } });
  if (grants.length === 0) return { willTrial: true, reason: 'FIRST_TRIAL', message: null };
  const exception = await prisma.exceptionGrant.findFirst({
    where: { clusterId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    select: { id: true },
  });
  if (exception) return { willTrial: true, reason: 'EXCEPTION_GRANT', message: null };
  return grants.some((g) => g.status === 'ACTIVE')
    ? { willTrial: false, reason: 'TRIAL_ACTIVE_ELSEWHERE', message: ENFORCEMENT_COPY.TRIAL_ACTIVE_ELSEWHERE }
    : { willTrial: false, reason: 'TRIAL_CONSUMED', message: ENFORCEMENT_COPY.TRIAL_CONSUMED(weeklyRateLabel ?? 'the weekly fee') };
}

/** User-side appeal (Part 4): opens the case on the account's latest
 *  appealable enforcement. Fraud-tier holds (copy #4) are NOT user-appealable
 *  — the message they saw carries no appeal path, and the founder queue
 *  already holds them. */
/** [DOC-1 §24 · P24] The reason code of a document-fraud hold — the one fraud-tier hold a person MAY appeal (DOC-INV-33). */
export const DOC_FRAUD_REASON_CODE = 'DOC_FRAUD_CONFIRMED';

export async function openAppeal(prisma: PrismaClient, accountId: string, note: string) {
  // Trial-integrity fraud-cluster holds stay non-appealable (their message carries
  // no appeal path — the abuser learns nothing). A DOCUMENT-fraud hold is different:
  // §24.1 says the system is often wrong and the accusation is defamatory in tone,
  // so every such suspension exposes a human-review route — this one. The founder
  // resolves it (resolveAppeal), consistent with FD-DOC-16: preserve and refer.
  const action = await prisma.enforcementAction.findFirst({
    where: {
      accountId, appeal: 'NONE',
      OR: [{ level: { in: ['DENY_TRIAL', 'REVIEW_FIRST'] } }, { level: 'BLOCK_PENDING_FOUNDER', reasonCode: DOC_FRAUD_REASON_CODE }],
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!action) return null;
  return prisma.enforcementAction.update({
    where: { id: action.id },
    data: { appeal: 'OPEN', appealNote: note },
  });
}

/** Founder resolution. Overturn = the false-positive admission: it lifts the
 *  hold, grants the FOUNDER_OVERRIDE exception on the cluster (so the trial
 *  law honors the human next time), and feeds the overturn-rate metric that
 *  gates further enforcement expansion (Part 10: >5% pauses everything). */
export async function resolveAppeal(
  prisma: PrismaClient,
  enforcementId: string,
  adminUserId: string,
  outcome: 'OVERTURNED' | 'UPHELD',
  note: string,
) {
  const action = await prisma.enforcementAction.findUniqueOrThrow({ where: { id: enforcementId } });
  const updated = await prisma.enforcementAction.update({
    where: { id: enforcementId },
    data: { appeal: outcome, appealNote: [action.appealNote, `${outcome} by admin: ${note}`].filter(Boolean).join(' | ') },
  });
  if (outcome === 'OVERTURNED') {
    const identity = new IdentityService(prisma);
    const clusterId = action.clusterId ?? (await identity.resolveCluster(action.accountId));
    if (clusterId) {
      await prisma.exceptionGrant.create({
        data: { clusterId, scope: 'FOUNDER_OVERRIDE', note: `Appeal overturned: ${note}`, grantedBy: adminUserId },
      });
    }
  }
  return updated;
}

/** Part 10 — the false-positive alarm: overturns / resolved appeals. */
export async function appealOverturnRate(prisma: PrismaClient, days = 90): Promise<{ overturned: number; upheld: number; rate: number }> {
  const since = new Date(Date.now() - days * 24 * 3600_000);
  const [overturned, upheld] = await Promise.all([
    prisma.enforcementAction.count({ where: { appeal: 'OVERTURNED', createdAt: { gte: since } } }),
    prisma.enforcementAction.count({ where: { appeal: 'UPHELD', createdAt: { gte: since } } }),
  ]);
  const resolved = overturned + upheld;
  return { overturned, upheld, rate: resolved > 0 ? Math.round((overturned / resolved) * 10000) / 10000 : 0 };
}
