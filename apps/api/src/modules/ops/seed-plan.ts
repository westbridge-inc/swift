import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { targetFingerprint, type TargetFingerprint } from './purge-plan';
import { seedPlanCounter } from '../../plugins/observability';
import {
  approvalRequest, consumeApprovals, parseApproverKeys, promotionSubject, verifyApprovals,
  type RequestFacts, type SignedApproval, type VerifiedApproval,
} from './approver-signatures';

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
// holds none. The first SUPER_ADMIN is minted only while none exists — on a
// production target only by the signed plan that names it — or by
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
  /** When this plan was built — printed for the operators, never digested (see seedPlanDigest). */
  createdAt: string;
  target: TargetFingerprint;
  changes: Change[];
  digest: string;
}

export function seedPlanDigest(body: Omit<SeedPlan, 'digest'>): string {
  // [DS110 #17] `createdAt` is ceremony display metadata, not plan content.
  // Nothing persists a seed plan between runs: the ceremony prints the digest
  // and exits, the operators sign it, and the re-run REBUILDS the plan with a
  // fresh `now`. Digesting the timestamp made every re-run digest differ from
  // the signed one, so a production target could never pass its two-approver
  // check (APPROVAL_INVALID, forever) and the spine could never be applied.
  // The digest covers what the approvers are actually approving — the plan
  // version, the configuration and its digest, the target database and the
  // exact changes — and nothing that varies between two honest runs.
  const stable: Omit<SeedPlan, 'digest' | 'createdAt'> = {
    version: body.version,
    configVersion: body.configVersion,
    configDigest: body.configDigest,
    target: body.target,
    changes: body.changes,
  };
  return sha256(canonical(stable));
}

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

/**
 * [PROD-PATH] The facts outside the plan's own data that the approvers must
 * see and sign with it: the FX rate the operator recorded for this seed, and
 * the phone that becomes the first SUPER_ADMIN (shown by its last four digits;
 * the request carries only its hash).
 */
export interface RequestContext { fxGydPerUsd?: number | null; adminPhone?: string | null }

const E164 = /^\+[1-9]\d{6,14}$/;
/** A value as the approver reads it: whole while short; a long one as its head,
 *  length and digest (the plan digest and the server's rebuild bind it whole). */
function shown(v: unknown): string {
  const text = JSON.stringify(v) ?? 'null';
  return text.length <= 200 ? text : `${text.slice(0, 120)}… (${text.length} chars, sha256 ${sha256(text).slice(0, 16)})`;
}
const databaseLine = (t: TargetFingerprint) => `database: ${t.database} on ${t.host}, deployment ${t.deploymentId} (${t.environment})`;
const phoneTail = (phone: string) => phone.slice(-4);

/** The words an approver reads for this plan, in order, every change listed. */
export function planRequestFacts(plan: SeedPlan, ctx: RequestContext = {}): RequestFacts {
  if (ctx.adminPhone && !E164.test(ctx.adminPhone)) throw new SeedRefused('PHONE_INVALID', 'the admin phone must be E.164');
  const fx = ctx.fxGydPerUsd ?? null;
  const shows = [
    databaseLine(plan.target),
    `config: ${plan.configVersion} (${plan.configDigest.slice(0, 16)}), ${plan.changes.length} change${plan.changes.length === 1 ? '' : 's'}, FX ${fx === null ? 'not set' : `${fx} GYD per USD`}`,
    `admin phone: ${ctx.adminPhone ? `ending ${phoneTail(ctx.adminPhone)} becomes the first SUPER_ADMIN if there is none` : 'none'}`,
    ...plan.changes.map((ch) => {
      const where = ch.table === 'countryConfig' ? `${ch.table} ${ch.key}.${ch.field}` : `${ch.table} ${ch.key}`;
      return 'from' in ch ? `change: ${ch.op} ${where}: ${shown(ch.from)} -> ${shown(ch.to)}` : `change: ${ch.op} ${where}`;
    }),
  ];
  return { change: 'plan', target: plan.target.digest, subject: plan.digest, admin: ctx.adminPhone ? promotionSubject(ctx.adminPhone) : 'none', shows };
}

