/**
 * [STA-1 Parts 3, 6.3, operator runbook] Provisioning the store-review fiction.
 *
 * `review:provision` creates the REVIEW tenant (purge-protected, DL-8), one
 * ReviewSession with a TTL (DL-9), and the reviewer's logins: a synthetic
 * CUSTOMER, a synthetic delivery RIDER and a synthetic taxi DRIVER (DL-4),
 * each with its own fictional identifier and a ReviewCredential whose static
 * code is minted here, printed ONCE for the store notes, and stored only as a
 * salted hash (DL-6: no SMS is ever sent to any of them; each code is accepted
 * only for its own identifier, and only inside this tenant).
 * `review:rotate` mints new codes (run before every resubmission);
 * `review:expire` forces DL-9; `review:extend` moves a live session's expiry
 * later (row 349); `review:status` says what exists.
 *
 * The CONTENT PACK (Part 6: fictional vendors, catalogue, images with licence
 * provenance, NAME-DENYLIST) and the rider's and driver's partner profiles
 * (review/partner-pack.ts: vehicles, verification documents, the drawn
 * profile photo) are seeded by `review:seed` (content-pack.ts), not here;
 * `provision` and `status` report them from the pack's own rows — ABSENT,
 * INCOMPLETE or PRESENT — rather than pretending.
 *
 * Fictional identifiers: E.164 under REVIEW_PHONE_PREFIX (default
 * `+592000`), filled with random digits up to a full Guyana number. Whether a
 * prefix is truly undialable is a carrier fact the founder confirms
 * (founder-inputs FD-STA-6); the default is a placeholder and says so in
 * `status`.
 */
import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { hashReviewCode } from './credentials';
import { assertTenantWall, attestationOf, readRlsFacts } from '../../lib/rls-attestation';
import { REVIEW_SLUG_PATTERN, reviewContentPackFacts, type ContentPackState, type ContentPackFacts } from './content-pack';

export const DEFAULT_REVIEW_TTL_DAYS = 14;
/**
 * The default range: 10,000 numbers (+592 000 0000 to +592 000 9999). It was
 * `+59200099`, 100 numbers, and every provisioning run keeps three of them.
 * The old range lies inside this one.
 */
export const DEFAULT_REVIEW_PHONE_PREFIX = '+592000';
/** A Guyana number is +592 and seven digits; the app's phone box refuses any other length. */
const REVIEW_IDENTIFIER_LENGTH = '+592'.length + 7;
/** How many numbers one login may draw before provisioning gives up on the range. */
export const REVIEW_IDENTIFIER_ATTEMPTS = 20;
export const REVIEW_ROLES = ['CUSTOMER', 'RIDER', 'DRIVER'] as const;
export type ReviewRole = typeof REVIEW_ROLES[number];

/**
 * The account each credential opens, shaped exactly as production shapes it:
 * a customer signs up CUSTOMER; a mover signs up MOVER + CUSTOMER and
 * onboarding adds the profile's role (partner.service ensureRoles) and makes
 * it the active, remembered mover role (mover-authority). `roles` must hold
 * the active role — the app signs out a persisted session whose roles do not
 * (authHydration "invalid_roles").
 */
const REVIEW_ACCOUNTS: Record<ReviewRole, {
  lastName: string;
  roles: Array<'CUSTOMER' | 'MOVER' | 'RIDER' | 'DRIVER'>;
  activeRole: 'CUSTOMER' | 'RIDER' | 'DRIVER';
  lastMoverRole: 'RIDER' | 'DRIVER' | null;
}> = {
  CUSTOMER: { lastName: 'Reviewer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', lastMoverRole: null },
  RIDER: { lastName: 'Rider', roles: ['MOVER', 'CUSTOMER', 'RIDER'], activeRole: 'RIDER', lastMoverRole: 'RIDER' },
  DRIVER: { lastName: 'Driver', roles: ['MOVER', 'CUSTOMER', 'DRIVER'], activeRole: 'DRIVER', lastMoverRole: 'DRIVER' },
};

