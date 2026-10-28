import { createHash, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { targetFingerprint, type TargetFingerprint } from './purge-plan';
import { seedPlanCounter } from '../../plugins/observability';
import { rescueIncentiveRefusal } from '../dispatch/rescue-incentive-guard';
import {
  approvalRequest, consumeApprovals, parseApproverKeys, promotionSubject, SOLO_DEFAULT_LIFETIME_MS, SOLO_SHOW_LINE, verifyApprovals, verifySoloApproval,
  SOLO_COOLING_OFF_MS, SOLO_RESEED_SHOW_LINE, verifySoloReseedApproval,
  type RequestFacts, type SignedApproval, type VerifiedApproval,
} from './approver-signatures';
import { approverRoster, emailChannelConfigured, guyanaTime, sendSoloEmail, sendSoloText } from '../admin/solo-approval';
import { soloQuietUntil } from '../admin/admin-email-change';
import { getChannels } from '../../providers/notifications/channels';
import { smsAccepted } from '../../providers/notifications/sms-outcome';
import { smsDestinationAllowed } from '../../utils/sms-budget';
import { generateOtp } from '../../utils/otp';
import { firstInvalidTwilioConfig } from '../../utils/twilio-identity';
import { isProduction } from '../../utils/runtime-mode';

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
/** [Row 208 guard] The installer never writes a rescue incentive: it stays 0
 *  until a payout path and a deletion block ship. Checked before anything else. */
function refuseLockedDials(desired: DesiredConfig): void {
  for (const a of desired.algoConfig) {
    const why = rescueIncentiveRefusal(a.key, a.value);
    if (why) throw new SeedRefused('RESCUE_INCENTIVE_LOCKED', why);
  }
}

export async function buildSeedPlan(prisma: PrismaClient, databaseUrl: string, desired: DesiredConfig, now = new Date()): Promise<SeedPlan> {
  refuseLockedDials(desired);
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
export interface RequestContext {
  fxGydPerUsd?: number | null;
  adminPhone?: string | null;
  /** [OWNER EMAIL · Opus money review 14 Oct, S2-L] The owner's email, written on
   *  the first SUPER_ADMIN's account with the mint when it has none: the app's
   *  solo approval emails the owner (SOLO_NO_EMAIL without one) and no shipped
   *  client can add an admin email. Shown masked, bound by its digest. */
  adminEmail?: string | null;
  /** [SOLO SEED] One pinned person approves, after a 12-hour cooling-off:
   *  only the production seed that mints the first SUPER_ADMIN (approver-signatures.ts). */
  solo?: boolean;
  /** [SOLO RE-SEED] One pinned person approves a LATER production re-seed
   *  while they are the only admin: a cancellable 12-hour wait from when they
   *  are told, and a sign-in code at apply (startSoloReseed, applySeedPlan).
   *  Needs the admin phone and email; never together with `solo`. */
  soloReseed?: boolean;
}

const E164 = /^\+[1-9]\d{6,14}$/;
/** A value as the approver reads it: whole while short; a long one as its head,
 *  length and digest (the plan digest and the server's rebuild bind it whole). */
function shown(v: unknown): string {
  const text = JSON.stringify(v) ?? 'null';
  return text.length <= 200 ? text : `${text.slice(0, 120)}… (${text.length} chars, sha256 ${sha256(text).slice(0, 16)})`;
}
const databaseLine = (t: TargetFingerprint) => `database: ${t.database} on ${t.host}, deployment ${t.deploymentId} (${t.environment})`;
const phoneTail = (phone: string) => phone.slice(-4);
/** An address as people type them, in plain ASCII letters, digits and . _ % + - ([SECREVIEW 14 Oct]:
 *  the approver reads its domain exactly, so no invisible, right-to-left or
 *  look-alike character can make it show as another); users.email is unique
 *  and compared exactly. */
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
export const validAdminEmail = (email: string) => email.length <= 254 && EMAIL.test(email);
/** First letter, the domain and the FULL sha256: enough to recognise without
 *  spreading the address, and the digest binds all of it. seed-approve.sh has
 *  the approver type the address he expects and compares this digest. */
const emailShown = (email: string) => `${email[0]}…@${email.slice(email.indexOf('@') + 1)} (sha256 ${sha256(email)})`;

/** The words an approver reads for this plan, in order, every change listed. */
export function planRequestFacts(plan: SeedPlan, ctx: RequestContext = {}): RequestFacts {
  if (ctx.adminPhone && !E164.test(ctx.adminPhone)) throw new SeedRefused('PHONE_INVALID', 'the admin phone must be E.164');
  if (ctx.adminEmail != null && !validAdminEmail(ctx.adminEmail)) throw new SeedRefused('EMAIL_INVALID', 'the admin email is not an email address');
  if (ctx.adminEmail && !ctx.adminPhone) throw new SeedRefused('EMAIL_WITHOUT_ADMIN', 'the admin email is written only on the first SUPER_ADMIN the plan mints; set the admin phone too');
  if (ctx.solo && !ctx.adminPhone) throw new SeedRefused('SOLO_NOT_ALLOWED', 'a solo approval covers only the seed that mints the first SUPER_ADMIN; set the admin phone, or use the two-person ceremony');
  // [SOLO RE-SEED] Its own words: the phone that gets the sign-in code and the
  // notices, and the line that says one person, a cancellable wait, a code.
  if (ctx.solo && ctx.soloReseed) throw new SeedRefused('SOLO_MODE_AMBIGUOUS', 'a request is either the first-seed solo or a solo re-seed, never both');
  if (ctx.soloReseed && (!ctx.adminPhone || !ctx.adminEmail)) throw new SeedRefused('SOLO_NOT_ALLOWED', "a solo re-seed names the only admin's phone and email (the sign-in code and the notices go to them); set both, or use the two-person ceremony");
  const reseedAdminLine = ctx.soloReseed && ctx.adminPhone ? `admin phone: ending ${phoneTail(ctx.adminPhone)}, the only admin, gets the sign-in code and the notices` : null;
  const fx = ctx.fxGydPerUsd ?? null;
  const shows = [
    databaseLine(plan.target),
    `config: ${plan.configVersion} (${plan.configDigest.slice(0, 16)}), ${plan.changes.length} change${plan.changes.length === 1 ? '' : 's'}, FX ${fx === null ? 'not set' : `${fx} GYD per USD`}`,
    reseedAdminLine ?? `admin phone: ${ctx.adminPhone ? `ending ${phoneTail(ctx.adminPhone)} becomes the first SUPER_ADMIN if there is none` : 'none'}`,
    ...(ctx.adminEmail ? [`admin email: ${emailShown(ctx.adminEmail)} is set on that account if it has no email`] : []),
    ...(ctx.solo ? [SOLO_SHOW_LINE] : []),
    ...(ctx.soloReseed ? [SOLO_RESEED_SHOW_LINE] : []),
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
  return ctx.solo || ctx.soloReseed ? approvalRequest(planRequestFacts(plan, ctx), now, SOLO_DEFAULT_LIFETIME_MS) : approvalRequest(planRequestFacts(plan, ctx), now);
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
  /** [SOLO RE-SEED] How the sign-in code the owner types is read back
   *  (seed-production.ts: one line from its terminal). The code itself is made,
   *  texted to the owner's phone and checked here, never by the caller. */
  readSignInCode?: (prompt: string) => Promise<string>;
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
  refuseLockedDials(desired);
  const { digest: carried, ...body } = plan;
  if (seedPlanDigest(body) !== carried) { seedPlanCounter.labels('refused_tampered').inc(); throw new SeedRefused('PLAN_TAMPERED', 'the plan body does not match its digest'); }
  if (plan.configDigest !== sha256(canonical(desired))) { seedPlanCounter.labels('refused_config_mismatch').inc(); throw new SeedRefused('CONFIG_MISMATCH', `the plan was built for configuration ${plan.configVersion}; the code now holds different desired data — plan again`); }
  const target = await targetFingerprint(prisma, databaseUrl);
  if (target.digest !== plan.target.digest) { seedPlanCounter.labels('refused_target').inc(); throw new SeedRefused('TARGET_MISMATCH', `this database (${target.database} on ${target.host}, ${target.deploymentId}/${target.environment}) is not the plan's target`); }
  if (target.environment === 'unknown') { seedPlanCounter.labels('refused_target').inc(); throw new SeedRefused('TARGET_UNKNOWN', 'the database declares no deployment identity; bootstrap it first'); }
  let verified: VerifiedApproval[] = [];
  // [SOLO RE-SEED] Its own gate (soloReseedGate): one signed line, a started
  // and uncancelled wait that has ended, still the only admin, a sign-in code.
  let reseed: SoloReseedGate | null = null;
  if (target.environment === 'production' && opts.request?.soloReseed) {
    reseed = await soloReseedGate(prisma, plan, opts);
    verified = [reseed.verified];
  } else if (target.environment === 'production') {
    // [SOLO SEED] Solo covers only the seed that mints the first SUPER_ADMIN:
    // once one exists, every production change keeps two people.
    if (opts.request?.solo && (await prisma.user.count({ where: { roles: { has: 'SUPER_ADMIN' } } })) > 0) {
      throw new SeedRefused('SOLO_NOT_ALLOWED', 'a SUPER_ADMIN already exists: a solo approval covers only the seed that mints the first one; use the two-person ceremony');
    }
    if (!opts.approvals?.length) throw new SeedRefused('APPROVALS_REQUIRED', opts.request?.solo ? 'a solo production seed needs its one signed approval' : 'a production configuration change needs two independent approvals');
    verified = opts.request?.solo
      ? verifySoloApproval(opts.approvals, parseApproverKeys(opts.approverKeys), planRequestFacts(plan, opts.request), opts.now)
      : verifyApprovals(opts.approvals, parseApproverKeys(opts.approverKeys), planRequestFacts(plan, opts.request), opts.now);
  }
  let applied: { count: number; firstAdmin: { userId: string } | null };
  try {
    applied = await runPlanTransaction(prisma, desired, plan, verified, opts, reseed);
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
 * [OWNER EMAIL · Opus money review 14 Oct, S2-L] The owner's email on the first
 * SUPER_ADMIN's account, inside the plan's transaction. Written only where the
 * account has none; a different address already there is never overwritten,
 * and an address another account uses is never taken. emailChangedAt is not
 * written: this is the account's first address, not a change, so solo waits
 * only its own 12 hours. A refusal rolls the whole seed back: nothing is
 * written and no approval is spent.
 */
async function setFirstAdminEmail(tx: Prisma.TransactionClient, userId: string, email: string): Promise<void> {
  if (!validAdminEmail(email)) throw new SeedRefused('EMAIL_INVALID', 'the admin email is not an email address');
  const row = await tx.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (row?.email === email) return;
  if (row?.email) throw new SeedRefused('ADMIN_EMAIL_DIFFERS', "the first admin's account already has a different email, and the seed never overwrites one; nothing was written. Check the address with the owner");
  const taken = await tx.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' }, NOT: { id: userId } }, select: { id: true } });
  if (taken) throw new SeedRefused('ADMIN_EMAIL_TAKEN', 'another account already uses that email; nothing was written');
  await tx.user.update({ where: { id: userId }, data: { email } });
}

/**
 * [PROD-PATH] The first production SUPER_ADMIN, covered by the signed plan:
 * minted in the plan's transaction, after its approvals are consumed, only
 * when every approval names this phone and no SUPER_ADMIN exists yet.
 */
async function mintSignedFirstAdmin(tx: Prisma.TransactionClient, plan: SeedPlan, verified: VerifiedApproval[], opts: ApplyOptions): Promise<{ userId: string } | null> {
  const phone = opts.request?.adminPhone;
  const solo = opts.request?.solo === true;
  if (plan.target.environment !== 'production' || !phone || verified.length < (solo ? 1 : 2)) return null;
  if (verified.some((v) => v.admin !== promotionSubject(phone))) return null;
  if ((await tx.user.count({ where: { roles: { has: 'SUPER_ADMIN' } } })) > 0) return null;
  const u = await upsertSuperAdmin(tx, phone);
  const email = opts.request?.adminEmail ?? null;
  if (email) await setFirstAdminEmail(tx, u.id, email);
  await tx.privilegedChangeAudit.create({ data: {
    action: 'PROMOTE_SUPER_ADMIN', planDigest: sha256(canonical({ target: plan.target.digest, phone, mode: 'signed-plan' })), event: 'APPLIED',
    target: plan.target as unknown as Prisma.InputJsonValue,
    detail: { mode: 'signed-plan', ...(solo ? { solo: true } : {}), ...(email ? { emailSet: true } : {}), plan: plan.digest, approvers: verified.map((v) => v.approver), userId: u.id } as Prisma.InputJsonValue,
    actor: opts.actor ?? null,
  } });
  return { userId: u.id };
}

async function runPlanTransaction(prisma: PrismaClient, desired: DesiredConfig, plan: SeedPlan, verified: VerifiedApproval[], opts: ApplyOptions, reseed: SoloReseedGate | null = null): Promise<{ count: number; firstAdmin: { userId: string } | null }> {
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
    const solo = plan.target.environment === 'production' && opts.request?.solo === true;
    // [SOLO RE-SEED] Under the same lock as the change: still the only admin,
    // and the wait still standing (not cancelled, not used), or nothing lands.
    if (reseed) await soloReseedRecheck(tx, plan, reseed, opts.request!);
    if (plan.target.environment === 'production') await consumeApprovals(tx, verified, { action: 'SEED_CONFIG', target: plan.target as unknown as Prisma.InputJsonValue, actor: opts.actor }, solo || reseed ? 'solo' : 'two-person');
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
    // [SOLO SEED] A solo approval is only for the seed that mints the first
    // SUPER_ADMIN: if this transaction minted none (one appeared meanwhile),
    // nothing of it lands and the approval is not used up.
    if (solo && !firstAdmin) throw new SeedRefused('SOLO_NOT_ALLOWED', 'a solo approval covers only the seed that mints the first SUPER_ADMIN, and none was minted (one exists now); use the two-person ceremony');
    await audit(tx, plan, plan.changes.length === 0 ? 'NOOP' : 'APPLIED', { configVersion: plan.configVersion, configDigest: plan.configDigest, approvers, ...(solo ? { solo: true } : {}), ...(reseed ? { solo: true, soloReseed: true, signInCode: true } : {}), changes: plan.changes.length, tables: [...new Set(plan.changes.map((c) => c.table))], firstAdmin: !!firstAdmin }, opts.actor);
    // [SOLO RE-SEED] Its own audit row, then the owner's email and text LAST:
    // a notice that cannot go rolls the whole re-seed back (approval unspent).
    if (reseed) await soloReseedApplied(tx, plan, reseed, opts);
    return { count: plan.changes.length, firstAdmin };
  }, reseed ? SOLO_RESEED_TX : undefined);
}

// ---------------------------------------------------------------------------
// [SOLO RE-SEED] A later production re-seed, approved by the owner alone
// ---------------------------------------------------------------------------
//
// Owner ruling 26 Oct 2026 (PROD-SESSION D1), under the 30 Sep ruling #13
// SOLO MODE: there is no second person, so while the owner is the ONLY admin a
// later production settings re-seed may be approved by them alone, under the
// same solo ceremony the app uses (admin/solo-approval.ts):
//   1. one pinned key signs a request whose words say it is a solo re-seed
//      (SOLO_RESEED_SHOW_LINE) and name the only admin's phone and email;
//   2. the signed line STARTS a 12-hour wait (startSoloReseed): an
//      append-only audit row, an email and a text to the owner, in one
//      transaction — a notice that cannot go means nothing starts;
//   3. until the seed runs, the wait can be cancelled (cancelSoloReseeds,
//      and three wrong or late sign-in codes cancel it too);
//   4. after the wait the apply counts the admins again (still exactly one:
//      the owner), texts a fresh sign-in code to the owner's phone and needs
//      it typed back within five minutes, then — inside the plan's own locked
//      transaction — counts again, consumes the approval with its signed
//      record, writes the changes and the audit, and emails and texts the
//      owner LAST (a notice that cannot go rolls the whole re-seed back).
// The moment a second admin exists, solo is off: a waiting re-seed never runs
// and the two-person ceremony is the only way (no grandfathering). The wait is
// fixed at 12 hours, never a setting: a seed must not shorten its own wait.
// The first-seed solo (above) and the two-person ceremony are unchanged.

/** The append-only audit action of a solo re-seed's wait: REQUESTED, CODE_REFUSED, CANCELLED, APPLIED. */
export const SOLO_RESEED_ACTION = 'SEED_SOLO_RESEED';
/** How long a texted sign-in code may take to be typed back. */
export const SOLO_RESEED_CODE_TTL_MS = 5 * 60 * 1000;
/** Wrong or late codes for one re-seed before it is cancelled for good. */
export const SOLO_RESEED_MAX_WRONG_CODES = 3;
/** An SMTP dialogue and a text are each capped at 8 s; the transaction outlives them. */
const SOLO_RESEED_TX = { timeout: 30_000, maxWait: 10_000 } as const;

interface OnlyAdmin { id: string; phone: string; email: string }
interface SoloReseedGate { verified: VerifiedApproval; owner: OnlyAdmin; eligibleAt: Date }
interface SoloReseedRows { requested: { detail: Prisma.JsonValue } | null; cancelled: boolean; applied: boolean; wrongCodes: number }

const json = (v: unknown) => v as Prisma.InputJsonValue;

/** Every row of one re-seed's wait, keyed by the approval it consumes. */
async function soloReseedRows(db: Pick<PrismaClient, 'privilegedChangeAudit'> | Prisma.TransactionClient, consumption: string): Promise<SoloReseedRows & { consumed: boolean }> {
  const rows = await db.privilegedChangeAudit.findMany({ where: { action: SOLO_RESEED_ACTION, planDigest: consumption }, select: { event: true, detail: true }, orderBy: { createdAt: 'asc' } });
  const consumed = await db.privilegedChangeAudit.count({ where: { action: 'SEED_APPROVAL_CONSUMED', planDigest: consumption } });
  const requested = rows.find((r) => r.event === 'REQUESTED') ?? null;
  return {
    requested: requested ? { detail: requested.detail } : null,
    cancelled: rows.some((r) => r.event === 'CANCELLED'),
    applied: rows.some((r) => r.event === 'APPLIED'),
    wrongCodes: rows.filter((r) => r.event === 'CODE_REFUSED').length,
    consumed: consumed > 0,
  };
}

/**
 * The owner, as the ONE admin who exists, read live (approverRoster: every
 * admin account that can sign in, any tenant, whatever role is active; over-
 * counting switches solo off, the safe direction). The request's phone must
 * be theirs, and the notices must be able to reach them: their account email
 * is the address the request names, unchanged for seven days, and their phone
 * is one a text can reach.
 */
async function onlyAdmin(db: Pick<PrismaClient, 'user'> | Prisma.TransactionClient, phone: string, email: string, now: Date): Promise<OnlyAdmin> {
  const roster = await approverRoster(db);
  if (roster.length === 0) throw new SeedRefused('SOLO_NO_ADMIN', 'there is no admin yet: the first production seed uses the first-seed solo approval (SEED_SOLO=1 with no SUPER_ADMIN), not a solo re-seed');
  if (roster.length > 1) {
    throw new SeedRefused('SOLO_SECOND_ADMIN', `another admin exists (${roster.length} admin accounts), so this change needs two people: use the two-person ceremony (without SEED_SOLO). Solo approval is only for while the owner is the only admin; nothing ran`);
  }
  const only = roster[0]!;
  const user = await db.user.findUnique({ where: { id: only.userId }, select: { id: true, phone: true, email: true, emailChangedAt: true } });
  if (!user || only.role !== 'SUPER_ADMIN' || user.phone !== phone) {
    throw new SeedRefused('SOLO_NOT_OWNER', 'the only admin is not the owner account this request names (by its phone); nothing ran');
  }
  const address = user.email?.trim() ?? '';
  if (!address) throw new SeedRefused('SOLO_NO_EMAIL', "a solo re-seed emails the owner when it starts and when it runs, and the owner's account has no email; nothing ran");
  if (address.toLowerCase() !== email.toLowerCase()) throw new SeedRefused('SOLO_EMAIL_MISMATCH', "the owner's account email is not the address the signed request names (the notices go to the account's address); nothing ran");
  const quietUntil = soloQuietUntil(user.emailChangedAt, now);
  if (quietUntil) throw new SeedRefused('SOLO_EMAIL_RECENT', `the owner's account email changed in the last seven days, so solo approval is off until ${quietUntil.toISOString()}; nothing ran`);
  if (!smsDestinationAllowed(user.phone)) throw new SeedRefused('SOLO_SMS_UNAVAILABLE', "a solo re-seed texts the owner's phone, and this phone cannot be texted; nothing ran");
  return { id: user.id, phone: user.phone, email: address };
}

/**
 * Can the owner's notices and sign-in code actually leave? The email needs a
 * working provider (production: SMTP or Resend); in production the text needs Twilio,
 * exactly as the API's boot demands it (boot-config.ts). Null when ready, or
 * which one is not. No notice, no solo: the send itself is still the authority.
 */
export function soloNoticeChannelsReady(env: Record<string, string | undefined> = process.env): 'email' | 'text' | null {
  if (!emailChannelConfigured(env)) return 'email';
  if (isProduction(env) && ((env['NOTIFICATION_PROVIDER'] ?? 'dev') !== 'twilio' || firstInvalidTwilioConfig(env) !== null)) return 'text';
  return null;
}

/**
 * [SOLO RE-SEED · SEED-FIX 27 Oct] The notification settings the seed
 * container is given (deploy/docker-compose.seed.yml), from deploy/.env just
 * as the api gets them. getChannels() builds every channel (push too), so the
 * seed needs every setting it reads in production, not only the email and
 * text ones. Compose hands an unset one over as an empty string, and the
 * providers read empty as a value (PUSH_PROVIDER='' is an unknown provider,
 * SMTP_TLS='' an unknown mode), so the seed unsets an empty one first
 * (seed-production.ts). The secrets are not listed: they arrive as *_FILE,
 * and the secret-file loader already treats an empty one as unset.
 * seed-container-channels.test.ts records what the channels read in
 * production and holds this list and the compose file to it.
 */
export const SEED_CHANNEL_SETTINGS = [
  'NOTIFICATION_PROVIDER', 'TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_FROM', 'TWILIO_MESSAGING_SERVICE_SID',
  'PUSH_PROVIDER', 'EXPO_PUSH_URL', 'EXPO_PUSH_RECEIPT_DELAY_MS',
  'EMAIL_PROVIDER', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_TLS', 'SMTP_USER', 'EMAIL_FROM', 'SMTP_TIMEOUT_MS',
  // [EMAIL-HTTPS] EMAIL_PROVIDER=resend (its key arrives as RESEND_API_KEY_FILE).
  'RESEND_TIMEOUT_MS',
] as const;

/** An empty notification setting is an unset one in the seed (see SEED_CHANNEL_SETTINGS). */
export function unsetEmptyChannelSettings(env: Record<string, string | undefined>): void {
  for (const name of SEED_CHANNEL_SETTINGS) if (env[name] === '') delete env[name];
}

function assertNoticeChannels(): void {
  const missing = soloNoticeChannelsReady();
  if (missing === 'email') throw new SeedRefused('SOLO_EMAIL_UNAVAILABLE', "a solo re-seed emails the owner when it starts and when it runs, and this seed's email is not set up; nothing ran");
  if (missing === 'text') throw new SeedRefused('SOLO_SMS_UNAVAILABLE', "a solo re-seed texts the owner and needs a sign-in code by text, and this seed's texts are not set up; nothing ran");
}

const reseedWords = (plan: SeedPlan) => `config ${plan.configVersion}, ${plan.changes.length} change${plan.changes.length === 1 ? '' : 's'}`;
const CANCEL_STEP = 'SEED_SOLO_CANCEL=1 ./deploy/seed-production.sh <the deployed SHA>';

/**
 * Start the wait for one signed solo re-seed. Everything commits together or
 * not at all: the started row (with when it may run), the owner's email and
 * the owner's text, sent LAST inside the transaction. Refused unless the plan
 * is this database's, the line is one pinned key's over exactly these words,
 * it was never started, cancelled or used, the owner is the only admin and
 * the notices can go, and the request outlives the wait.
 */
export async function startSoloReseed(prisma: PrismaClient, databaseUrl: string, desired: DesiredConfig, plan: SeedPlan, opts: ApplyOptions = {}): Promise<{ eligibleAt: Date; expiresAt: Date }> {
  refuseLockedDials(desired);
  const { digest: carried, ...body } = plan;
  if (seedPlanDigest(body) !== carried) throw new SeedRefused('PLAN_TAMPERED', 'the plan body does not match its digest');
  if (plan.configDigest !== sha256(canonical(desired))) throw new SeedRefused('CONFIG_MISMATCH', `the plan was built for configuration ${plan.configVersion}; the code now holds different desired data — plan again`);
  const target = await targetFingerprint(prisma, databaseUrl);
  if (target.digest !== plan.target.digest) throw new SeedRefused('TARGET_MISMATCH', `this database (${target.database} on ${target.host}, ${target.deploymentId}/${target.environment}) is not the plan's target`);
  if (target.environment !== 'production') throw new SeedRefused('SOLO_NOT_ALLOWED', 'a solo re-seed is the production ceremony only (elsewhere the plan applies without approvals)');
  const ctx = opts.request;
  if (!ctx?.soloReseed) throw new SeedRefused('SOLO_NOT_ALLOWED', 'this is not a solo re-seed request');
  if (!opts.approvals?.length) throw new SeedRefused('APPROVALS_REQUIRED', 'a solo re-seed needs its one signed approval');
  if (plan.changes.length === 0) throw new SeedRefused('SOLO_NOTHING_TO_CHANGE', `production already holds configuration ${plan.configVersion}: there is nothing to re-seed, and nothing started`);
  const now = opts.now ?? new Date();
  const verified = verifySoloReseedApproval(opts.approvals, parseApproverKeys(opts.approverKeys), planRequestFacts(plan, ctx), now);
  const rows = await soloReseedRows(prisma, verified.consumption);
  if (rows.applied || rows.consumed) throw new SeedRefused('APPROVAL_REPLAYED', `approval by ${verified.approver} was already used; sign a new request`);
  if (rows.cancelled) throw new SeedRefused('SOLO_CANCELLED', 'this solo re-seed was cancelled and never runs; print and sign a new request');
  if (rows.requested) throw new SeedRefused('SOLO_ALREADY_STARTED', `this solo re-seed is already waiting; it may run from ${String((rows.requested.detail as { eligibleAt?: unknown } | null)?.eligibleAt ?? '?')}`);
  const eligibleAt = new Date(now.getTime() + SOLO_COOLING_OFF_MS);
  if (eligibleAt.getTime() >= Date.parse(verified.expires)) {
    throw new SeedRefused('SOLO_REQUEST_TOO_OLD', `this request expires at ${verified.expires}, before its 12-hour wait would end (${eligibleAt.toISOString()}); print and sign a new one`);
  }
  const owner = await onlyAdmin(prisma, ctx.adminPhone!, ctx.adminEmail!, now);
  assertNoticeChannels();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('swift:seed-plan'))`;
    const again = await soloReseedRows(tx, verified.consumption);
    if (again.requested || again.cancelled || again.applied || again.consumed) throw new SeedRefused('SOLO_ALREADY_STARTED', 'this solo re-seed was started (or ended) by another run just now');
    // Counted again under the lock that starts the wait; the notices go where the account says NOW.
    const still = await onlyAdmin(tx, ctx.adminPhone!, ctx.adminEmail!, now);
    if (still.id !== owner.id) throw new SeedRefused('SOLO_NOT_OWNER', 'the only admin changed while the wait was starting; nothing started');
    await tx.privilegedChangeAudit.create({ data: {
      action: SOLO_RESEED_ACTION, planDigest: verified.consumption, event: 'REQUESTED', target: json(plan.target),
      detail: json({
        plan: plan.digest, configVersion: plan.configVersion, configDigest: plan.configDigest, changes: plan.changes.length,
        approver: verified.approver, fingerprint: verified.fingerprint, nonce: verified.nonce, issued: verified.issued, expires: verified.expires,
        startedAt: now.toISOString(), eligibleAt: eligibleAt.toISOString(), coolOffHours: SOLO_COOLING_OFF_MS / 3_600_000, userId: still.id,
      }),
      actor: opts.actor ?? null,
    } });
    await sendSoloEmail(still.email, 'Swift: a production settings re-seed is waiting for your solo approval', [
      'A production settings re-seed was started for you to approve alone, because you are the only admin:',
      '',
      `  Configuration: ${plan.configVersion} (${plan.changes.length} change${plan.changes.length === 1 ? '' : 's'})`,
      `  Database: ${plan.target.database} (${plan.target.environment})`,
      `  Signed by: ${verified.approver}`,
      `  Started: ${guyanaTime(now)}`,
      '',
      `It can run after ${guyanaTime(eligibleAt)}, and only with a sign-in code texted to your phone at that moment. Nothing changes before then.`,
      '',
      `To stop it, run this on the production server: ${CANCEL_STEP}`,
      'or never type the code. If you did not start this, cancel it and make a new seed approval key.',
    ].join('\n'));
    await sendSoloText(still.phone,
      `Swift admin: a production settings re-seed (${reseedWords(plan)}) was started for your solo approval. ` +
      `It can run after ${guyanaTime(eligibleAt)}, only with a code texted to you. If this was not you, cancel it on the server: SEED_SOLO_CANCEL=1.`);
  }, SOLO_RESEED_TX);
  return { eligibleAt, expiresAt: new Date(verified.expires) };
}

/** One waiting solo re-seed a cancel stopped, as the operator is shown it. */
export interface CancelledSoloReseed { plan: string; configVersion: string; changes: number; approver: string; startedAt: string; eligibleAt: string }

/**
 * Cancel every solo re-seed still waiting in THIS database: each gets a
 * CANCELLED row and never runs (a new one needs a new signed request). The
 * brake needs no approval, no code and no notice: stopping is always allowed.
 * [Security review M2] It finds every started, uncancelled, unused wait in the
 * audit table itself — never by the target digest, which follows the
 * connection string's spelling (localhost vs 127.0.0.1), so no form of the
 * address can make it miss one (fail closed). Returns each one it cancelled.
 */
export async function cancelSoloReseeds(prisma: PrismaClient, databaseUrl: string, opts: { actor?: string; reason?: string } = {}): Promise<CancelledSoloReseed[]> {
  const target = await targetFingerprint(prisma, databaseUrl);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('swift:seed-plan'))`;
    const started = await tx.privilegedChangeAudit.findMany({ where: { action: SOLO_RESEED_ACTION, event: 'REQUESTED' }, select: { planDigest: true, detail: true }, orderBy: { createdAt: 'asc' } });
    const cancelled: CancelledSoloReseed[] = [];
    for (const { planDigest, detail } of started) {
      const rows = await soloReseedRows(tx, planDigest);
      if (rows.cancelled || rows.applied || rows.consumed) continue;
      const d = (detail ?? {}) as Record<string, unknown>;
      const one: CancelledSoloReseed = {
        plan: String(d['plan'] ?? '?'), configVersion: String(d['configVersion'] ?? '?'), changes: Number(d['changes'] ?? 0),
        approver: String(d['approver'] ?? '?'), startedAt: String(d['startedAt'] ?? '?'), eligibleAt: String(d['eligibleAt'] ?? '?'),
      };
      await tx.privilegedChangeAudit.create({ data: { action: SOLO_RESEED_ACTION, planDigest, event: 'CANCELLED', target: json(target), detail: json({ reason: opts.reason ?? 'cancelled by the operator', ...one }), actor: opts.actor ?? null } });
      cancelled.push(one);
    }
    return cancelled;
  });
}

