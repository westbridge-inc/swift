import { Prisma, type PrismaClient, type IdentitySignalType, type SignalStrength } from '@prisma/client';
import { hashSignal } from './normalize';
import { log } from '../../utils/logger';
import { runWithoutTenant } from '../../plugins/tenant-context';

// The identity-resolution engine (trial-integrity spec §2). Signals are
// captured SILENTLY (zero UX change); HARD/STRONG matches union clusters
// (union-find via mergedIntoId, evidence written into linkedVia); SOFT
// signals NEVER merge and NEVER enforce — they only score and flag for human
// eyes. Matching is platform-wide across tenants by design (the ONE
// sanctioned cross-tenant system; founder-only visibility, audited reads).
//
// Retroactive law (§3.4), mechanically enforced at union time: when two
// clusters merge and BOTH hold a trial grant for the same (tenant, role), the
// EARLIEST grant survives and later ACTIVE grants are REVOKED with the
// 48-hour-notice reason — never an instant suspension. The @@unique on
// TrialGrant is the last line of defense either way.

export const SIGNAL_STRENGTH: Record<IdentitySignalType, SignalStrength> = {
  ID_DOC_NUMBER: 'HARD',
  DOC_CONTENT: 'HARD', // [DOC-INV-11] the same bytes on two accounts is one person, or one forged document
  TIN: 'HARD',
  BUSINESS_REG: 'HARD',
  PLATE: 'HARD',
  MMG_PAYER: 'HARD',
  FACE_EMBEDDING: 'STRONG',
  PHONE: 'STRONG',
  DEVICE: 'SOFT',
  IP_SUBNET: 'SOFT',
  ADDRESS: 'SOFT',
  NAME_DOB: 'SOFT',
  EMAIL: 'SOFT',
};

export interface CaptureInput {
  accountId: string;
  actorRole: string;
  type: IdentitySignalType;
  /** ALREADY-NORMALIZED value (callers use the normalize.ts helpers). */
  normalizedValue: string;
  source: string;
}

export interface CaptureResult {
  strength: SignalStrength;
  matchedAccountIds: string[];
  merged: boolean;
  clusterId: string | null;
  /** [F-022-14] true when the write barrier refused the capture (deletion-
   *  terminal account) — distinct from a genuine empty-match result. */
  dropped?: boolean;
}

/** All account ids sharing the caller's identity cluster (self included; just
 *  [accountId] when unclustered). The standalone shape consumers gate with —
 *  promos, referrals, cash-risk — without constructing the service. */
/** The root of an account's identity cluster after merges, or null when the
 *  account was never clustered. ONE walk — clusterMemberIds and the velocity
 *  engine (ALG-38) both read it, so "the same person" has one definition. */
export async function clusterRootId(prisma: PrismaClient, accountId: string): Promise<string | null> {
  const member = await prisma.identityClusterMember.findUnique({ where: { accountId }, select: { clusterId: true } });
  if (!member) return null;
  let root = member.clusterId;
  for (let hops = 0; hops < 32; hops += 1) {
    const c = await prisma.identityCluster.findUnique({ where: { id: root }, select: { mergedIntoId: true } });
    if (!c?.mergedIntoId) break;
    root = c.mergedIntoId;
  }
  return root;
}

export async function clusterMemberIds(prisma: PrismaClient, accountId: string): Promise<string[]> {
  const root = await clusterRootId(prisma, accountId);
  if (!root) return [accountId];
  const members = await prisma.identityClusterMember.findMany({ where: { clusterId: root }, select: { accountId: true } });
  return members.length > 0 ? members.map((m) => m.accountId) : [accountId];
}

export class IdentityService {
  constructor(private prisma: PrismaClient) {}