export interface ProvisionInput {
  slug: string;
  name?: string;
  ttlDays?: number;
  phonePrefix?: string;
  now?: Date;
}
export interface MintedCredential { role: string; identifier: string; code: string }
export interface ProvisionResult {
  tenantId: string;
  sessionId: string;
  expiresAt: Date;
  credentials: MintedCredential[];
  contentPack: ContentPackState;
}

const sixDigits = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
/**
 * How many random digits follow the prefix: enough to make a full Guyana
 * number, and never fewer than two (a longer prefix keeps its old two digits).
 */
export function reviewIdentifierDigits(prefix: string): number {
  return Math.max(2, REVIEW_IDENTIFIER_LENGTH - prefix.length);
}
const identifierFor = (prefix: string) => {
  const digits = reviewIdentifierDigits(prefix);
  return `${prefix}${String(crypto.randomInt(0, 10 ** digits)).padStart(digits, '0')}`;
};

export class ReviewProvisionRefusedError extends Error {
  constructor(slug: string, kind: string) {
    super(`[STA-1] review:provision refused for "${slug}": the tenant exists and is ${kind}, not REVIEW — nothing was changed`);
    this.name = 'ReviewProvisionRefusedError';
  }
}

/**
 * Create the REVIEW tenant, or reuse it when it already IS one. An existing
 * tenant of any other kind is refused and left exactly as it was: a slug that
 * merely LOOKS like the fiction never turns a real operator into one.
 *
 * Concurrency-safe without a read-then-write window: the reuse is ONE
 * conditional statement (`WHERE id = slug AND kind = 'REVIEW'`), and the create
 * relies on the primary key — a racing creator's row is re-judged by kind.
 */
async function reviewTenantFor(prisma: PrismaClient, slug: string, name?: string): Promise<{ id: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const reused = await prisma.tenant.updateMany({ where: { id: slug, kind: 'REVIEW' }, data: { purgeProtected: true, isActive: true } });
    if (reused.count === 1) return { id: slug };
    const existing = await prisma.tenant.findUnique({ where: { id: slug }, select: { kind: true } });
    if (existing) {
      if (existing.kind !== 'REVIEW') throw new ReviewProvisionRefusedError(slug, existing.kind);
      continue; // became REVIEW between the two statements: reuse it on the next pass
    }
    try {
      await prisma.tenant.create({ data: { id: slug, slug, name: name ?? `Store review — ${slug}`, kind: 'REVIEW', purgeProtected: true, isActive: true } });
      return { id: slug };
    } catch (err) {
      // A concurrent provisioner (or another writer) created it first: judge THAT row by its kind.
      if ((err as { code?: string }).code !== 'P2002') throw err;
    }
  }
  throw new Error(`[STA-1] review:provision could not settle the tenant "${slug}"; nothing was provisioned`);
}

/**
 * The synthetic account behind one login, under a number nobody holds. The
 * look-up only skips numbers already taken: another account (a second
 * provisioning run, say) can take the number between the look-up and the
 * insert, and the unique phone then refuses ours (P2002). That is not a
 * failure of the run — a new number is drawn — up to
 * REVIEW_IDENTIFIER_ATTEMPTS draws in all, then the range is reported full.
 */
async function createReviewAccount(prisma: PrismaClient, prefix: string, tenantId: string, role: ReviewRole): Promise<string> {
  const account = REVIEW_ACCOUNTS[role];
  for (let attempt = 1; attempt <= REVIEW_IDENTIFIER_ATTEMPTS; attempt++) {
    const identifier = identifierFor(prefix);
    if (await prisma.user.findUnique({ where: { phone: identifier }, select: { id: true } })) continue;
    try {
      await prisma.user.create({ data: {
        phone: identifier, firstName: 'Demo', lastName: account.lastName, roles: account.roles, activeRole: account.activeRole,
        lastMoverRole: account.lastMoverRole, tenantId, isSynthetic: true, isPhoneVerified: true,
      } });
      return identifier;
    } catch (err) {
      // Taken since the look-up: draw again. Anything else is a real failure.
      if ((err as { code?: string }).code !== 'P2002') throw err;
    }
  }
  throw new Error(`[STA-1] review:provision found no free number under ${prefix} in ${REVIEW_IDENTIFIER_ATTEMPTS} draws — the range is nearly full; set a shorter REVIEW_PHONE_PREFIX`);
}

