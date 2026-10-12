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
 * `review:expire` forces DL-9; `review:status` says what exists.
 *
 * The CONTENT PACK (Part 6: fictional vendors, catalogue, images with licence
 * provenance, NAME-DENYLIST) and the rider's and driver's partner profiles
 * (review/partner-pack.ts: vehicles, verification documents, the drawn
 * profile photo) are seeded by `review:seed` (content-pack.ts), not here;
 * `provision` and `status` report them from the pack's own rows — ABSENT,
 * INCOMPLETE or PRESENT — rather than pretending.
 *
 * Fictional identifiers: E.164 under REVIEW_PHONE_PREFIX (default
 * `+59200099`). Whether a prefix is truly undialable is a carrier fact the
 * founder confirms (founder-inputs FD-STA-6); the default is a placeholder and
 * says so in `status`.
 */
import crypto from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { hashReviewCode } from './credentials';
import { assertTenantWall, attestationOf, readRlsFacts } from '../../lib/rls-attestation';
import { REVIEW_SLUG_PATTERN, reviewContentPackFacts, type ContentPackState, type ContentPackFacts } from './content-pack';

export const DEFAULT_REVIEW_TTL_DAYS = 14;
export const DEFAULT_REVIEW_PHONE_PREFIX = '+59200099';
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
const identifierFor = (prefix: string) => `${prefix}${String(crypto.randomInt(0, 100)).padStart(2, '0')}`;

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
    let identifier = identifierFor(prefix);
    for (let i = 0; i < 20 && await prisma.user.findUnique({ where: { phone: identifier }, select: { id: true } }); i++) identifier = identifierFor(prefix);
    const account = REVIEW_ACCOUNTS[role];
    const user = await prisma.user.create({ data: {
      phone: identifier, firstName: 'Demo', lastName: account.lastName, roles: account.roles, activeRole: account.activeRole,
      lastMoverRole: account.lastMoverRole, tenantId: tenant.id, isSynthetic: true, isPhoneVerified: true,
    } });
    const code = sixDigits();
    const id = `rc_${crypto.randomBytes(8).toString('hex')}`;
    await prisma.reviewCredential.create({ data: { id, tenantId: tenant.id, role, identifier, staticOtpHash: hashReviewCode(id, code) } });
    void user;
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
