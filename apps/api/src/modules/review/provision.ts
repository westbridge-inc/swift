/**
 * [STA-1 Parts 3, 6.3, operator runbook] Provisioning the store-review fiction.
 *
 * `review:provision` creates the REVIEW tenant (purge-protected, DL-8), one
 * ReviewSession with a TTL (DL-9), and the reviewer's login: a synthetic
 * CUSTOMER (DL-4) with a ReviewCredential whose static code is minted here,
 * printed ONCE for the store notes, and stored only as a salted hash.
 * `review:rotate` mints new codes (run before every resubmission);
 * `review:expire` forces DL-9; `review:status` says what exists.
 *
 * The CONTENT PACK (Part 6: fictional vendors, catalogue, images with licence
 * provenance, NAME-DENYLIST) is not created here — it is founder content and
 * an Opus seed, and `status` reports it as absent rather than pretending.
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

export const DEFAULT_REVIEW_TTL_DAYS = 14;
export const DEFAULT_REVIEW_PHONE_PREFIX = '+59200099';
export const REVIEW_ROLES = ['CUSTOMER'] as const;

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
  contentPack: 'ABSENT';
}

const sixDigits = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
const identifierFor = (prefix: string) => `${prefix}${String(crypto.randomInt(0, 100)).padStart(2, '0')}`;

/** Idempotent on the tenant; a new session and fresh credentials each run. */
export async function provisionReviewTenant(prisma: PrismaClient, input: ProvisionInput): Promise<ProvisionResult> {
  const now = input.now ?? new Date();
  const ttlDays = input.ttlDays ?? DEFAULT_REVIEW_TTL_DAYS;
  const prefix = input.phonePrefix ?? process.env['REVIEW_PHONE_PREFIX'] ?? DEFAULT_REVIEW_PHONE_PREFIX;
  if (!/^review-[a-z0-9-]{2,40}$/.test(input.slug)) throw new Error('slug must match /^review-[a-z0-9-]{2,40}$/ — the fiction is named as such');
  // [TA-S0-003] Minting a tenant at runtime is exactly the path the boot-only
  // wall gate cannot see. Assert the wall HERE, for the tenant count this
  // provisioning produces: in production, a bypassed wall or a missing
  // app-side setting refuses to create the fiction at all. (Dev/test: no-op.)
  const activeAfter = (await prisma.tenant.count({ where: { isActive: true, NOT: { id: input.slug } } })) + 1;
  assertTenantWall(attestationOf(await readRlsFacts(prisma)), activeAfter);
  const tenant = await prisma.tenant.upsert({
    where: { id: input.slug },
    create: { id: input.slug, slug: input.slug, name: input.name ?? `Store review — ${input.slug}`, kind: 'REVIEW', purgeProtected: true, isActive: true },
    update: { kind: 'REVIEW', purgeProtected: true, isActive: true },
  });
  const session = await prisma.reviewSession.create({ data: { tenantId: tenant.id, expiresAt: new Date(now.getTime() + ttlDays * 86_400_000) } });
  const credentials: MintedCredential[] = [];
  for (const role of REVIEW_ROLES) {
    let identifier = identifierFor(prefix);
    for (let i = 0; i < 20 && await prisma.user.findUnique({ where: { phone: identifier }, select: { id: true } }); i++) identifier = identifierFor(prefix);
    const user = await prisma.user.create({ data: {
      phone: identifier, firstName: 'Demo', lastName: 'Reviewer', activeRole: role, tenantId: tenant.id, isSynthetic: true, isPhoneVerified: true,
    } });
    const code = sixDigits();
    const id = `rc_${crypto.randomBytes(8).toString('hex')}`;
    await prisma.reviewCredential.create({ data: { id, tenantId: tenant.id, role, identifier, staticOtpHash: hashReviewCode(id, code) } });
    void user;
    credentials.push({ role, identifier, code });
  }
  return { tenantId: tenant.id, sessionId: session.id, expiresAt: session.expiresAt, credentials, contentPack: 'ABSENT' };
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
  syntheticUsers: number;
  syntheticVendors: number;
  contentPack: 'ABSENT' | 'PRESENT';
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
  const prefix = process.env['REVIEW_PHONE_PREFIX'] ?? DEFAULT_REVIEW_PHONE_PREFIX;
  return {
    tenant,
    sessions: sessions.map((s) => ({ id: s.id, status: s.status, anchored: s.anchoredAt !== null, anchorSource: s.anchorSource, expiresAt: s.expiresAt, lastSeenAt: s.lastSeenAt })),
    credentials,
    syntheticUsers,
    syntheticVendors,
    contentPack: syntheticVendors > 0 ? 'PRESENT' : 'ABSENT',
    phonePrefixNote: prefix === DEFAULT_REVIEW_PHONE_PREFIX
      ? `identifiers use the PLACEHOLDER prefix ${prefix} — confirm an undialable range with the carrier and set REVIEW_PHONE_PREFIX (FD-STA-6)`
      : `identifiers use REVIEW_PHONE_PREFIX=${prefix}`,
  };
}
