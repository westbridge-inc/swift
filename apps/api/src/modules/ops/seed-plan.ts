import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { targetFingerprint, type Approval, type TargetFingerprint } from './purge-plan';
import { seedPlanCounter } from '../../plugins/observability';

// ---------------------------------------------------------------------------
// [R048-005] PRODUCTION SEEDING IS A VERSIONED, APPROVED CONFIG CHANGE.
//
// The platform seed created schema objects by raw DDL outside the migration
// ledger, upserted policy rows (fees, FX, thresholds, document checklists,
// zones, market activation) with destructive `update` values, in many
// statements that raced with a second seeder, and the production seed could
// mint a SUPER_ADMIN from one environment variable with no ceremony.
//
// Now the seed is a PLAN: the desired configuration is data with a version;
// a plan is the diff between that data and the target database, bound to the
// database's own deployment identity and digested; applying it recomputes the
// diff (drift refuses), verifies the digest (tampering refuses), requires two
// distinct approvals on a production target, takes an advisory lock so two
// seeders serialise, writes every change in ONE transaction, and records the
// config version, the digest, the approvers and the change cardinality in
// the privileged-change audit. A replay with nothing to change changes
// nothing and says so. Schema objects come only from migrations; the seed
// holds none. The first SUPER_ADMIN is minted only while none exists, or by
// break-glass with two people.
// ---------------------------------------------------------------------------

export class SeedRefused extends Error {
  constructor(readonly code: string, message: string) { super(`[${code}] ${message}`); this.name = 'SeedRefused'; }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}
const canonical = (v: unknown): string => JSON.stringify(sortKeys(v));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (secret: string, s: string) => createHmac('sha256', secret).update(s).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The desired state, as data. Every table the seed may write is listed here;
 *  anything else the seed cannot touch. */
export interface DesiredConfig {
  /** Bumped by hand when the values change; recorded with every apply. */
  version: string;
  platformConfig: Array<{ key: string; value: Prisma.InputJsonValue }>;
  /** Keyed by country code; `create` holds the full row, `policy` the fields a plan may change. */
  countries: Array<{ code: string; create: Record<string, unknown>; policy: Record<string, unknown> }>;
  /** Create-if-missing only: zones are operational state once they exist. */
  zones: Array<{ id: string; create: Record<string, unknown> }>;
  /** Create-if-missing only, per (tenant, key). */
  algoConfig: Array<{ tenantId: string; key: string; value: Prisma.InputJsonValue; founderGated: boolean; updatedBy: string }>;
  /** Create-if-missing only, per (from, to). */
  zoneFares: Array<{ fromZoneId: string; toZoneId: string; fare: number }>;
}

export type Change =
  | { table: 'platformConfig'; key: string; op: 'create' | 'update'; from: unknown; to: unknown }
  | { table: 'countryConfig'; key: string; field: string; op: 'create' | 'update'; from: unknown; to: unknown }
  | { table: 'zone'; key: string; op: 'create' }
  | { table: 'algoConfig'; key: string; op: 'create' }
  | { table: 'zoneFare'; key: string; op: 'create' };

export interface SeedPlan {
  version: 1;
  configVersion: string;
  /** The digest of the desired data itself, so a plan names exactly which configuration it applies. */
  configDigest: string;
  createdAt: string;
  target: TargetFingerprint;
  changes: Change[];
  digest: string;
}

export function seedPlanDigest(body: Omit<SeedPlan, 'digest'>): string { return sha256(canonical(body)); }

const equalJson = (a: unknown, b: unknown): boolean => canonical(normalise(a)) === canonical(normalise(b));
/** Decimal columns come back as Prisma Decimal objects; compare by number/string value. */
function normalise(v: unknown): unknown {
  if (v && typeof v === 'object' && typeof (v as { toNumber?: unknown }).toNumber === 'function') return Number((v as { toNumber: () => number }).toNumber());
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(normalise);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, normalise(x)]));
  return v;
}

