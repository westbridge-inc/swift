/**
 * [Row 349 / 353] The store-review demo session: extended in place before it
 * runs out, and when it does end, the 410 every app build sees says so in the
 * person's words — never the internal session id.
 *
 * `review:extend` moves a LIVE session's expiry later with one compare-and-set
 * UPDATE: the reviewer's login and code do not change and nothing is minted or
 * printed. It refuses, by name and without writing, an unknown session, a
 * closed one, one whose time already ran out, a date that is not later, and a
 * date further than MAX_REVIEW_EXTENSION_DAYS from now.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { PrismaClient } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithoutTenant } from '../plugins/tenant-context';
import { extendReviewSession, MAX_REVIEW_EXTENSION_DAYS } from '../modules/review/provision';
import { REVIEW_SESSION_CLOSED_MESSAGE, ReviewSessionClosedError } from '../modules/review/anchor';

const RUN = nanoid(6).replace(/[^a-z0-9]/gi, '0').toLowerCase();
const TENANT = `review-ext-${RUN}`;
const DAY = 86_400_000;
const NOW = new Date('2026-10-20T12:00:00.000Z');
let app: FastifyInstance;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'review-extend-test');
const session = (data: { status: 'PROVISIONED' | 'ANCHORED' | 'EXPIRED' | 'REVOKED'; expiresAt: Date; anchorLat?: number; anchorLng?: number }) =>
  system(() => app.prisma.reviewSession.create({ data: { tenantId: TENANT, ...data } }));
const row = (id: string) => system(() => app.prisma.reviewSession.findUniqueOrThrow({ where: { id } }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  app.get('/closed', async () => { throw new ReviewSessionClosedError('cmsecretsessionid0001', 'EXPIRED'); });
  app.get('/none', async () => { throw new ReviewSessionClosedError(null, 'EXPIRED'); });
  await app.ready();
  await system(() => app.prisma.tenant.create({ data: { id: TENANT, slug: TENANT, name: 'Review extend fixture', kind: 'REVIEW', purgeProtected: false, isActive: true } }));
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.reviewSession.deleteMany({ where: { tenantId: TENANT } });
    await app.prisma.tenant.deleteMany({ where: { id: TENANT } });
  });
  await app.close();
});

describe('[Row 349] review:extend', () => {
  it('moves a live session’s expiry later in place: status, anchor and the session itself unchanged', async () => {
    const s = await session({ status: 'ANCHORED', expiresAt: new Date(NOW.getTime() + 5 * DAY), anchorLat: 6.8, anchorLng: -58.15 });
    const until = new Date(NOW.getTime() + 40 * DAY);
    const r = await system(() => extendReviewSession(app.prisma, s.id, until, NOW));
    expect(r).toEqual({ verdict: 'EXTENDED', from: s.expiresAt, to: until });
    const after = await row(s.id);
    expect([after.id, after.status, after.expiresAt.toISOString(), after.anchorLat, after.anchorLng, after.createdAt.toISOString()])
      .toEqual([s.id, 'ANCHORED', until.toISOString(), 6.8, -58.15, s.createdAt.toISOString()]);
  });

  it('a PROVISIONED session (never opened yet) is live too', async () => {
    const s = await session({ status: 'PROVISIONED', expiresAt: new Date(NOW.getTime() + DAY) });
    const until = new Date(NOW.getTime() + MAX_REVIEW_EXTENSION_DAYS * DAY);
    expect((await system(() => extendReviewSession(app.prisma, s.id, until, NOW))).verdict).toBe('EXTENDED');
    expect((await row(s.id)).expiresAt.toISOString()).toBe(until.toISOString());
  });

  it.each([
    ['ALREADY_CLOSED', 'EXPIRED', 5 * DAY, 30 * DAY],
    ['ALREADY_CLOSED', 'REVOKED', 5 * DAY, 30 * DAY],
    ['LAPSED', 'ANCHORED', -60_000, 30 * DAY],
    ['NOT_LATER', 'ANCHORED', 5 * DAY, 5 * DAY],
    ['NOT_LATER', 'ANCHORED', 5 * DAY, 2 * DAY],
    ['TOO_FAR', 'ANCHORED', 5 * DAY, MAX_REVIEW_EXTENSION_DAYS * DAY + 60_000],
  ] as const)('refuses %s (status %s) and writes nothing', async (verdict, status, expiresIn, untilIn) => {
    const s = await session({ status, expiresAt: new Date(NOW.getTime() + expiresIn) });
    const r = await system(() => extendReviewSession(app.prisma, s.id, new Date(NOW.getTime() + untilIn), NOW));
    expect(r).toEqual({ verdict });
    const after = await row(s.id);
    expect([after.status, after.expiresAt.toISOString()]).toEqual([status, s.expiresAt.toISOString()]);
  });

  it('an unknown session and an unreadable date are named, not guessed', async () => {
    expect(await system(() => extendReviewSession(app.prisma, `missing-${RUN}`, new Date(NOW.getTime() + DAY), NOW))).toEqual({ verdict: 'NOT_FOUND' });
    const s = await session({ status: 'ANCHORED', expiresAt: new Date(NOW.getTime() + DAY) });
    expect(await system(() => extendReviewSession(app.prisma, s.id, new Date('not a date'), NOW))).toEqual({ verdict: 'NOT_LATER' });
    expect((await row(s.id)).expiresAt.toISOString()).toBe(s.expiresAt.toISOString());
  });

  it('a session expired between the read and the write is not revived: RACED, and it stays EXPIRED', async () => {
    const s = await session({ status: 'ANCHORED', expiresAt: new Date(NOW.getTime() + 5 * DAY) });
    const real = app.prisma.reviewSession;
    const racing = {
      reviewSession: {
        findUnique: async (args: Parameters<typeof real.findUnique>[0]) => {
          const read = await real.findUnique(args);
          await real.update({ where: { id: s.id }, data: { status: 'EXPIRED' } });
          return read;
        },
        updateMany: (args: Parameters<typeof real.updateMany>[0]) => real.updateMany(args),
      },
    } as unknown as Pick<PrismaClient, 'reviewSession'>;
    expect(await system(() => extendReviewSession(racing, s.id, new Date(NOW.getTime() + 30 * DAY), NOW))).toEqual({ verdict: 'RACED' });
    const after = await row(s.id);
    expect([after.status, after.expiresAt.toISOString()]).toEqual(['EXPIRED', s.expiresAt.toISOString()]);
  });
});

describe('[Row 353] the 410 every app build sees', () => {
  it.each(['/closed', '/none'])('%s: 410 REVIEW_SESSION_CLOSED with the person’s sentence, never the internal session id', async (url) => {
    const res = await app.inject(url);
    expect(res.statusCode).toBe(410);
    const body = res.json();
    expect(body.error.code).toBe('REVIEW_SESSION_CLOSED');
    expect(body.error.message).toBe(REVIEW_SESSION_CLOSED_MESSAGE);
    expect(res.body).not.toContain('cmsecretsessionid0001');
    expect(res.body).not.toMatch(/EXPIRED|REVOKED|Review session/);
  });

  it('the server keeps the id and status on the error for its own log', () => {
    const err = new ReviewSessionClosedError('cmsecretsessionid0001', 'REVOKED');
    expect([err.statusCode, err.code, err.sessionId, err.sessionStatus]).toEqual([410, 'REVIEW_SESSION_CLOSED', 'cmsecretsessionid0001', 'REVOKED']);
  });
});
