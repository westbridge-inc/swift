/**
 * [STA-1 operator runbook] review:provision / rotate / expire / status.
 *
 * Provisioning creates a purge-protected REVIEW tenant, a session with a TTL,
 * and three synthetic logins — a customer, a delivery rider and a taxi driver
 * — each with its own fictional identifier and a static code minted once and
 * stored only as a salted hash; rotation invalidates the old codes at once;
 * expiry forces DL-9; status names the content pack as ABSENT until a seed exists.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithoutTenant } from '../plugins/tenant-context';
import { provisionReviewTenant, rotateReviewCredentials, expireReviewSession, reviewStatus, DEFAULT_REVIEW_TTL_DAYS, DEFAULT_REVIEW_PHONE_PREFIX, REVIEW_IDENTIFIER_ATTEMPTS, ReviewProvisionRefusedError, reviewIdentifierDigits } from '../modules/review/provision';
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

const REAL = `review-real-${RUN}`;
const RACE = `review-race-${RUN}`;
const CLASH = `review-clash-${RUN}`;
const WIDE = `review-wide-${RUN}`;
const FULL = `review-full-${RUN}`;

afterAll(async () => {
  await system(async () => {
    for (const t of [REAL, RACE, CLASH, WIDE, FULL]) {
      await app.prisma.reviewCredential.deleteMany({ where: { tenantId: t } });
      await app.prisma.reviewSession.deleteMany({ where: { tenantId: t } });
      await app.prisma.user.deleteMany({ where: { tenantId: t } });
      await app.prisma.tenant.updateMany({ where: { id: t }, data: { purgeProtected: false } });
      await app.prisma.tenant.deleteMany({ where: { id: t } });
    }
    await app.prisma.reviewCredential.deleteMany({ where: { tenantId: SLUG } });
    await app.prisma.reviewSession.deleteMany({ where: { tenantId: SLUG } });
    await app.prisma.user.deleteMany({ where: { tenantId: SLUG } });
    await app.prisma.tenant.updateMany({ where: { id: SLUG }, data: { purgeProtected: false } });
    await app.prisma.tenant.deleteMany({ where: { id: SLUG } });
  });
  await app.close();
});

describe('[STA-1] review:provision and friends', () => {
  it('refuses an EXISTING tenant of another kind, even with a review-style slug, and changes nothing: no conversion, session, login or user', async () => {
    await system(() => app.prisma.tenant.create({ data: { id: REAL, slug: REAL, name: 'A real operator', kind: 'PRODUCTION', purgeProtected: false, isActive: true } }));
    const before = await system(() => app.prisma.tenant.findUniqueOrThrow({ where: { id: REAL } }));
    const err = await system(() => provisionReviewTenant(app.prisma, { slug: REAL, phonePrefix: '+59200098' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewProvisionRefusedError);
    expect((err as Error).message).toMatch(/PRODUCTION, not REVIEW/);
    expect(await system(() => app.prisma.tenant.findUniqueOrThrow({ where: { id: REAL } }))).toEqual(before);
    expect(await system(() => app.prisma.reviewSession.count({ where: { tenantId: REAL } }))).toBe(0);
    expect(await system(() => app.prisma.reviewCredential.count({ where: { tenantId: REAL } }))).toBe(0);
    expect(await system(() => app.prisma.user.count({ where: { tenantId: REAL } }))).toBe(0);
  });

  it('two provisions racing on a fresh slug settle on ONE review tenant, each with its own session and logins', async () => {
    const [a, b] = await Promise.all([
      system(() => provisionReviewTenant(app.prisma, { slug: RACE, phonePrefix: '+59200098' })),
      system(() => provisionReviewTenant(app.prisma, { slug: RACE, phonePrefix: '+59200098' })),
    ]);
    expect([a.tenantId, b.tenantId]).toEqual([RACE, RACE]);
    const t = await system(() => app.prisma.tenant.findUniqueOrThrow({ where: { id: RACE } }));
    expect([t.kind, t.purgeProtected, t.isActive]).toEqual(['REVIEW', true, true]);
    expect(await system(() => app.prisma.reviewSession.count({ where: { tenantId: RACE } }))).toBe(2);
    // Both runs drew from the same range: every login is its own, none was lost.
    expect(new Set([...a.credentials, ...b.credentials].map((c) => c.identifier)).size).toBe(6);
    expect(await system(() => app.prisma.reviewCredential.count({ where: { tenantId: RACE } }))).toBe(6);
  });

  it('a number taken between the look-up and the insert is not a failure: the login draws another number', async () => {
    // Another account takes the drawn number just before our insert — what a
    // second provisioning run on the same range does (the CI race, 14 Oct).
    const prefix = '+59200096';
    let taken = '';
    for (let n = 0; n < 100 && !taken; n++) {
      const candidate = `${prefix}${String(n).padStart(2, '0')}`;
      if (!(await system(() => app.prisma.user.findUnique({ where: { phone: candidate }, select: { id: true } })))) taken = candidate;
    }
    expect(taken).not.toBe('');
    const realRandomInt = crypto.randomInt.bind(crypto) as (min: number, max: number) => number;
    let first = true;
    const draws = vi.spyOn(crypto, 'randomInt').mockImplementation(((min: number, max: number) => {
      if (max === 100 && first) { first = false; return Number(taken.slice(-2)); }
      return realRandomInt(min, max);
    }) as unknown as typeof crypto.randomInt);
    let racerId = '';
    const db = app.prisma;
    const users = new Proxy(db.user, { get(target, prop) {
      if (prop === 'create') {
        return async (args: { data: { phone?: string } }) => {
          if (args.data.phone === taken && !racerId) {
            racerId = (await target.create({ data: { phone: taken, firstName: 'Racing', lastName: 'Provision', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', tenantId: CLASH, isSynthetic: true } })).id;
          }
          return target.create(args as never);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const racing = new Proxy(db, { get(target, prop) {
      if (prop === 'user') return users;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as typeof db;
    try {
      const r = await system(() => provisionReviewTenant(racing, { slug: CLASH, phonePrefix: prefix }));
      expect(racerId, 'the racer took the number first').not.toBe('');
      const customer = r.credentials.find((c) => c.role === 'CUSTOMER')!;
      expect(customer.identifier).not.toBe(taken);
      expect(customer.identifier).toMatch(/^\+59200096\d{2}$/);
      expect(r.credentials).toHaveLength(3);
      // The racer keeps its number; ours is a different account.
      const holder = await system(() => app.prisma.user.findUniqueOrThrow({ where: { phone: taken }, select: { id: true } }));
      expect(holder.id).toBe(racerId);
      expect(await system(() => app.prisma.reviewCredential.count({ where: { tenantId: CLASH } }))).toBe(3);
    } finally {
      draws.mockRestore();
    }
  });

  it('a full range is reported, never retried forever: after REVIEW_IDENTIFIER_ATTEMPTS draws the run stops with a clear message and makes no login', async () => {
    const prefix = '+59200096';
    let held = '';
    for (let n = 99; n >= 0 && !held; n--) {
      const candidate = `${prefix}${String(n).padStart(2, '0')}`;
      if (!(await system(() => app.prisma.user.findUnique({ where: { phone: candidate }, select: { id: true } })))) held = candidate;
    }
    expect(held).not.toBe('');
    await system(() => app.prisma.tenant.create({ data: { id: FULL, slug: FULL, name: 'Full range', kind: 'REVIEW', purgeProtected: true, isActive: true } }));
    await system(() => app.prisma.user.create({ data: { phone: held, firstName: 'Holder', lastName: 'Account', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', tenantId: FULL, isSynthetic: true } }));
    const realRandomInt = crypto.randomInt.bind(crypto) as (min: number, max: number) => number;
    let identifierDraws = 0;
    // Every draw lands on the one held number: the range is, in effect, full.
    const draws = vi.spyOn(crypto, 'randomInt').mockImplementation(((min: number, max: number) => {
      if (max === 100) { identifierDraws += 1; return Number(held.slice(-2)); }
      return realRandomInt(min, max);
    }) as unknown as typeof crypto.randomInt);
    try {
      await expect(system(() => provisionReviewTenant(app.prisma, { slug: FULL, phonePrefix: prefix })))
        .rejects.toThrow(`no free number under ${prefix} in ${REVIEW_IDENTIFIER_ATTEMPTS} draws`);
    } finally {
      draws.mockRestore();
    }
    expect(identifierDraws).toBe(REVIEW_IDENTIFIER_ATTEMPTS);
    expect(await system(() => app.prisma.reviewCredential.count({ where: { tenantId: FULL } }))).toBe(0);
    expect(await system(() => app.prisma.user.count({ where: { tenantId: FULL } }))).toBe(1);
  });

  it('identifiers fill a full Guyana number (+592 and seven digits, the length the app accepts): the default range holds 10,000 numbers', async () => {
    const r = await system(() => provisionReviewTenant(app.prisma, { slug: WIDE, phonePrefix: '+592006' }));
    for (const c of r.credentials) expect(c.identifier).toMatch(/^\+592006\d{4}$/);
    expect(reviewIdentifierDigits(DEFAULT_REVIEW_PHONE_PREFIX)).toBe(4);
    expect(DEFAULT_REVIEW_PHONE_PREFIX.length + reviewIdentifierDigits(DEFAULT_REVIEW_PHONE_PREFIX)).toBe('+5926123456'.length);
    // A longer prefix keeps its two digits, as before.
    expect(reviewIdentifierDigits('+59200098')).toBe(2);
    expect(reviewIdentifierDigits('+592000650')).toBe(2);
  });

  it('refuses a slug that does not name the fiction', async () => {
    await expect(system(() => provisionReviewTenant(app.prisma, { slug: `prod-${RUN}` }))).rejects.toThrow(/review-/);
  });

  it('provision: a purge-protected REVIEW tenant, one PROVISIONED session with the TTL, three synthetic logins whose codes are stored only as salted hashes', async () => {
    const now = new Date('2026-09-05T12:00:00.000Z');
    const r = await system(() => provisionReviewTenant(app.prisma, { slug: SLUG, now, phonePrefix: `+59200098` }));
    expect(r.tenantId).toBe(SLUG);
    expect(r.contentPack).toBe('ABSENT');
    expect(r.expiresAt.getTime() - now.getTime()).toBe(DEFAULT_REVIEW_TTL_DAYS * 86_400_000);
    const tenant = await system(() => app.prisma.tenant.findUniqueOrThrow({ where: { id: SLUG } }));
    expect([tenant.kind, tenant.purgeProtected, tenant.isActive]).toEqual(['REVIEW', true, true]);
    const session = await system(() => app.prisma.reviewSession.findUniqueOrThrow({ where: { id: r.sessionId } }));
    expect([session.status, session.tenantId, session.anchorLat]).toEqual(['PROVISIONED', SLUG, null]);
    expect(r.credentials.map((x) => x.role)).toEqual(['CUSTOMER', 'RIDER', 'DRIVER']);
    expect(new Set(r.credentials.map((x) => x.identifier)).size).toBe(3);
    for (const x of r.credentials) {
      const stored = await system(() => app.prisma.reviewCredential.findFirstOrThrow({ where: { tenantId: SLUG, identifier: x.identifier } }));
      expect([stored.role, stored.staticOtpHash]).toEqual([x.role, hashReviewCode(stored.id, x.code)]);
    }
    const [c] = r.credentials;
    expect(c!.role).toBe('CUSTOMER');
    expect(c!.identifier).toMatch(/^\+59200098\d{2}$/);
    expect(c!.code).toMatch(/^\d{6}$/);
    const row = await system(() => app.prisma.reviewCredential.findFirstOrThrow({ where: { tenantId: SLUG, identifier: c!.identifier } }));
    expect(row.staticOtpHash).toBe(hashReviewCode(row.id, c!.code));
    expect(row.staticOtpHash).not.toContain(c!.code);
    const user = await system(() => app.prisma.user.findUniqueOrThrow({ where: { phone: c!.identifier } }));
    expect([user.tenantId, user.isSynthetic, user.activeRole]).toEqual([SLUG, true, 'CUSTOMER']);
    // The app signs a persisted session out when roles is empty or lacks the
    // active role (authHydration "invalid_roles"): the reviewer must survive a restart.
    expect(user.roles).toEqual(['CUSTOMER']);
    // The partners are shaped as production movers: MOVER + CUSTOMER + their role, active and remembered.
    for (const [role, roles] of [['RIDER', ['MOVER', 'CUSTOMER', 'RIDER']], ['DRIVER', ['MOVER', 'CUSTOMER', 'DRIVER']]] as const) {
      const minted = r.credentials.find((x) => x.role === role)!;
      expect(minted.identifier).toMatch(/^\+59200098\d{2}$/);
      const partner = await system(() => app.prisma.user.findUniqueOrThrow({ where: { phone: minted.identifier } }));
      expect([partner.tenantId, partner.isSynthetic, partner.activeRole, partner.lastMoverRole]).toEqual([SLUG, true, role, role]);
      expect(partner.roles).toEqual([...roles]);
    }
  });

  it('rotate: every credential gets a new code; the old one no longer matches the stored hash', async () => {
    const before = await system(() => app.prisma.reviewCredential.findFirstOrThrow({ where: { tenantId: SLUG, role: 'DRIVER' } }));
    const minted = await system(() => rotateReviewCredentials(app.prisma, SLUG));
    expect(minted.map((m) => m.role).sort()).toEqual(['CUSTOMER', 'DRIVER', 'RIDER']);
    const after = await system(() => app.prisma.reviewCredential.findUniqueOrThrow({ where: { id: before.id } }));
    expect(after.staticOtpHash).not.toBe(before.staticOtpHash);
    expect(after.staticOtpHash).toBe(hashReviewCode(before.id, minted.find((m) => m.identifier === before.identifier)!.code));
    expect(after.rotatedAt.getTime()).toBeGreaterThanOrEqual(before.rotatedAt.getTime());
  });

  it('status: sessions, anchors, TTLs, synthetic presence — and the content pack is honestly ABSENT', async () => {
    const s = await system(() => reviewStatus(app.prisma, SLUG));
    expect(s.tenant).toEqual({ id: SLUG, kind: 'REVIEW', purgeProtected: true, isActive: true });
    expect(s.sessions).toHaveLength(1);
    expect(s.sessions[0]).toMatchObject({ status: 'PROVISIONED', anchored: false });
    expect(s.credentials).toBe(3);
    expect(s.credentialsByRole).toEqual({ CUSTOMER: 1, RIDER: 1, DRIVER: 1 });
    expect(s.syntheticUsers).toBe(3);
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
    expect(await system(() => app.prisma.reviewCredential.count({ where: { tenantId: SLUG } }))).toBe(6);
  });
});
