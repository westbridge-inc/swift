import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';

/**
 * [SCR-001 / SCR-002] The demo purge as a privileged change workflow.
 *
 * Stop-ship register SCR-001: the purge tool deleted vendor and user graphs
 * after two typable confirmation strings; it never bound the target's
 * identity, needed no independent approval and no recovery evidence, and
 * could run against any database `DATABASE_URL` reached. SCR-002: its
 * "include unclassified" switch deleted every non-admin account — a negative
 * classification — bypassing the canonical deletion path and every hold.
 *
 * Now the purge is a PLAN and an EXECUTION, apart:
 *  · the plan binds the target's fingerprint (host, database, and the
 *    deployment identity the database itself declares), the classification
 *    counts and the exact ids, into one digest; production is denied by
 *    default and needs a time-bound break-glass approval;
 *  · execution needs two DISTINCT approvers over that digest, a backup
 *    manifest bound to the same target with tested-restore evidence, and an
 *    unchanged classification (drift invalidates the plan);
 *  · the selection is POSITIVE only — rows carrying a synthetic marker (the
 *    seed's run id or its phone range) and no admin role; anything under a
 *    legal hold is quarantined; unclassified rows are reported, never widened
 *    into a predicate;
 *  · every step is an append-only audit row written BEFORE the mutation it
 *    describes, so a death at any boundary leaves a resumable record;
 *  · deletion itself goes through the canonical account-deletion path the
 *    caller injects (the same one a person's own erasure uses); partner
 *    accounts, which that path refuses, are reported for the partner closure
 *    workflow — never hard-deleted here.
 */
export const DEMO_PHONE_PREFIX = '+592600';
export const SEED_RUN_ID = 'seed-demo';
export const PLAN_TTL_MS = 60 * 60_000;
export const BACKUP_MAX_AGE_MS = 24 * 3_600_000;

export interface TargetFingerprint { host: string; database: string; deploymentId: string; environment: string; digest: string }
export interface Approval { approver: string; signature: string }
export interface BackupManifest { targetDigest: string; takenAt: string; restoreVerifiedAt: string; artifactDigest: string }
export interface BreakGlass { expiresAt: string; signature: string }
export interface PurgePlan {
  version: 1;
  createdAt: string;
  expiresAt: string;
  target: TargetFingerprint;
  /** Present only on a scoped plan (a phone range inside the demo range); part of the digest. */
  scope?: PlanScope;
  counts: { total: number; admins: number; demoCustomers: number; demoPartners: number; quarantined: number; unclassified: number };
  demoCustomerIds: string[];
  demoPartnerIds: string[];
  quarantinedIds: string[];
  digest: string;
}
export class PurgeRefused extends Error { constructor(readonly code: string, message: string) { super(`[${code}] ${message}`); } }

/** Deep canonical JSON: every object's keys sorted, at every depth. (A key-array
 *  replacer only reaches the top level — nested objects such as the target,
 *  the counts and the scope serialised as `{}` and were outside the digest.) */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}