/** Idempotent on the tenant; a new session and fresh credentials each run. */
export async function provisionReviewTenant(prisma: PrismaClient, input: ProvisionInput): Promise<ProvisionResult> {
  const now = input.now ?? new Date();
  const ttlDays = input.ttlDays ?? DEFAULT_REVIEW_TTL_DAYS;
  const prefix = input.phonePrefix ?? process.env['REVIEW_PHONE_PREFIX'] ?? DEFAULT_REVIEW_PHONE_PREFIX;
  if (!REVIEW_SLUG_PATTERN.test(input.slug)) throw new Error('slug must match /^review-[a-z0-9-]{2,40}$/ — the fiction is named as such');
  // [TA-S0-003] Minting a tenant at runtime is exactly the path the boot-only
  // wall gate cannot see. Assert the wall HERE, for the tenant count this
  // provisioning produces: in production, a bypassed wall or a missing
  // app-side setting refuses to create the fiction at all. (Dev/test: no-op.)
  const activeAfter = (await prisma.tenant.count({ where: { isActive: true, NOT: { id: input.slug } } })) + 1;
  assertTenantWall(attestationOf(await readRlsFacts(prisma)), activeAfter);
  const tenant = await reviewTenantFor(prisma, input.slug, input.name);
  const session = await prisma.reviewSession.create({ data: { tenantId: tenant.id, expiresAt: new Date(now.getTime() + ttlDays * 86_400_000) } });
  const credentials: MintedCredential[] = [];
  for (const role of REVIEW_ROLES) {
    const identifier = await createReviewAccount(prisma, prefix, tenant.id, role);
    const code = sixDigits();
    const id = `rc_${crypto.randomBytes(8).toString('hex')}`;
    await prisma.reviewCredential.create({ data: { id, tenantId: tenant.id, role, identifier, staticOtpHash: hashReviewCode(id, code) } });
    credentials.push({ role, identifier, code });
  }
  const pack = await reviewContentPackFacts(prisma, tenant.id);
  return { tenantId: tenant.id, sessionId: session.id, expiresAt: session.expiresAt, credentials, contentPack: pack.state };
}

/** New codes for every credential of the tenant; the old ones stop working at once. */
export async function rotateReviewCredentials(prisma: PrismaClient, tenantId: string): Promise<MintedCredential[]> {
  const rows = await prisma.reviewCredential.findMany({ where: { tenantId }, select: { id: true, role: true, identifier: true } });
  const minted: MintedCredential[] = [];
  for (const r of rows) {
    const code = sixDigits();
    await prisma.reviewCredential.update({ where: { id: r.id }, data: { staticOtpHash: hashReviewCode(r.id, code), rotatedAt: new Date() } });
    minted.push({ role: r.role, identifier: r.identifier, code });
  }
  return minted;
}

/** Forces DL-9: the app shows "this demo session has expired" from the next request. */
export async function expireReviewSession(prisma: PrismaClient, sessionId: string): Promise<'EXPIRED' | 'NOT_FOUND' | 'ALREADY_CLOSED'> {
  const s = await prisma.reviewSession.findUnique({ where: { id: sessionId }, select: { status: true } });
  if (!s) return 'NOT_FOUND';
  if (s.status === 'EXPIRED' || s.status === 'REVOKED') return 'ALREADY_CLOSED';
  await prisma.reviewSession.update({ where: { id: sessionId }, data: { status: 'EXPIRED' } });
  return 'EXPIRED';
}

/** [Row 349] The furthest an extension may reach, counted from now. */
export const MAX_REVIEW_EXTENSION_DAYS = 60;

export type ReviewExtendResult =
  | { verdict: 'EXTENDED'; from: Date; to: Date }
  | { verdict: 'NOT_FOUND' | 'ALREADY_CLOSED' | 'LAPSED' | 'NOT_LATER' | 'TOO_FAR' | 'RACED' };

/**
 * [Row 349] Moves a LIVE review session's expiry later, in place. The
 * reviewer's login and code do not change, and nothing is minted or printed,
 * so the store-review notes stay true (only their "valid until" date moves).
 *
 * Refused, and named: an unknown session; a closed one (EXPIRED / REVOKED);
 * one whose time has already run out (the gate closes it on its next request
 * — provision a new session instead of reviving it); a date that is not later
 * than the current expiry (shortening is `expire`); and a date more than
 * MAX_REVIEW_EXTENSION_DAYS from now. One compare-and-set UPDATE on the expiry
 * that was read: a concurrent expire, revoke or extend wins, and this reports
 * RACED.
 */