/** The diff between the desired data and the database. Read-only. */
export async function diffDesired(prisma: PrismaClient, desired: DesiredConfig): Promise<Change[]> {
  const changes: Change[] = [];
  for (const c of desired.platformConfig) {
    const row = await prisma.platformConfig.findUnique({ where: { key: c.key }, select: { value: true } });
    if (!row) changes.push({ table: 'platformConfig', key: c.key, op: 'create', from: null, to: c.value });
    else if (!equalJson(row.value, c.value)) changes.push({ table: 'platformConfig', key: c.key, op: 'update', from: row.value, to: c.value });
  }
  for (const c of desired.countries) {
    const row = await prisma.countryConfig.findUnique({ where: { code: c.code } });
    if (!row) { changes.push({ table: 'countryConfig', key: c.code, field: '*', op: 'create', from: null, to: c.create }); continue; }
    for (const [field, to] of Object.entries(c.policy)) {
      const from = (row as unknown as Record<string, unknown>)[field];
      if (!equalJson(from, to)) changes.push({ table: 'countryConfig', key: c.code, field, op: 'update', from: normalise(from), to });
    }
  }
  for (const z of desired.zones) {
    const row = await prisma.zone.findUnique({ where: { id: z.id }, select: { id: true } });
    if (!row) changes.push({ table: 'zone', key: z.id, op: 'create' });
  }
  for (const a of desired.algoConfig) {
    const row = await prisma.algoConfig.findFirst({ where: { tenantId: a.tenantId, key: a.key }, select: { id: true } });
    if (!row) changes.push({ table: 'algoConfig', key: `${a.tenantId}/${a.key}`, op: 'create' });
  }
  for (const f of desired.zoneFares) {
    const row = await prisma.zoneFare.findFirst({ where: { fromZoneId: f.fromZoneId, toZoneId: f.toZoneId }, select: { id: true } });
    if (!row) changes.push({ table: 'zoneFare', key: `${f.fromZoneId}>${f.toZoneId}`, op: 'create' });
  }
  return changes;
}

/** Plan: the target, the desired data's digest, the diff — digested together. */
export async function buildSeedPlan(prisma: PrismaClient, databaseUrl: string, desired: DesiredConfig, now = new Date()): Promise<SeedPlan> {
  const target = await targetFingerprint(prisma, databaseUrl);
  const changes = await diffDesired(prisma, desired);
  const body = { version: 1 as const, configVersion: desired.version, configDigest: sha256(canonical(desired)), createdAt: now.toISOString(), target, changes };
  return { ...body, digest: seedPlanDigest(body) };
}

export function signSeedApproval(secret: string, approver: string, planDigest: string): Approval {
  return { approver, signature: hmac(secret, `seed-approve:${approver}:${planDigest}`) };
}
function verifySeedApprovals(secret: string, digest: string, approvals: Approval[]): string[] {
  if (approvals.length < 2) throw new SeedRefused('APPROVALS_REQUIRED', 'a production configuration change needs two independent approvals');
  const names = new Set(approvals.map((a) => a.approver.trim().toLowerCase()));
  if (names.size < 2) throw new SeedRefused('APPROVERS_NOT_DISTINCT', 'the approvers must be two different people');
  for (const a of approvals) {
    if (!a.approver.trim() || !same(a.signature, hmac(secret, `seed-approve:${a.approver}:${digest}`))) throw new SeedRefused('APPROVAL_INVALID', `approval by ${a.approver || '?'} does not sign this plan`);
  }
  return approvals.map((a) => a.approver);
}

export interface ApplyOptions {
  /** Required on a production target: two distinct approvals over the plan digest, and the secret they were signed with. */
  approvals?: Approval[];
  secret?: string;
  actor?: string;
  /** Test seam: a pause at a named boundary inside the transaction (the race proof holds both seeders here). */
  failpoint?: (boundary: string) => Promise<void>;
}
export interface ApplyResult { applied: number; noop: boolean; configVersion: string; digest: string }

const audit = (tx: Prisma.TransactionClient | PrismaClient, plan: SeedPlan, event: string, detail: Record<string, unknown>, actor?: string) =>
  tx.privilegedChangeAudit.create({ data: { action: 'SEED_CONFIG', planDigest: plan.digest, event, target: plan.target as unknown as Prisma.InputJsonValue, detail: detail as Prisma.InputJsonValue, actor: actor ?? null } });

/**
 * Apply an approved plan to the SAME target, or refuse before the first write:
 * the digest is recomputed (tampering), the target is re-fingerprinted
 * (another database), a production target needs two approvals, and inside
 * the transaction — under an advisory lock so two seeders serialise — the diff
 * is recomputed and must equal the plan's (drift). Every change lands in that
 * one transaction with the audit row, or nothing does.
 */