  /** §2.3 — normalize→hash→insert→match→(HARD/STRONG) union. Never throws
   *  into the caller's flow: identity capture must not break signup or
   *  verification; failures are logged loudly instead. */
  async capture(input: CaptureInput): Promise<CaptureResult> {
    const strength = SIGNAL_STRENGTH[input.type];
    const valueHash = hashSignal(input.normalizedValue);
    try {
      // Identity matching and union reconciliation is the single sanctioned
      // cross-tenant subsystem. It must never inherit a request's tenant ORM
      // predicate: doing so can re-point global cluster membership while
      // leaving another tenant's TrialGrant stranded on the tombstoned loser.
      // The account row is also the authority for capture provenance; callers
      // cannot accidentally (or deliberately) stamp a foreign/default tenant.
      return await runWithoutTenant(() => this.prisma.$transaction(async (tx) => {
        // Serialize the first capture of one normalized signal across every
        // API node. Without this lock, two simultaneous accounts can each
        // insert an uncommitted key, miss the other in their peer query, and
        // both begin trials before a later recapture finally merges them.
        await tx.$queryRaw<Array<{ locked: string }>>`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`identity:${input.type}:${valueHash}`}, 0)
          )::text AS locked
        `;

        // [NR-3 gap 3, REPORT-022 F-022-10] The account read takes FOR SHARE so
        // this capture SERIALIZES against deletion's FOR UPDATE row lock — a
        // capture that observed ACTIVE cannot insert after the purge commits.
        const locked = await tx.$queryRaw<{ tenantId: string; status: string }[]>(
          Prisma.sql`SELECT "tenantId", status FROM users WHERE id = ${input.accountId} FOR SHARE`,
        );
        const account = locked[0];
        if (!account) throw new Error(`Identity capture account not found: ${input.accountId}`);
        // Deny-list, not ACTIVE-only: PENDING_VERIFICATION captures are the
        // point of onboarding [F-022-13].
        if (['DEACTIVATED', 'BANNED', 'SUSPENDED'].includes(account.status)) {
          // Honest refusal — callers can tell a dropped capture from a real
          // no-match [F-022-14].
          return { strength, matchedAccountIds: [], merged: false, clusterId: null, dropped: true } as CaptureResult;
        }

        // Idempotent per (account, type, hash) — recaptures are no-ops.
        const existing = await tx.identityKey.findFirst({
          where: { accountId: input.accountId, type: input.type, valueHash },
          select: { id: true, tenantId: true },
        });
        if (!existing) {
          await tx.identityKey.create({
            data: {
              type: input.type, valueHash, accountId: input.accountId,
              tenantId: account.tenantId, actorRole: input.actorRole, source: input.source,
            },
          });
        } else if (existing.tenantId !== account.tenantId) {
          // Repair rows written by the former hard-coded swift-default caller.
          // User tenant ownership is the authority for this capture-provenance
          // field; the graph itself remains platform-global.
          await tx.identityKey.update({
            where: { id: existing.id },
            data: { tenantId: account.tenantId },
          });
        }

        const peers = await tx.identityKey.findMany({
          where: { type: input.type, valueHash, accountId: { not: input.accountId } },
          select: { accountId: true },
          distinct: ['accountId'],
        });
        const matchedAccountIds = peers.map((p) => p.accountId);
        if (matchedAccountIds.length === 0 || strength === 'SOFT') {
          // SOFT matches never merge (§0.3) — the guardrail is structural:
          // this branch is the ONLY exit for SOFT, and it cannot union.
          return { strength, matchedAccountIds, merged: false, clusterId: await this.clusterIdOf(tx, input.accountId) };
        }

        // HARD/STRONG: union this account's cluster with every matched peer's.
        let rootId = await this.ensureCluster(tx, input.accountId, {
          type: input.type, strength, matchedAccountId: matchedAccountIds[0]!, at: new Date().toISOString(),
        });
        for (const peer of matchedAccountIds) {
          const peerRoot = await this.ensureCluster(tx, peer, {
            type: input.type, strength, matchedAccountId: input.accountId, at: new Date().toISOString(),
          });
          if (peerRoot !== rootId) {
            rootId = await this.union(tx, rootId, peerRoot, {
              type: input.type, strength,
              accounts: [input.accountId, peer],
              at: new Date().toISOString(),
            });
          }
        }
        return { strength, matchedAccountIds, merged: true, clusterId: rootId };
      }));
    } catch (err) {
      log().error({ err, accountId: input.accountId, type: input.type }, 'identity capture failed — signal dropped, flow unaffected');
      return { strength, matchedAccountIds: [], merged: false, clusterId: null };
    }
  }

  /** Follow mergedIntoId to the root. Public resolver — everything trial-law
   *  reads goes through here. */
  async resolveCluster(accountId: string): Promise<string | null> {
    const member = await this.prisma.identityClusterMember.findUnique({ where: { accountId }, select: { clusterId: true } });
    if (!member) return null;
    return this.rootOf(this.prisma, member.clusterId);
  }

