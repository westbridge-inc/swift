/**
 * [STA-1 operator runbook] review:provision / rotate / expire / status.
 *
 * Provisioning creates a purge-protected REVIEW tenant, a session with a TTL,
 * and a synthetic reviewer whose static code is minted once and stored only
 * as a salted hash; rotation invalidates the old code at once; expiry forces
 * DL-9; status names the content pack as ABSENT until a seed exists.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithoutTenant } from '../plugins/tenant-context';
import { provisionReviewTenant, rotateReviewCredentials, expireReviewSession, reviewStatus, DEFAULT_REVIEW_TTL_DAYS } from '../modules/review/provision';
import { hashReviewCode } from '../modules/review/credentials';

const RUN = nanoid(6).replace(/[^a-z0-9]/gi, '0').toLowerCase();
const SLUG = `review-prov-${RUN}`;
let app: FastifyInstance;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'review-provision-test');

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.ready();
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.reviewCredential.deleteMany({ where: { tenantId: SLUG } });
    await app.prisma.reviewSession.deleteMany({ where: { tenantId: SLUG } });
    await app.prisma.user.deleteMany({ where: { tenantId: SLUG } });
    await app.prisma.tenant.updateMany({ where: { id: SLUG }, data: { purgeProtected: false } });
    await app.prisma.tenant.deleteMany({ where: { id: SLUG } });
  });
  await app.close();
});

describe('[STA-1] review:provision and friends', () => {
  it('refuses a slug that does not name the fiction', async () => {
    await expect(system(() => provisionReviewTenant(app.prisma, { slug: `prod-${RUN}` }))).rejects.toThrow(/review-/);
  });

  it('provision: a purge-protected REVIEW tenant, one PROVISIONED session with the TTL, one synthetic reviewer whose code is stored only as a salted hash', async () => {
    const now = new Date('2026-09-05T12:00:00.000Z');
    const r = await system(() => provisionReviewTenant(app.prisma, { slug: SLUG, now, phonePrefix: `+59200098` }));
    expect(r.tenantId).toBe(SLUG);
    expect(r.contentPack).toBe('ABSENT');
    expect(r.expiresAt.getTime() - now.getTime()).toBe(DEFAULT_REVIEW_TTL_DAYS * 86_400_000);
    const tenant = await system(() => app.prisma.tenant.findUniqueOrThrow({ where: { id: SLUG } }));
    expect([tenant.kind, tenant.purgeProtected, tenant.isActive]).toEqual(['REVIEW', true, true]);
    const session = await system(() => app.prisma.reviewSession.findUniqueOrThrow({ where: { id: r.sessionId } }));
    expect([session.status, session.tenantId, session.anchorLat]).toEqual(['PROVISIONED', SLUG, null]);
    expect(r.credentials).toHaveLength(1);
    const [c] = r.credentials;
    expect(c!.role).toBe('CUSTOMER');
    expect(c!.identifier).toMatch(/^\+59200098\d{2}$/);
    expect(c!.code).toMatch(/^\d{6}$/);
    const row = await system(() => app.prisma.reviewCredential.findFirstOrThrow({ where: { tenantId: SLUG, identifier: c!.identifier } }));
    expect(row.staticOtpHash).toBe(hashReviewCode(row.id, c!.code));
    expect(row.staticOtpHash).not.toContain(c!.code);
    const user = await system(() => app.prisma.user.findUniqueOrThrow({ where: { phone: c!.identifier } }));
    expect([user.tenantId, user.isSynthetic, user.activeRole]).toEqual([SLUG, true, 'CUSTOMER']);
  });

  it('rotate: every credential gets a new code; the old one no longer matches the stored hash', async () => {
    const before = await system(() => app.prisma.reviewCredential.findFirstOrThrow({ where: { tenantId: SLUG } }));
    const minted = await system(() => rotateReviewCredentials(app.prisma, SLUG));
    expect(minted).toHaveLength(1);
    const after = await system(() => app.prisma.reviewCredential.findUniqueOrThrow({ where: { id: before.id } }));
    expect(after.staticOtpHash).not.toBe(before.staticOtpHash);
    expect(after.staticOtpHash).toBe(hashReviewCode(before.id, minted[0]!.code));
    expect(after.rotatedAt.getTime()).toBeGreaterThanOrEqual(before.rotatedAt.getTime());
  });

  it('status: sessions, anchors, TTLs, synthetic presence — and the content pack is honestly ABSENT', async () => {
    const s = await system(() => reviewStatus(app.prisma, SLUG));
    expect(s.tenant).toEqual({ id: SLUG, kind: 'REVIEW', purgeProtected: true, isActive: true });
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0]).toMatchObject({ status: 'PROVISIONED', anchored: false });
    expect(s.credentials).toBe(1);
    expect(s.syntheticUsers).toBe(1);
    expect(s.syntheticVendors).toBe(0);
    expect(s.contentPack).toBe('ABSENT');
    expect(s.phonePrefixNote).toMatch(/REVIEW_PHONE_PREFIX/);
    expect(await system(() => reviewStatus(app.prisma, `review-nothing-${RUN}`))).toMatchObject({ tenant: null, sessions: [], credentials: 0 });
  });

  it('expire: forces DL-9 exactly once; unknown and already-closed sessions are named, not guessed', async () => {
    const s = await system(() => reviewStatus(app.prisma, SLUG));
    const id = s.sessions[0]!.id;
    expect(await system(() => expireReviewSession(app.prisma, id))).toBe('EXPIRED');
    expect(await system(() => expireReviewSession(app.prisma, id))).toBe('ALREADY_CLOSED');
    expect(await system(() => expireReviewSession(app.prisma, `no-such-${RUN}`))).toBe('NOT_FOUND');
    const row = await system(() => app.prisma.reviewSession.findUniqueOrThrow({ where: { id } }));
    expect(row.status).toBe('EXPIRED');
  });

  it('provision again: the tenant is reused (idempotent), a fresh session and credential are minted', async () => {
    const r2 = await system(() => provisionReviewTenant(app.prisma, { slug: SLUG, phonePrefix: `+59200098` }));
    expect(r2.tenantId).toBe(SLUG);
    expect(await system(() => app.prisma.tenant.count({ where: { id: SLUG } }))).toBe(1);
    expect(await system(() => app.prisma.reviewSession.count({ where: { tenantId: SLUG } }))).toBe(2);
    expect(await system(() => app.prisma.reviewCredential.count({ where: { tenantId: SLUG } }))).toBe(2);
  });
});