/**
 * [PROD-PATH] What the approvers sign for a production apply of this plan:
 * the plan digest on this target and the first admin's phone hash, with what
 * they are approving in words (the database, the configuration and FX rate,
 * the admin phone's last digits, every change), issued now and valid 24
 * hours, with a random nonce. Each approver signs it with their OWN key on
 * their own computer (deploy/seed-approve.sh); the server holds only their
 * public keys, and at apply it rebuilds these words and requires them exactly.
 */
export function planApprovalRequest(plan: SeedPlan, ctx: RequestContext = {}, now = new Date()): string {
  return approvalRequest(planRequestFacts(plan, ctx), now);
}

export interface ApplyOptions {
  /** Required on a production target: two approvals by two different pinned
   *  people over this plan (approver-signatures.ts), and the pinned keys. */
  approvals?: SignedApproval[];
  approverKeys?: string;
  /** The FX rate and first admin the approvals must name (planRequestFacts).
   *  On a production target the first SUPER_ADMIN is minted ONLY here, in the
   *  plan's own transaction, when the signed plan names this phone and no
   *  SUPER_ADMIN exists. */
  request?: RequestContext;
  /** The clock approvals are checked against (expiry). */
  now?: Date;
  actor?: string;
  /** Test seam: a pause at a named boundary inside the transaction (the race proof holds both seeders here). */
  failpoint?: (boundary: string) => Promise<void>;
}
export interface ApplyResult { applied: number; noop: boolean; configVersion: string; digest: string; firstAdmin: { userId: string } | null }

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
  let verified: VerifiedApproval[] = [];
  if (target.environment === 'production') {
    if (!opts.approvals?.length) throw new SeedRefused('APPROVALS_REQUIRED', 'a production configuration change needs two independent approvals');
    verified = verifyApprovals(opts.approvals, parseApproverKeys(opts.approverKeys), planRequestFacts(plan, opts.request), opts.now);
  }
  let applied: { count: number; firstAdmin: { userId: string } | null };
  try {
    applied = await runPlanTransaction(prisma, desired, plan, verified, opts);
  } catch (err) {
    if (err instanceof SeedRefused && err.code === 'PLAN_DRIFT') {
      const drift = err as SeedRefused & { planned?: number; current?: number };
      await audit(prisma, plan, 'REFUSED_DRIFT', { planned: drift.planned ?? plan.changes.length, current: drift.current ?? -1 }, opts.actor);
      seedPlanCounter.labels('refused_drift').inc();
    }
    throw err;
  }
  const noop = plan.changes.length === 0;
  seedPlanCounter.labels(noop ? 'noop' : 'applied').inc();
  return { applied: applied.count, noop, configVersion: plan.configVersion, digest: plan.digest, firstAdmin: applied.firstAdmin };
}

/** The account a SUPER_ADMIN promotion sets: roles SUPER_ADMIN and CUSTOMER. */
async function upsertSuperAdmin(tx: Prisma.TransactionClient, phone: string): Promise<{ id: string }> {
  return tx.user.upsert({
    where: { phone },
    update: { roles: { set: ['SUPER_ADMIN', 'CUSTOMER'] }, activeRole: 'SUPER_ADMIN', status: 'ACTIVE' },
    create: { phone, firstName: 'Swift', lastName: 'Admin', roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } } },
    select: { id: true },
  });
}

/**
 * [PROD-PATH] The first production SUPER_ADMIN, covered by the signed plan:
 * minted in the plan's transaction, after its approvals are consumed, only
 * when every approval names this phone and no SUPER_ADMIN exists yet.
 */