/**
 * The fresh sign-in code (the app's step-up, for a run on the server): six
 * random digits texted to the owner's phone — never stored, never printed —
 * typed back within five minutes, compared in constant time. A wrong, late or
 * missing code is recorded; the third cancels this re-seed for good.
 */
async function confirmSignInCode(prisma: PrismaClient, owner: OnlyAdmin, verified: VerifiedApproval, plan: SeedPlan, opts: ApplyOptions): Promise<void> {
  if (!opts.readSignInCode) {
    throw new SeedRefused('SIGN_IN_CODE_REQUIRED', "a solo re-seed runs only with a sign-in code texted to the owner's phone and typed back; this run cannot read one (run it in the owner's own terminal); nothing ran");
  }
  const code = generateOtp();
  let sent: unknown;
  try {
    sent = await getChannels().sms.sendSms(owner.phone, `Your Swift confirmation code is ${code}. It applies the production settings re-seed you approve alone (${reseedWords(plan)}) now. If you did not start it, do not share the code.`);
  } catch {
    throw new SeedRefused('SOLO_SMS_UNAVAILABLE', 'the sign-in code could not be texted; nothing ran. Try again later');
  }
  if (!smsAccepted(sent)) throw new SeedRefused('SOLO_SMS_UNAVAILABLE', 'the sign-in code could not be texted; nothing ran. Try again later');
  const sentAt = Date.now();
  const typed = (await opts.readSignInCode(`A sign-in code was texted to the phone ending ${phoneTail(owner.phone)}. Type it (it is not shown) and press Enter: `)).trim();
  const late = Date.now() - sentAt > SOLO_RESEED_CODE_TTL_MS;
  if (!late && /^\d{6}$/.test(typed) && timingSafeEqual(Buffer.from(typed), Buffer.from(code))) return;
  const wrong = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('swift:seed-plan'))`;
    await tx.privilegedChangeAudit.create({ data: { action: SOLO_RESEED_ACTION, planDigest: verified.consumption, event: 'CODE_REFUSED', target: json(plan.target), detail: json({ plan: plan.digest, why: late ? 'late' : typed ? 'wrong' : 'none' }), actor: opts.actor ?? null } });
    const count = (await soloReseedRows(tx, verified.consumption)).wrongCodes;
    if (count >= SOLO_RESEED_MAX_WRONG_CODES) {
      await tx.privilegedChangeAudit.create({ data: { action: SOLO_RESEED_ACTION, planDigest: verified.consumption, event: 'CANCELLED', target: json(plan.target), detail: json({ reason: `${count} wrong or late sign-in codes` }), actor: opts.actor ?? null } });
    }
    return count;
  });
  if (wrong >= SOLO_RESEED_MAX_WRONG_CODES) throw new SeedRefused('SOLO_CANCELLED', `${wrong} wrong or late sign-in codes: this solo re-seed is cancelled for good and never runs; nothing ran`);
  throw new SeedRefused('SIGN_IN_CODE_WRONG', `the sign-in code was ${late ? 'typed too late' : 'not right'}; nothing ran (${SOLO_RESEED_MAX_WRONG_CODES - wrong} more before this re-seed is cancelled). Run it again for a new code`);
}

/**
 * Everything a solo re-seed needs before its transaction, cheapest first so a
 * refusal that needs no code never sends one: the one signed line over these
 * words, a started wait that was neither cancelled nor used and has ended,
 * still the only admin, notices that can go, then the sign-in code.
 */
async function soloReseedGate(prisma: PrismaClient, plan: SeedPlan, opts: ApplyOptions): Promise<SoloReseedGate> {
  const now = opts.now ?? new Date();
  const ctx = opts.request!;
  if (!opts.approvals?.length) throw new SeedRefused('APPROVALS_REQUIRED', 'a solo re-seed needs its one signed approval');
  const verified = verifySoloReseedApproval(opts.approvals, parseApproverKeys(opts.approverKeys), planRequestFacts(plan, ctx), now);
  const rows = await soloReseedRows(prisma, verified.consumption);
  if (rows.applied || rows.consumed) throw new SeedRefused('APPROVAL_REPLAYED', `approval by ${verified.approver} was already used; sign a new request`);
  if (!rows.requested) throw new SeedRefused('SOLO_NOT_STARTED', 'this solo re-seed has not started its 12-hour wait yet (running it with its signed line starts the wait and tells the owner)');
  if (rows.cancelled) throw new SeedRefused('SOLO_CANCELLED', 'this solo re-seed was cancelled and never runs; print and sign a new request');
  const detail = (rows.requested.detail ?? {}) as { eligibleAt?: unknown; userId?: unknown; fingerprint?: unknown; approver?: unknown };
  // [Security review M1] The wait belongs to the one pinned key that started it
  // (the row is found by a key over that key's fingerprint and the request, so
  // this holds by construction; checked in words too).
  if (detail.fingerprint !== verified.fingerprint || detail.approver !== verified.approver) {
    throw new SeedRefused('SOLO_KEY_CHANGED', 'this solo re-seed was started with another pinned key; nothing ran');
  }
  const startedEligible = typeof detail.eligibleAt === 'string' ? Date.parse(detail.eligibleAt) : NaN;
  if (!Number.isFinite(startedEligible)) throw new SeedRefused('SOLO_NOT_STARTED', 'the started wait of this solo re-seed is unreadable; cancel it and start a new one');
  // Never sooner than 12 hours after the request was signed for, either.
  const eligibleAt = new Date(Math.max(startedEligible, Date.parse(verified.issued) + SOLO_COOLING_OFF_MS));
  if (now.getTime() < eligibleAt.getTime()) {
    throw new SeedRefused('COOLING_OFF', `this solo re-seed may run from ${eligibleAt.toISOString()} (${guyanaTime(eligibleAt)}; a 12-hour wait from when it started), until ${verified.expires}`);
  }
  const owner = await onlyAdmin(prisma, ctx.adminPhone!, ctx.adminEmail!, now);
  if (detail.userId !== owner.id) throw new SeedRefused('SOLO_NOT_OWNER', 'the owner account told when this wait started is not the only admin now; nothing ran');
  assertNoticeChannels();
  await confirmSignInCode(prisma, owner, verified, plan, opts);
  return { verified, owner, eligibleAt };
}

/** Inside the plan's transaction, under its lock: still standing, still the only admin. */
async function soloReseedRecheck(tx: Prisma.TransactionClient, plan: SeedPlan, reseed: SoloReseedGate, ctx: RequestContext): Promise<void> {
  const rows = await soloReseedRows(tx, reseed.verified.consumption);
  if (rows.cancelled) throw new SeedRefused('SOLO_CANCELLED', 'this solo re-seed was cancelled while it was being applied; nothing ran');
  if (rows.applied || rows.consumed) throw new SeedRefused('APPROVAL_REPLAYED', `approval by ${reseed.verified.approver} was already used; sign a new request`);
  const still = await onlyAdmin(tx, ctx.adminPhone!, ctx.adminEmail!, new Date());
  if (still.id !== reseed.owner.id) throw new SeedRefused('SOLO_NOT_OWNER', 'the only admin changed while the re-seed was being applied; nothing ran');
}

/** Its audit row, then the owner's email and text, last in the plan's transaction. */
async function soloReseedApplied(tx: Prisma.TransactionClient, plan: SeedPlan, reseed: SoloReseedGate, opts: ApplyOptions): Promise<void> {
  const at = new Date();
  await tx.privilegedChangeAudit.create({ data: {
    action: SOLO_RESEED_ACTION, planDigest: reseed.verified.consumption, event: 'APPLIED', target: json(plan.target),
    detail: json({ plan: plan.digest, configVersion: plan.configVersion, changes: plan.changes.length, approver: reseed.verified.approver, userId: reseed.owner.id, signInCode: true, appliedAt: at.toISOString() }),
    actor: opts.actor ?? null,
  } });
  await sendSoloEmail(reseed.owner.email, 'Swift: production settings re-seed applied (solo approval)', [
    'The production settings re-seed you approved alone was applied, with a sign-in code texted to your phone:',
    '',
    `  Configuration: ${plan.configVersion} (${plan.changes.length} change${plan.changes.length === 1 ? '' : 's'})`,
    `  Database: ${plan.target.database} (${plan.target.environment})`,
    `  Signed by: ${reseed.verified.approver}`,
    `  Applied: ${guyanaTime(at)}`,
    '',
    'If this was not you: sign out of every device, make a new seed approval key, and check the audit (it keeps the signed record).',
  ].join('\n'));
  await sendSoloText(reseed.owner.phone,
    `Swift admin: the production settings re-seed (${reseedWords(plan)}) you approved alone was applied at ${guyanaTime(at)} with the code texted to you. ` +
    'If this was not you, make a new seed approval key now.');
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
