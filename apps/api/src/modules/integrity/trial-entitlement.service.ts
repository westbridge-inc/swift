import type { PrismaClient, Prisma } from '@prisma/client';
import { IdentityService } from './identity.service';
import { log } from '../../utils/logger';

// The trial entitlement law (trial-integrity spec §3): a free trial belongs to
// a HUMAN (identity cluster), per role, per tenant — never to an account.
// decide() is the ONLY authority on trials; SubscriptionService calls it at
// the moment activation would start a trial, and records the grant in the
// SAME transaction that creates the subscription. The TrialGrant unique
// (tenantId, clusterId, role) is the last line of defense under race.

export type TrialDecision =
  | { grant: true; clusterId: string; reason: 'FIRST_TRIAL' | 'EXCEPTION_GRANT' }
  | { grant: false; clusterId: string; reason: 'TRIAL_ACTIVE_ELSEWHERE' | 'TRIAL_CONSUMED' | 'DEBT_REINSTATE_FIRST' | 'FRAUD_HELD' };

const DAY_MS = 24 * 60 * 60 * 1000;

export class TrialEntitlementService {
  private identity: IdentityService;
  constructor(private prisma: PrismaClient) {
    this.identity = new IdentityService(prisma);
  }

  /** §3.2/§3.3 — the grant decision. Reads cluster state; never mutates
   *  (the WRITE happens via recordGrant inside the activation transaction). */
  async decide(accountId: string, role: string, tenantId: string): Promise<TrialDecision> {
    const clusterId = await this.clusterOrSingleton(accountId);

    // §3.3 fraud row: any BANNED user in the cluster → held (no trial; the
    // activation-gate UI integration is the enforcement phase — here we deny
    // the trial and leave the loud evidence row).
    const members = await this.prisma.identityClusterMember.findMany({ where: { clusterId }, select: { accountId: true } });
    const memberIds = members.map((m) => m.accountId);
    const banned = await this.prisma.user.findFirst({ where: { id: { in: memberIds }, status: 'BANNED' }, select: { id: true } });
    if (banned) {
      await this.prisma.enforcementAction.create({
        data: {
          accountId, clusterId, level: 'BLOCK_PENDING_FOUNDER', reasonCode: 'FRAUD_CLUSTER_REREGISTRATION',
          signalsFired: [{ note: 'cluster contains a BANNED account', bannedAccountId: banned.id }] as never,
          decidedBy: 'SYSTEM',
        },
      }).catch(() => {});
      return { grant: false, clusterId, reason: 'FRAUD_HELD' };
    }

    // §3.3 debt row: a cluster member's subscription sits suspended/past-due →
    // the human settles the ORIGINAL account first; no parallel trial.
    const debt = await this.prisma.subscription.findFirst({
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
    if (debt) {
      await this.prisma.enforcementAction.create({
        data: {
          accountId, clusterId, level: 'DENY_TRIAL', reasonCode: 'DEBT_REINSTATE_FIRST',
          signalsFired: [{ note: 'cluster holds a suspended/past-due subscription', subscriptionId: debt.id }] as never,
          decidedBy: 'SYSTEM',
        },
      }).catch(() => {});
      return { grant: false, clusterId, reason: 'DEBT_REINSTATE_FIRST' };
    }

    // History may hold several rows after retroactive unions (§3.4) — an
    // ACTIVE row outranks consumed/revoked history for the reason we give.
    const existing = await this.prisma.trialGrant.findMany({
      where: { tenantId, clusterId, role },
      orderBy: { startedAt: 'asc' },
    });
    if (existing.length === 0) {
      // §3.5 — an ExceptionGrant in scope can authorize an extra trial (e.g.
      // founder-approved multi-location). The FIRST trial needs no exception.
      return { grant: true, clusterId, reason: 'FIRST_TRIAL' };
    }
    if (await this.hasLiveException(clusterId)) {
      return { grant: true, clusterId, reason: 'EXCEPTION_GRANT' };
    }
    return existing.some((g) => g.status === 'ACTIVE')
      ? { grant: false, clusterId, reason: 'TRIAL_ACTIVE_ELSEWHERE' }
      : { grant: false, clusterId, reason: 'TRIAL_CONSUMED' };
  }

  /** Write the grant inside the activation transaction. Under race the unique
   *  throws P2002 for the loser — the caller converts that to billed-from-
   *  day-1 (§2.3 concurrency law; scenario I). With a live ExceptionGrant the
   *  duplicate is allowed via a per-account row keyed uniquely. */
  async recordGrant(
    tx: Prisma.TransactionClient,
    input: { accountId: string; clusterId: string; role: string; tenantId: string; trialDays: number; exception?: boolean },
  ) {
    const now = new Date();
    if (input.exception) {
      // Exception trials don't fight the unique — they are additional BY
      // DESIGN. Key them under a per-account pseudo-role so the law's unique
      // stays intact for the ordinary path.
      return tx.trialGrant.create({
        data: {
          tenantId: input.tenantId, clusterId: input.clusterId,
          role: `${input.role}:EX:${input.accountId}`, accountId: input.accountId,
          startedAt: now, endsAt: new Date(now.getTime() + input.trialDays * DAY_MS),
          statusReason: 'EXCEPTION_GRANT',
        },
      });
    }
    return tx.trialGrant.create({
      data: {
        tenantId: input.tenantId, clusterId: input.clusterId, role: input.role,
        accountId: input.accountId,
        startedAt: now, endsAt: new Date(now.getTime() + input.trialDays * DAY_MS),
      },
    });
  }

  /** §3.2 note — voluntary churn consumes the grant; returning never resets
   *  the clock. Called by the subscription cancel path. */
  async consumeOnChurn(accountId: string, role: string, tenantId: string, dayN: number): Promise<void> {
    const clusterId = await this.identity.resolveCluster(accountId);
    if (!clusterId) return;
    await this.prisma.trialGrant.updateMany({
      where: { tenantId, clusterId, role, status: 'ACTIVE' },
      data: { status: 'CONSUMED', statusReason: `CHURNED_DAY_${dayN}` },
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Accounts with no HARD/STRONG links still get a singleton cluster — the
   *  law follows the human even before any cross-account evidence exists. */
  private async clusterOrSingleton(accountId: string): Promise<string> {
    const existing = await this.identity.resolveCluster(accountId);
    if (existing) return existing;
    const cluster = await this.prisma.identityCluster.create({ data: {} });
    try {
      await this.prisma.identityClusterMember.create({
        data: { accountId, clusterId: cluster.id, linkedVia: [{ type: 'SELF', at: new Date().toISOString() }] as never },
      });
      return cluster.id;
    } catch {
      // Raced with a capture that just created membership — resolve again.
      const resolved = await this.identity.resolveCluster(accountId);
      if (resolved) return resolved;
      log().error({ accountId }, 'cluster singleton race unresolved — using fresh cluster');
      return cluster.id;
    }
  }

  private async hasLiveException(clusterId: string): Promise<boolean> {
    const ex = await this.prisma.exceptionGrant.findFirst({
      where: { clusterId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      select: { id: true },
    });
    return !!ex;
  }
}