export async function applySeedPlan(prisma: PrismaClient, databaseUrl: string, desired: DesiredConfig, plan: SeedPlan, opts: ApplyOptions = {}): Promise<ApplyResult> {
  const { digest: carried, ...body } = plan;
  if (seedPlanDigest(body) !== carried) { seedPlanCounter.labels('refused_tampered').inc(); throw new SeedRefused('PLAN_TAMPERED', 'the plan body does not match its digest'); }
  if (plan.configDigest !== sha256(canonical(desired))) { seedPlanCounter.labels('refused_config_mismatch').inc(); throw new SeedRefused('CONFIG_MISMATCH', `the plan was built for configuration ${plan.configVersion}; the code now holds different desired data — plan again`); }
  const target = await targetFingerprint(prisma, databaseUrl);
  if (target.digest !== plan.target.digest) { seedPlanCounter.labels('refused_target').inc(); throw new SeedRefused('TARGET_MISMATCH', `this database (${target.database} on ${target.host}, ${target.deploymentId}/${target.environment}) is not the plan's target`); }
  if (target.environment === 'unknown') { seedPlanCounter.labels('refused_target').inc(); throw new SeedRefused('TARGET_UNKNOWN', 'the database declares no deployment identity; bootstrap it first'); }
  let approvers: string[] = [];
  if (target.environment === 'production') {
    if (!opts.secret) throw new SeedRefused('APPROVALS_REQUIRED', 'a production configuration change needs two independent approvals');
    approvers = verifySeedApprovals(opts.secret, plan.digest, opts.approvals ?? []);
  }
  if (plan.changes.length === 0) {
    await audit(prisma, plan, 'NOOP', { configVersion: plan.configVersion, approvers }, opts.actor);
    seedPlanCounter.labels('noop').inc();
    return { applied: 0, noop: true, configVersion: plan.configVersion, digest: plan.digest };
  }
  let applied: number;
  try {
    applied = await runPlanTransaction(prisma, desired, plan, approvers, opts);
  } catch (err) {
    if (err instanceof SeedRefused && err.code === 'PLAN_DRIFT') {
      const drift = err as SeedRefused & { planned?: number; current?: number };
      await audit(prisma, plan, 'REFUSED_DRIFT', { planned: drift.planned ?? plan.changes.length, current: drift.current ?? -1 }, opts.actor);
      seedPlanCounter.labels('refused_drift').inc();
    }
    throw err;
  }
  seedPlanCounter.labels('applied').inc();
  return { applied, noop: false, configVersion: plan.configVersion, digest: plan.digest };
}