const canonical = (v: unknown): string => JSON.stringify(sortKeys(v));
/** The digest of a plan body — what the approvers sign and what execution recomputes. */
export function planDigest(body: Omit<PurgePlan, 'digest'>): string { return sha256(canonical(body)); }
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (secret: string, s: string) => createHmac('sha256', secret).update(s).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The target as the database itself reports it. An absent identity is 'unknown' — and refused. */
export async function targetFingerprint(prisma: PrismaClient, databaseUrl: string): Promise<TargetFingerprint> {
  const u = new URL(databaseUrl);
  const [server] = await prisma.$queryRaw<Array<{ database: string; addr: string | null }>>`SELECT current_database() AS database, host(inet_server_addr()) AS addr`;
  const identity = await prisma.deploymentIdentity.findUnique({ where: { id: 'singleton' } }).catch(() => null);
  const fp = { host: `${u.hostname}:${u.port || '5432'}${server?.addr ? `@${server.addr}` : ''}`, database: server?.database ?? u.pathname.replace(/^\//, ''), deploymentId: identity?.deploymentId ?? 'unknown', environment: identity?.environment ?? 'unknown' };
  return { ...fp, digest: sha256(canonical(fp)) };
}

export interface Classification { total: number; adminIds: string[]; demoCustomerIds: string[]; demoPartnerIds: string[]; quarantinedIds: string[]; unclassified: number }

/** An explicit, digest-bound selection boundary. The demo purge itself is
 *  unscoped (every marked row on the target); a scoped plan can only ever
 *  select INSIDE the ids it names, so a plan approved for a subset cannot be
 *  executed against the rest — and a test suite purges only what it created. */
export interface PlanScope { phonePrefix: string }
/** A scope can only NARROW the demo range — anything else is not a scope, it is a different purge. */
export function assertScope(scope: PlanScope | undefined): void {
  if (scope && !scope.phonePrefix.startsWith(DEMO_PHONE_PREFIX)) throw new PurgeRefused('SCOPE_INVALID', `a plan scope must lie inside the demo range ${DEMO_PHONE_PREFIX}…`);
}
const withinScope = (scope?: PlanScope) => (scope ? { phone: { startsWith: scope.phonePrefix } } : {});

/** POSITIVE selection only: a synthetic marker, no admin role. Holds quarantine. Unclassified is a number, never a predicate. */
export async function classify(prisma: PrismaClient, scope?: PlanScope): Promise<Classification> {
  assertScope(scope);
  const [total, admins, marked] = await Promise.all([
    prisma.user.count({ where: withinScope(scope) }),
    prisma.user.findMany({ where: { ...withinScope(scope), roles: { hasSome: ['ADMIN', 'SUPER_ADMIN'] } }, select: { id: true } }),
    prisma.user.findMany({ where: { ...withinScope(scope), OR: [{ syntheticRunId: { not: null } }, { phone: { startsWith: DEMO_PHONE_PREFIX } }] }, select: { id: true, roles: true } }),
  ]);
  const adminIds = new Set(admins.map((a) => a.id));
  const candidates = marked.filter((u) => !adminIds.has(u.id));
  const ids = candidates.map((u) => u.id);
  const held = ids.length === 0 ? [] : await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT u."id" FROM "users" u
    WHERE u."id" = ANY(${ids})
      AND (EXISTS (SELECT 1 FROM "IncidentCase" c WHERE c."legalHold" = true AND (c."subjectUserId" = u."id" OR c."reporterUserId" = u."id"))
        OR EXISTS (SELECT 1 FROM "EvidenceBundle" b WHERE b."legalHold" = true AND b."subjectUserId" = u."id")
        OR EXISTS (SELECT 1 FROM "doc_legal_hold" h WHERE h."releasedAt" IS NULL AND h."subjectUserId" = u."id"))`;
  const heldIds = new Set(held.map((h) => h.id));
  const free = candidates.filter((u) => !heldIds.has(u.id));
  return {
    total, adminIds: [...adminIds].sort(),
    demoCustomerIds: free.filter((u) => u.roles.every((r) => r === 'CUSTOMER')).map((u) => u.id).sort(),
    demoPartnerIds: free.filter((u) => u.roles.some((r) => r !== 'CUSTOMER')).map((u) => u.id).sort(),
    quarantinedIds: [...heldIds].sort(),
    unclassified: total - adminIds.size - marked.length,
  };
}

export async function buildPlan(prisma: PrismaClient, databaseUrl: string, now = new Date(), scope?: PlanScope): Promise<PurgePlan> {
  const target = await targetFingerprint(prisma, databaseUrl);
  const c = await classify(prisma, scope);
  const body = {
    version: 1 as const, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(), target,
    // the scope rides the digest: an approval signs the boundary too
    ...(scope ? { scope: { phonePrefix: scope.phonePrefix } } : {}),
    counts: { total: c.total, admins: c.adminIds.length, demoCustomers: c.demoCustomerIds.length, demoPartners: c.demoPartnerIds.length, quarantined: c.quarantinedIds.length, unclassified: c.unclassified },
    demoCustomerIds: c.demoCustomerIds, demoPartnerIds: c.demoPartnerIds, quarantinedIds: c.quarantinedIds,
  };
  const plan: PurgePlan = { ...body, digest: planDigest(body) };
  await audit(prisma, plan, 'PLANNED', { counts: plan.counts });
  return plan;
}

export function signApproval(secret: string, approver: string, planDigest: string): Approval {
  return { approver, signature: hmac(secret, `approve:${approver}:${planDigest}`) };
}
export function signBreakGlass(secret: string, planDigest: string, expiresAt: Date): BreakGlass {
  return { expiresAt: expiresAt.toISOString(), signature: hmac(secret, `break-glass:${planDigest}:${expiresAt.toISOString()}`) };
}
export function verifyApprovals(secret: string, plan: PurgePlan, approvals: Approval[]): void {
  if (approvals.length < 2) throw new PurgeRefused('APPROVALS_REQUIRED', 'two independent approvals are required');
  const names = new Set(approvals.map((a) => a.approver.trim().toLowerCase()));
  if (names.size < 2) throw new PurgeRefused('APPROVERS_NOT_DISTINCT', 'the approvers must be two different people');
  for (const a of approvals) {
    if (!a.approver.trim() || !same(a.signature, hmac(secret, `approve:${a.approver}:${plan.digest}`))) throw new PurgeRefused('APPROVAL_INVALID', `approval by ${a.approver || '?'} does not sign this plan`);
  }
}
export function verifyBackup(manifest: BackupManifest | null | undefined, plan: PurgePlan, now = new Date()): void {
  if (!manifest) throw new PurgeRefused('BACKUP_REQUIRED', 'a backup manifest bound to this target is required');
  if (manifest.targetDigest !== plan.target.digest) throw new PurgeRefused('BACKUP_WRONG_TARGET', 'the backup manifest is for another target');
  const taken = Date.parse(manifest.takenAt); const verified = Date.parse(manifest.restoreVerifiedAt);
  if (!Number.isFinite(taken) || !Number.isFinite(verified)) throw new PurgeRefused('BACKUP_UNVERIFIED', 'the backup has no tested-restore evidence');
  if (verified < taken) throw new PurgeRefused('BACKUP_UNVERIFIED', 'the restore test predates the backup');
  if (now.getTime() - taken > BACKUP_MAX_AGE_MS) throw new PurgeRefused('BACKUP_STALE', 'the backup is older than 24 hours');
  if (!/^[0-9a-f]{64}$/.test(manifest.artifactDigest)) throw new PurgeRefused('BACKUP_UNVERIFIED', 'the backup artifact has no digest');
}

async function audit(prisma: PrismaClient, plan: PurgePlan, event: string, detail?: Record<string, unknown>, actor?: string): Promise<void> {
  await prisma.privilegedChangeAudit.create({ data: { action: 'PURGE_DEMO', planDigest: plan.digest, event, target: plan.target as unknown as Prisma.InputJsonValue, detail: (detail ?? undefined) as Prisma.InputJsonValue | undefined, actor: actor ?? null } });
}

export interface ExecuteOptions {
  secret: string;
  approvals: Approval[];
  backup: BackupManifest | null | undefined;
  breakGlass?: BreakGlass | null;
  /** The canonical deletion path (a person's own erasure). Injected, never re-implemented here. */
  deleteUser: (userId: string) => Promise<void>;
  now?: Date;
  /** Test seam: a throw here is the process dying at that boundary. */
  failpoint?: (boundary: string, detail: Record<string, unknown>) => Promise<void>;
}
export interface ExecuteResult { deleted: string[]; skippedAlreadyGone: string[]; partnersReported: string[]; quarantined: string[] }

/** Execute an approved plan against the SAME target, or refuse before the first data query. Resumable: rows already gone are skipped. */
export async function executePlan(prisma: PrismaClient, databaseUrl: string, plan: PurgePlan, opts: ExecuteOptions): Promise<ExecuteResult> {
  const now = opts.now ?? new Date();
  // 0. the plan is what was signed: the digest is recomputed from the body, never trusted as carried.
  //    A body edited after approval (a widened scope, an added id) is not this plan.
  const { digest: carried, ...body } = plan;
  if (planDigest(body) !== carried) throw new PurgeRefused('PLAN_TAMPERED', 'the plan body does not match its digest; it was changed after it was planned');
  if (Date.parse(plan.expiresAt) < now.getTime()) throw new PurgeRefused('PLAN_EXPIRED', 'the plan has expired; plan again');
  // 1. the target, before anything else
  const target = await targetFingerprint(prisma, databaseUrl);
  if (target.digest !== plan.target.digest) throw new PurgeRefused('TARGET_MISMATCH', `this database (${target.database} on ${target.host}, ${target.deploymentId}/${target.environment}) is not the plan's target`);
  if (target.deploymentId === 'unknown' || target.environment === 'unknown') throw new PurgeRefused('TARGET_UNKNOWN', 'the database declares no deployment identity');
  if (target.environment === 'production') {
    const bg = opts.breakGlass;
    if (!bg) throw new PurgeRefused('PRODUCTION_DENIED', 'production is denied by default; a time-bound break-glass approval is required');
    if (Date.parse(bg.expiresAt) < now.getTime()) throw new PurgeRefused('BREAK_GLASS_EXPIRED', 'the break-glass approval has expired');
    if (!same(bg.signature, hmac(opts.secret, `break-glass:${plan.digest}:${bg.expiresAt}`))) throw new PurgeRefused('BREAK_GLASS_INVALID', 'the break-glass approval does not sign this plan');
  }
  // 2. the approvals and the recovery evidence
  verifyApprovals(opts.secret, plan, opts.approvals);
  verifyBackup(opts.backup, plan, now);
  // 3. the plan still describes the database (drift invalidates the approval)
  const fresh = await classify(prisma, plan.scope);
  const alreadyGone = plan.demoCustomerIds.filter((id) => !fresh.demoCustomerIds.includes(id));
  const survivors = fresh.demoCustomerIds.filter((id) => !plan.demoCustomerIds.includes(id));
  if (survivors.length > 0 || fresh.demoPartnerIds.join(',') !== plan.demoPartnerIds.join(',') || fresh.unclassified !== plan.counts.unclassified) {
    await audit(prisma, plan, 'REFUSED_DRIFT', { newDemoCustomers: survivors.length, demoPartners: fresh.demoPartnerIds.length, unclassified: fresh.unclassified });
    throw new PurgeRefused('PLAN_DRIFT', 'the database changed since the plan was approved; plan and approve again');
  }
  const existingAudit = await prisma.privilegedChangeAudit.findMany({ where: { planDigest: plan.digest, event: 'USER_DELETED' }, select: { detail: true } });
  const doneBefore = new Set(existingAudit.map((a) => String((a.detail as { userId?: string } | null)?.userId ?? '')));
  // 4. the immutable record, BEFORE the first mutation
  await audit(prisma, plan, existingAudit.length > 0 ? 'RESUMED' : 'STARTED', { approvers: opts.approvals.map((a) => a.approver), backup: opts.backup?.artifactDigest, breakGlass: Boolean(opts.breakGlass), resumingAfter: doneBefore.size }, opts.approvals.map((a) => a.approver).join('+'));
  await opts.failpoint?.('after-start', { plan: plan.digest });
  const deleted: string[] = [];
  try {
    for (const userId of plan.demoCustomerIds) {
      if (alreadyGone.includes(userId) || doneBefore.has(userId)) continue;
      await audit(prisma, plan, 'USER_DELETING', { userId });
      await opts.deleteUser(userId);
      await audit(prisma, plan, 'USER_DELETED', { userId });
      deleted.push(userId);
      await opts.failpoint?.('after-user', { userId });
    }
  } catch (err) {
    await audit(prisma, plan, 'FAILED', { deletedThisRun: deleted.length, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  await audit(prisma, plan, 'COMPLETED', { deleted: deleted.length, skippedAlreadyGone: alreadyGone.length + doneBefore.size, partnersReported: plan.demoPartnerIds.length, quarantined: plan.quarantinedIds.length });
  return { deleted, skippedAlreadyGone: [...alreadyGone, ...doneBefore], partnersReported: plan.demoPartnerIds, quarantined: plan.quarantinedIds };
}

/** [SCR-002] Synthetic markers are forbidden in production — a verify that boot and the purge share. */
export async function syntheticMarkersPresent(prisma: PrismaClient): Promise<number> {
  return prisma.user.count({ where: { OR: [{ syntheticRunId: { not: null } }, { phone: { startsWith: DEMO_PHONE_PREFIX } }] } });
}