  /** §2.3 SOFT advisories — read-time only, human eyes only: ≥2 distinct SOFT
   *  signal types shared with accounts OUTSIDE this account's cluster. */
  async softAdvisories(accountId: string): Promise<Array<{ type: IdentitySignalType; sharedWithAccountId: string }>> {
    const mine = await this.prisma.identityKey.findMany({
      where: { accountId, type: { in: ['DEVICE', 'IP_SUBNET', 'ADDRESS', 'NAME_DOB', 'EMAIL'] } },
      select: { type: true, valueHash: true },
    });
    if (mine.length === 0) return [];
    const myCluster = await this.resolveCluster(accountId);
    const out: Array<{ type: IdentitySignalType; sharedWithAccountId: string }> = [];
    for (const key of mine) {
      const peers = await this.prisma.identityKey.findMany({
        where: { type: key.type, valueHash: key.valueHash, accountId: { not: accountId } },
        select: { accountId: true },
        distinct: ['accountId'],
        take: 20,
      });
      for (const p of peers) {
        const peerCluster = await this.resolveCluster(p.accountId);
        if (!myCluster || !peerCluster || peerCluster !== myCluster) {
          out.push({ type: key.type, sharedWithAccountId: p.accountId });
        }
      }
    }
    return out;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async rootOf(db: Prisma.TransactionClient | PrismaClient, clusterId: string): Promise<string> {
    let current = clusterId;
    for (let hops = 0; hops < 32; hops += 1) {
      const cluster = await db.identityCluster.findUnique({ where: { id: current }, select: { mergedIntoId: true } });
      if (!cluster?.mergedIntoId) return current;
      current = cluster.mergedIntoId;
    }
    return current; // depth cap — unions re-point members, so chains stay short
  }

  private async clusterIdOf(tx: Prisma.TransactionClient, accountId: string): Promise<string | null> {
    const m = await tx.identityClusterMember.findUnique({ where: { accountId }, select: { clusterId: true } });
    return m ? this.rootOf(tx, m.clusterId) : null;
  }

  /** Account's cluster, created on first HARD/STRONG involvement. */
  private async ensureCluster(tx: Prisma.TransactionClient, accountId: string, evidence: Record<string, unknown>): Promise<string> {
    const existing = await tx.identityClusterMember.findUnique({ where: { accountId }, select: { clusterId: true } });
    if (existing) return this.rootOf(tx, existing.clusterId);
    const cluster = await tx.identityCluster.create({ data: {} });
    await tx.identityClusterMember.create({
      data: { accountId, clusterId: cluster.id, linkedVia: [evidence] as never },
    });
    return cluster.id;
  }

  /** Union two roots. Older cluster wins as root (stable ids for the founder's
   *  tooling). Members re-point; the loser keeps mergedIntoId as history; and
   *  trial grants reconcile per the retroactive law BEFORE re-pointing so the
   *  (tenant, cluster, role) unique can never collide. */
  private async union(
    tx: Prisma.TransactionClient,
    aRootId: string,
    bRootId: string,
    evidence: Record<string, unknown>,
  ): Promise<string> {
    const [a, b] = await Promise.all([
      tx.identityCluster.findUniqueOrThrow({ where: { id: aRootId }, select: { id: true, createdAt: true } }),
      tx.identityCluster.findUniqueOrThrow({ where: { id: bRootId }, select: { id: true, createdAt: true } }),
    ]);
    const root = a.createdAt <= b.createdAt ? a.id : b.id;
    const loser = root === a.id ? b.id : a.id;

    // §3.4 retroactive reconcile: for every (tenant, role) held by BOTH sides,
    // the EARLIEST startedAt survives; later ACTIVE grants get REVOKED with
    // the 48h-notice reason. Never touches the surviving grant.
    const grants = await tx.trialGrant.findMany({
      where: { clusterId: { in: [root, loser] } },
      orderBy: { startedAt: 'asc' },
    });
    const seen = new Map<string, string>(); // (tenant|role) → surviving grant id
    for (const g of grants) {
      const key = `${g.tenantId}|${g.role}`;
      if (!seen.has(key)) {
        seen.set(key, g.id);
        continue;
      }
      if (g.status === 'ACTIVE') {
        await tx.trialGrant.update({
          where: { id: g.id },
          data: { status: 'REVOKED', statusReason: 'RETROACTIVE_DUPLICATE_48H_NOTICE' },
        });
        await tx.enforcementAction.create({
          data: {
            accountId: g.accountId,
            clusterId: root,
            level: 'DENY_TRIAL',
            reasonCode: 'RETROACTIVE_TRIAL_REVOKE',
            signalsFired: [evidence] as never,
            decidedBy: 'SYSTEM',
          },
        });
        log().warn({ grantId: g.id, accountId: g.accountId }, 'retroactive trial revoke (48h notice) on cluster union');
      } else {
        // CONSUMED/REVOKED duplicates just re-point; keep the earliest as canon.
        await tx.trialGrant.update({ where: { id: g.id }, data: { statusReason: g.statusReason ?? 'MERGED_DUPLICATE' } });
      }
    }
    // Re-point the loser's grants and members to the root, then tombstone it.
    await tx.trialGrant.updateMany({ where: { clusterId: loser }, data: { clusterId: root } });
    const movingMembers = await tx.identityClusterMember.findMany({ where: { clusterId: loser } });
    for (const m of movingMembers) {
      const linked = Array.isArray(m.linkedVia) ? (m.linkedVia as unknown[]) : [];
      await tx.identityClusterMember.update({
        where: { accountId: m.accountId },
        data: { clusterId: root, linkedVia: [...linked, evidence] as never },
      });
    }
    await tx.identityCluster.update({ where: { id: loser }, data: { mergedIntoId: root } });
    return root;
  }
}