async function runPlanTransaction(prisma: PrismaClient, desired: DesiredConfig, plan: SeedPlan, approvers: string[], opts: ApplyOptions): Promise<number> {
  return prisma.$transaction(async (tx) => {
    // two seeders serialise here; the loser then sees the winner's writes as drift and is refused
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('swift:seed-plan'))`;
    const fresh = await diffDesired(tx as unknown as PrismaClient, desired);
    if (canonical(fresh) !== canonical(plan.changes)) {
      // the refusal rolls this transaction back, so its audit row is written OUTSIDE it, below
      throw Object.assign(new SeedRefused('PLAN_DRIFT', 'the database changed since the plan was built; plan again'), { planned: plan.changes.length, current: fresh.length });
    }
    await opts.failpoint?.('after-drift-check');
    for (const ch of plan.changes) {
      if (ch.table === 'platformConfig') {
        const want = desired.platformConfig.find((c) => c.key === ch.key)!;
        await tx.platformConfig.upsert({ where: { key: ch.key }, update: { value: want.value }, create: { key: ch.key, value: want.value } });
      } else if (ch.table === 'countryConfig') {
        const want = desired.countries.find((c) => c.code === ch.key)!;
        if (ch.op === 'create') await tx.countryConfig.create({ data: { code: ch.key, ...(want.create as object) } as never });
        else await tx.countryConfig.update({ where: { code: ch.key }, data: { [ch.field]: want.policy[ch.field] } as never });
      } else if (ch.table === 'zone') {
        const want = desired.zones.find((z) => z.id === ch.key)!;
        await tx.zone.create({ data: { id: ch.key, ...(want.create as object) } as never });
      } else if (ch.table === 'algoConfig') {
        const [tenantId, key] = ch.key.split('/') as [string, string];
        const want = desired.algoConfig.find((a) => a.tenantId === tenantId && a.key === key)!;
        await tx.algoConfig.create({ data: { tenantId, key, value: want.value, version: 1, founderGated: want.founderGated, updatedBy: want.updatedBy } });
      } else {
        const [fromZoneId, toZoneId] = ch.key.split('>') as [string, string];
        const want = desired.zoneFares.find((f) => f.fromZoneId === fromZoneId && f.toZoneId === toZoneId)!;
        await tx.zoneFare.create({ data: { fromZoneId, toZoneId, fare: want.fare } });
      }
    }
    await audit(tx, plan, 'APPLIED', { configVersion: plan.configVersion, configDigest: plan.configDigest, approvers, changes: plan.changes.length, tables: [...new Set(plan.changes.map((c) => c.table))] }, opts.actor);
    return plan.changes.length;
  });
}

// ---------------------------------------------------------------------------
// The first SUPER_ADMIN: bootstrap-only, else break-glass with two people
// ---------------------------------------------------------------------------

export interface PromoteOptions { secret?: string; approvals?: Approval[]; actor?: string }

export function signPromotionApproval(secret: string, approver: string, targetDigest: string, phone: string): Approval {
  return { approver, signature: hmac(secret, `promote-approve:${approver}:${targetDigest}:${phone}`) };
}

/**
 * Mint or restore the platform's SUPER_ADMIN. Allowed without ceremony only
 * while NO super-admin exists (bootstrap); afterwards it is a break-glass
 * change needing two distinct approvals signed over this target and this
 * phone. Either way it is a durable, audited change — never a silent upsert.
 */
export async function promoteBootstrapAdmin(prisma: PrismaClient, databaseUrl: string, phone: string, opts: PromoteOptions = {}): Promise<{ userId: string; mode: 'bootstrap' | 'break-glass' }> {
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) throw new SeedRefused('PHONE_INVALID', 'the admin phone must be E.164');
  const target = await targetFingerprint(prisma, databaseUrl);
  if (target.environment === 'unknown') throw new SeedRefused('TARGET_UNKNOWN', 'the database declares no deployment identity; bootstrap it first');
  const existing = await prisma.user.count({ where: { roles: { has: 'SUPER_ADMIN' } } });
  let mode: 'bootstrap' | 'break-glass' = 'bootstrap';
  let approvers: string[] = [];
  if (existing > 0) {
    mode = 'break-glass';
    const approvals = opts.approvals ?? [];
    if (!opts.secret || approvals.length < 2) { seedPlanCounter.labels('promotion_refused').inc(); throw new SeedRefused('BREAK_GLASS_REQUIRED', `a SUPER_ADMIN already exists (${existing}); promoting another is a break-glass change needing two approvals`); }
    const names = new Set(approvals.map((a) => a.approver.trim().toLowerCase()));
    if (names.size < 2) { seedPlanCounter.labels('promotion_refused').inc(); throw new SeedRefused('APPROVERS_NOT_DISTINCT', 'the approvers must be two different people'); }
    for (const a of approvals) {
      if (!same(a.signature, hmac(opts.secret, `promote-approve:${a.approver}:${target.digest}:${phone}`))) { seedPlanCounter.labels('promotion_refused').inc(); throw new SeedRefused('APPROVAL_INVALID', `approval by ${a.approver || '?'} does not sign this promotion`); }
    }
    approvers = approvals.map((a) => a.approver);
  }
  const digest = sha256(canonical({ target: target.digest, phone, mode }));
  const user = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('swift:seed-plan'))`;
    if (mode === 'bootstrap' && (await tx.user.count({ where: { roles: { has: 'SUPER_ADMIN' } } })) > 0) throw new SeedRefused('BREAK_GLASS_REQUIRED', 'a SUPER_ADMIN appeared while bootstrapping; this is now a break-glass change');
    const u = await tx.user.upsert({
      where: { phone },
      update: { roles: { set: ['SUPER_ADMIN', 'CUSTOMER'] }, activeRole: 'SUPER_ADMIN', status: 'ACTIVE' },
      create: { phone, firstName: 'Swift', lastName: 'Admin', roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } } },
      select: { id: true },
    });
    await tx.privilegedChangeAudit.create({ data: { action: 'PROMOTE_SUPER_ADMIN', planDigest: digest, event: 'APPLIED', target: target as unknown as Prisma.InputJsonValue, detail: { mode, approvers, userId: u.id } as Prisma.InputJsonValue, actor: opts.actor ?? null } });
    return u;
  });
  seedPlanCounter.labels(mode === 'bootstrap' ? 'promotion_bootstrap' : 'promotion_break_glass').inc();
  return { userId: user.id, mode };
}