async function mintSignedFirstAdmin(tx: Prisma.TransactionClient, plan: SeedPlan, verified: VerifiedApproval[], opts: ApplyOptions): Promise<{ userId: string } | null> {
  const phone = opts.request?.adminPhone;
  if (plan.target.environment !== 'production' || !phone || verified.length < 2) return null;
  if (verified.some((v) => v.admin !== promotionSubject(phone))) return null;
  if ((await tx.user.count({ where: { roles: { has: 'SUPER_ADMIN' } } })) > 0) return null;
  const u = await upsertSuperAdmin(tx, phone);
  await tx.privilegedChangeAudit.create({ data: {
    action: 'PROMOTE_SUPER_ADMIN', planDigest: sha256(canonical({ target: plan.target.digest, phone, mode: 'signed-plan' })), event: 'APPLIED',
    target: plan.target as unknown as Prisma.InputJsonValue,
    detail: { mode: 'signed-plan', plan: plan.digest, approvers: verified.map((v) => v.approver), userId: u.id } as Prisma.InputJsonValue,
    actor: opts.actor ?? null,
  } });
  return { userId: u.id };
}

async function runPlanTransaction(prisma: PrismaClient, desired: DesiredConfig, plan: SeedPlan, verified: VerifiedApproval[], opts: ApplyOptions): Promise<{ count: number; firstAdmin: { userId: string } | null }> {
  const approvers = verified.map((v) => v.approver);
  return prisma.$transaction(async (tx) => {
    // two seeders serialise here; the loser then sees the winner's writes as drift and is refused
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('swift:seed-plan'))`;
    const fresh = await diffDesired(tx as unknown as PrismaClient, desired);
    if (canonical(fresh) !== canonical(plan.changes)) {
      // the refusal rolls this transaction back, so its audit row is written OUTSIDE it, below
      throw Object.assign(new SeedRefused('PLAN_DRIFT', 'the database changed since the plan was built; plan again'), { planned: plan.changes.length, current: fresh.length });
    }
    await opts.failpoint?.('after-drift-check');
    // [PROD-PATH] Single use, under the same lock as the change: an approval
    // already consumed is refused, even after a rollback of the data.
    if (plan.target.environment === 'production') await consumeApprovals(tx, verified, { action: 'SEED_CONFIG', target: plan.target as unknown as Prisma.InputJsonValue, actor: opts.actor });
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
    const firstAdmin = await mintSignedFirstAdmin(tx, plan, verified, opts);
    await audit(tx, plan, plan.changes.length === 0 ? 'NOOP' : 'APPLIED', { configVersion: plan.configVersion, configDigest: plan.configDigest, approvers, changes: plan.changes.length, tables: [...new Set(plan.changes.map((c) => c.table))], firstAdmin: !!firstAdmin }, opts.actor);
    return { count: plan.changes.length, firstAdmin };
  });
}

// ---------------------------------------------------------------------------
// The first SUPER_ADMIN: bootstrap-only, else break-glass with two people
// ---------------------------------------------------------------------------

export interface PromoteOptions { approvals?: SignedApproval[]; approverKeys?: string; actor?: string; now?: Date }

/** The words an approver reads for a break-glass promotion on this target. */
export function promotionRequestFacts(target: TargetFingerprint, phone: string): RequestFacts {
  return {
    change: 'promote', target: target.digest, subject: promotionSubject(phone), admin: promotionSubject(phone),
    shows: [databaseLine(target), `promote: the phone ending ${phoneTail(phone)} becomes SUPER_ADMIN (its roles are set to SUPER_ADMIN and CUSTOMER)`],
  };
}

/**
 * [PROD-PATH] What the two approvers sign for a break-glass promotion of
 * `phone` on THIS target: the target digest and the phone's hash (the request
 * never carries the number, only its last four digits in words), issued now
 * and valid 24 hours, with a random nonce. Read-only.
 */
export async function promotionApprovalRequest(prisma: PrismaClient, databaseUrl: string, phone: string, now = new Date()): Promise<string> {
  if (!E164.test(phone)) throw new SeedRefused('PHONE_INVALID', 'the admin phone must be E.164');
  const target = await targetFingerprint(prisma, databaseUrl);
  if (target.environment === 'unknown') throw new SeedRefused('TARGET_UNKNOWN', 'the database declares no deployment identity; bootstrap it first');
  return approvalRequest(promotionRequestFacts(target, phone), now);
}

/**
 * Mint or restore the platform's SUPER_ADMIN. Allowed without ceremony only
 * while NO super-admin exists (bootstrap) on a target that is not
 * production; on production the first SUPER_ADMIN is minted only by the
 * signed plan that names it (applySeedPlan). Afterwards it is a break-glass
 * change needing two distinct approvals signed over this target and this
 * phone. A phone that already holds SUPER_ADMIN changes nothing. Either way
 * it is a durable, audited change — never a silent upsert.
 */
export async function promoteBootstrapAdmin(prisma: PrismaClient, databaseUrl: string, phone: string, opts: PromoteOptions = {}): Promise<{ userId: string; mode: 'bootstrap' | 'break-glass' | 'already' }> {
  if (!E164.test(phone)) throw new SeedRefused('PHONE_INVALID', 'the admin phone must be E.164');
  const target = await targetFingerprint(prisma, databaseUrl);
  if (target.environment === 'unknown') throw new SeedRefused('TARGET_UNKNOWN', 'the database declares no deployment identity; bootstrap it first');
  const already = await prisma.user.findFirst({ where: { phone, roles: { has: 'SUPER_ADMIN' } }, select: { id: true } });
  if (already) return { userId: already.id, mode: 'already' };
  const existing = await prisma.user.count({ where: { roles: { has: 'SUPER_ADMIN' } } });
  let mode: 'bootstrap' | 'break-glass' = 'bootstrap';
  let verified: VerifiedApproval[] = [];
  if (existing === 0 && target.environment === 'production') {
    seedPlanCounter.labels('promotion_refused').inc();
    throw new SeedRefused('FIRST_ADMIN_NEEDS_PLAN', 'on production the first SUPER_ADMIN is minted only by the signed plan that names its phone (seed-production.sh with SEED_ADMIN_PHONE set when the request is printed)');
  }
  if (existing > 0) {
    mode = 'break-glass';
    const approvals = opts.approvals ?? [];
    if (approvals.length === 0) { seedPlanCounter.labels('promotion_refused').inc(); throw new SeedRefused('BREAK_GLASS_REQUIRED', `a SUPER_ADMIN already exists (${existing}); promoting another is a break-glass change needing two approvals`); }
    try {
      verified = verifyApprovals(approvals, parseApproverKeys(opts.approverKeys), promotionRequestFacts(target, phone), opts.now);
    } catch (err) {
      seedPlanCounter.labels('promotion_refused').inc();
      throw err;
    }
  }
  const approvers = verified.map((v) => v.approver);
  const digest = sha256(canonical({ target: target.digest, phone, mode }));
  const user = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('swift:seed-plan'))`;
    if (mode === 'bootstrap' && (await tx.user.count({ where: { roles: { has: 'SUPER_ADMIN' } } })) > 0) throw new SeedRefused('BREAK_GLASS_REQUIRED', 'a SUPER_ADMIN appeared while bootstrapping; this is now a break-glass change');
    // Break-glass: the two approvals are consumed before the account is
    // touched, in this transaction; fewer than two refuse (consumeApprovals).
    if (mode === 'break-glass') await consumeApprovals(tx, verified, { action: 'PROMOTE_SUPER_ADMIN', target: target as unknown as Prisma.InputJsonValue, actor: opts.actor });
    const u = await upsertSuperAdmin(tx, phone);
    await tx.privilegedChangeAudit.create({ data: { action: 'PROMOTE_SUPER_ADMIN', planDigest: digest, event: 'APPLIED', target: target as unknown as Prisma.InputJsonValue, detail: { mode, approvers, userId: u.id } as Prisma.InputJsonValue, actor: opts.actor ?? null } });
    return u;
  });
  seedPlanCounter.labels(mode === 'bootstrap' ? 'promotion_bootstrap' : 'promotion_break_glass').inc();
  return { userId: user.id, mode };
}