export async function extendReviewSession(
  prisma: Pick<PrismaClient, 'reviewSession'>,
  sessionId: string,
  until: Date,
  now = new Date(),
): Promise<ReviewExtendResult> {
  if (!Number.isFinite(until.getTime())) return { verdict: 'NOT_LATER' };
  const s = await prisma.reviewSession.findUnique({ where: { id: sessionId }, select: { status: true, expiresAt: true } });
  if (!s) return { verdict: 'NOT_FOUND' };
  if (s.status === 'EXPIRED' || s.status === 'REVOKED') return { verdict: 'ALREADY_CLOSED' };
  if (s.expiresAt.getTime() <= now.getTime()) return { verdict: 'LAPSED' };
  if (until.getTime() <= s.expiresAt.getTime()) return { verdict: 'NOT_LATER' };
  if (until.getTime() > now.getTime() + MAX_REVIEW_EXTENSION_DAYS * 86_400_000) return { verdict: 'TOO_FAR' };
  const took = await prisma.reviewSession.updateMany({
    where: { id: sessionId, status: { in: ['PROVISIONED', 'ANCHORED'] }, expiresAt: s.expiresAt },
    data: { expiresAt: until },
  });
  return took.count === 1 ? { verdict: 'EXTENDED', from: s.expiresAt, to: until } : { verdict: 'RACED' };
}

export interface ReviewStatus {
  tenant: { id: string; kind: string; purgeProtected: boolean; isActive: boolean } | null;
  sessions: Array<{ id: string; status: string; anchored: boolean; anchorSource: string | null; expiresAt: Date; lastSeenAt: Date | null }>;
  credentials: number;
  /** Logins per role (CUSTOMER / RIDER / DRIVER). */
  credentialsByRole: Record<string, number>;
  syntheticUsers: number;
  syntheticVendors: number;
  /** PRESENT only when every pack store is live and every pack item is on sale. */
  contentPack: ContentPackState;
  contentPackDetail: ContentPackFacts | null;
  phonePrefixNote: string;
}

export async function reviewStatus(prisma: PrismaClient, tenantId: string): Promise<ReviewStatus> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, kind: true, purgeProtected: true, isActive: true } });
  const sessions = tenant ? await prisma.reviewSession.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } }) : [];
  const [credentials, syntheticUsers, syntheticVendors] = tenant
    ? await Promise.all([
      prisma.reviewCredential.count({ where: { tenantId } }),
      prisma.user.count({ where: { tenantId, isSynthetic: true } }),
      prisma.vendor.count({ where: { tenantId, isSynthetic: true } }),
    ])
    : [0, 0, 0];
  const pack = tenant ? await reviewContentPackFacts(prisma, tenantId) : null;
  const byRole = tenant ? await prisma.reviewCredential.groupBy({ by: ['role'], where: { tenantId }, _count: { _all: true } }) : [];
  const prefix = process.env['REVIEW_PHONE_PREFIX'] ?? DEFAULT_REVIEW_PHONE_PREFIX;
  return {
    tenant,
    sessions: sessions.map((s) => ({ id: s.id, status: s.status, anchored: s.anchoredAt !== null, anchorSource: s.anchorSource, expiresAt: s.expiresAt, lastSeenAt: s.lastSeenAt })),
    credentials,
    credentialsByRole: Object.fromEntries(byRole.map((r) => [r.role, r._count._all])),
    syntheticUsers,
    syntheticVendors,
    contentPack: pack?.state ?? 'ABSENT',
    contentPackDetail: pack,
    phonePrefixNote: prefix === DEFAULT_REVIEW_PHONE_PREFIX
      ? `identifiers use the PLACEHOLDER prefix ${prefix} — confirm an undialable range with the carrier and set REVIEW_PHONE_PREFIX (FD-STA-6)`
      : `identifiers use REVIEW_PHONE_PREFIX=${prefix}`,
  };
}
