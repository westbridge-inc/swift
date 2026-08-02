import type { PrismaClient } from '@prisma/client';
import { appealOverturnRate } from './enforcement';

// The Part 7/10 KPI read — every number DERIVED from the rows money and state
// actually moved on (the dashboards law: PostHog explores, the DB testifies).
// No new event plumbing, no new tables: baselines are captured by reading
// this endpoint at t0 and re-reading after each fix lands.

const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 10000) / 10000 : null);

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export async function frictionKpis(prisma: PrismaClient, days = 30) {
  const since = new Date(Date.now() - days * 24 * 3600_000);

  // ── Part 10 integrity counters ─────────────────────────────────────────────
  const [trialsDenied, retroRevokes, fraudHolds, velocityFlags, signupAttempts, reviewFirstSignups] = await Promise.all([
    prisma.enforcementAction.count({ where: { level: 'DENY_TRIAL', createdAt: { gte: since } } }),
    prisma.enforcementAction.count({ where: { reasonCode: 'RETROACTIVE_TRIAL_REVOKE', createdAt: { gte: since } } }),
    prisma.enforcementAction.count({ where: { level: 'BLOCK_PENDING_FOUNDER', createdAt: { gte: since } } }),
    prisma.enforcementAction.count({ where: { reasonCode: 'VELOCITY_DEVICE', createdAt: { gte: since } } }),
    prisma.signupAttempt.count({ where: { createdAt: { gte: since } } }),
    prisma.signupAttempt.count({ where: { createdAt: { gte: since }, outcome: 'REVIEW_FIRST' } }),
  ]);
  const multiClusters = await prisma.identityClusterMember.groupBy({
    by: ['clusterId'],
    _count: { accountId: true },
    having: { accountId: { _count: { gt: 1 } } },
  });

  // ── F4 reinstatement latency: SUSPENDED → next REINSTATED per subscription ─
  const susEvents = await prisma.billingEvent.findMany({
    where: { type: { in: ['SUSPENDED', 'REINSTATED'] }, createdAt: { gte: since } },
    orderBy: [{ subscriptionId: 'asc' }, { createdAt: 'asc' }],
    select: { subscriptionId: true, type: true, createdAt: true },
  });
  const latencies: number[] = [];
  const openSuspension = new Map<string, Date>();
  for (const e of susEvents) {
    if (e.type === 'SUSPENDED') {
      openSuspension.set(e.subscriptionId, e.createdAt);
    } else if (e.type === 'REINSTATED') {
      const started = openSuspension.get(e.subscriptionId);
      if (started) {
        latencies.push(Math.round((e.createdAt.getTime() - started.getTime()) / 1000));
        openSuspension.delete(e.subscriptionId);
      }
    }
  }
  latencies.sort((a, b) => a - b);

  // ── F3/F16/week-2: the billing ladder's own honesty ────────────────────────
  const [reminders, suspensions, chargeSuccess, chargeFailed, churnedEvents, cancelledSubs] = await Promise.all([
    prisma.billingEvent.count({ where: { type: 'REMINDER', createdAt: { gte: since } } }),
    prisma.billingEvent.count({ where: { type: 'SUSPENDED', createdAt: { gte: since } } }),
    prisma.billingEvent.count({ where: { type: 'CHARGE_SUCCESS', createdAt: { gte: since } } }),
    prisma.billingEvent.count({ where: { type: 'CHARGE_FAILED', createdAt: { gte: since } } }),
    prisma.billingEvent.count({ where: { type: 'CHURNED', createdAt: { gte: since } } }),
    prisma.subscription.count({ where: { status: 'CANCELLED', updatedAt: { gte: since } } }),
  ]);

  // ── F6 trial → paid ────────────────────────────────────────────────────────
  const [trialsStarted, trialsConverted, trialsLost] = await Promise.all([
    prisma.trialGrant.count({ where: { startedAt: { gte: since } } }),
    prisma.subscription.count({
      where: { isTrialActive: false, trialEndDate: { gte: since, lte: new Date() }, status: { in: ['ACTIVE', 'PAST_DUE'] } },
    }),
    prisma.subscription.count({
      where: { trialEndDate: { gte: since, lte: new Date() }, status: { in: ['CANCELLED', 'CHURNED'] } },
    }),
  ]);

  return {
    windowDays: days,
    capturedAt: new Date().toISOString(),
    integrity: {
      trialsDenied,
      retroactiveRevokes: retroRevokes,
      fraudTierHolds: fraudHolds,
      velocityFlags,
      signupAttempts,
      reviewFirstShare: pct(reviewFirstSignups, signupAttempts),
      multiAccountClusters: multiClusters.length,
      // Part 10's false-positive alarm — >5% pauses enforcement expansion.
      appealOverturn: await appealOverturnRate(prisma, days),
    },
    friction: {
      // F4 — paid the debt, back to earning. Targets p95 ≤60s.
      reinstatementLatencySeconds: { count: latencies.length, p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
      // F3 — nobody suspended without the ladder having fired first.
      remindersPerSuspension: pct(reminders, suspensions),
      // Week-2 fee health.
      chargeSuccessRate: pct(chargeSuccess, chargeSuccess + chargeFailed),
      // F16 — involuntary (dunning → churn) vs chose-to-leave; the fix budget
      // follows this split.
      churn: { involuntary: churnedEvents, voluntary: cancelledSubs, involuntaryShare: pct(churnedEvents, churnedEvents + cancelledSubs) },
      // F6 — the day-15 moment.
      trialToPaid: { started: trialsStarted, converted: trialsConverted, lost: trialsLost, conversion: pct(trialsConverted, trialsConverted + trialsLost) },
    },
  };
}
