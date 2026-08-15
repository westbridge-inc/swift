import type { PrismaClient } from '@prisma/client';
import { IdentityService } from './identity.service';
import { normalizePhone, normalizeEmail, normalizePlate } from './normalize';
import { log } from '../../utils/logger';
import { runWithoutTenant } from '../../plugins/tenant-context';

// Phase 2 (spec Part 12): run the matcher across the EXISTING user base and
// hand the founder an evidence report of every multi-account cluster BEFORE
// any enforcement expands — there may be farmers already inside; evidence
// first, decisions second. Idempotent: capture() no-ops on re-runs, so the
// backfill can be re-triggered safely as new signal types come online.
//
// What is backfillable today: PHONE (unique per user — cannot union, still
// captured for future links), EMAIL (SOFT — flag-only by law), PLATE
// (drivers — HARD: one plate, one active vehicle account), MMG_PAYER
// (subscription rails — HARD: the money doesn't lie). ID document numbers
// were never persisted raw anywhere (by design) and CANNOT be backfilled —
// they accumulate from new verifications onward.

export interface BackfillReport {
  scanned: { users: number; drivers: number; mmgRails: number };
  captured: number;
  clusters: Array<{
    clusterId: string;
    members: Array<{ accountId: string; phone: string | null; name: string; roles: string[] }>;
    evidence: unknown[];
    trialGrants: Array<{ role: string; status: string; accountId: string }>;
  }>;
}

export async function runIdentityBackfill(prisma: PrismaClient): Promise<BackfillReport> {
  // This is founder-only, platform-wide reconciliation. Running it through a
  // request-scoped client otherwise scans the default tenant's users while
  // still seeing unscoped legacy children, producing an incomplete and
  // internally inconsistent evidence report.
  return runWithoutTenant(async () => {
  const identity = new IdentityService(prisma);
  let captured = 0;

  const users = await prisma.user.findMany({
    select: { id: true, phone: true, email: true, activeRole: true },
  });
  for (const u of users) {
    if (u.phone) {
      await identity.capture({ accountId: u.id, actorRole: String(u.activeRole), type: 'PHONE', normalizedValue: normalizePhone(u.phone), source: 'BACKFILL' });
      captured += 1;
    }
    if (u.email) {
      await identity.capture({ accountId: u.id, actorRole: String(u.activeRole), type: 'EMAIL', normalizedValue: normalizeEmail(u.email), source: 'BACKFILL' });
      captured += 1;
    }
  }

  const drivers = await prisma.driver.findMany({ select: { userId: true, licensePlate: true } });
  for (const d of drivers) {
    if (!d.licensePlate) continue;
    await identity.capture({ accountId: d.userId, actorRole: 'DRIVER', type: 'PLATE', normalizedValue: normalizePlate(d.licensePlate), source: 'BACKFILL' });
    captured += 1;
  }

  const rails = await prisma.subscription.findMany({
    where: { mmgPayerMsisdn: { not: null } },
    select: {
      mmgPayerMsisdn: true,
      rider: { select: { userId: true } },
      driver: { select: { userId: true } },
      vendor: { select: { owner: { select: { userId: true } } } },
    },
  });
  for (const r of rails) {
    const userId = r.rider?.userId ?? r.driver?.userId ?? r.vendor?.owner.userId;
    if (!userId || !r.mmgPayerMsisdn) continue;
    const role = r.rider ? 'RIDER' : r.driver ? 'DRIVER' : 'VENDOR';
    await identity.capture({ accountId: userId, actorRole: role, type: 'MMG_PAYER', normalizedValue: normalizePhone(r.mmgPayerMsisdn), source: 'BACKFILL' });
    captured += 1;
  }

  // The report: every cluster holding MORE THAN ONE account, with the
  // evidence and any trial grants — the founder reads this before anything
  // gets enforced on historical accounts.
  const multi = await prisma.identityClusterMember.groupBy({
    by: ['clusterId'],
    _count: { accountId: true },
    having: { accountId: { _count: { gt: 1 } } },
  });
  const clusters: BackfillReport['clusters'] = [];
  for (const c of multi) {
    const members = await prisma.identityClusterMember.findMany({ where: { clusterId: c.clusterId } });
    const memberUsers = await prisma.user.findMany({
      where: { id: { in: members.map((m) => m.accountId) } },
      select: { id: true, phone: true, firstName: true, lastName: true, roles: true },
    });
    const grants = await prisma.trialGrant.findMany({
      where: { clusterId: c.clusterId },
      select: { role: true, status: true, accountId: true },
    });
    clusters.push({
      clusterId: c.clusterId,
      members: memberUsers.map((u) => ({
        accountId: u.id, phone: u.phone,
        name: `${u.firstName} ${u.lastName}`.trim(),
        roles: u.roles.map(String),
      })),
      evidence: members.flatMap((m) => (Array.isArray(m.linkedVia) ? (m.linkedVia as unknown[]) : [])),
      trialGrants: grants,
    });
  }

  const report: BackfillReport = {
    scanned: { users: users.length, drivers: drivers.length, mmgRails: rails.length },
    captured,
    clusters,
  };
  log().info({ scanned: report.scanned, captured, multiAccountClusters: clusters.length }, 'identity backfill complete');
  return report;
  });
}
