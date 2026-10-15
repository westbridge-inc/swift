import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { partnerRoutes } from '../modules/partner/partner.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import {
  LOCATION_BG_CONSENT_V1,
  LOCATION_BG_CONSENT_VERSION,
} from '../modules/partner/location-consent';

// [R18 · research B1/B5 · DPA s.7(1)] Background location is asked for
// separately, and the burden of proving the yes is Swift's. The phone's yes
// (disclosure accepted AND the system sheet granted) lands in the append-only
// consent ledger, anchored to the disclosure's exact words; repeating the same
// answer writes nothing; a withdrawal is a new row; nobody but a mover can
// write one.

let app: FastifyInstance;
const DAY = 24 * 60 * 60 * 1000;
const createdUserIds: string[] = [];
const base = 592_018_000_000 + Math.floor(Math.random() * 900_000);
let seq = 0;

async function makeUser(roles: UserRole[]) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${base + seq}`, firstName: 'Bg', lastName: `Consent${seq}`,
      roles, activeRole: roles[0]!, isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0], jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'r18', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

function post(token: string | null, payload: unknown, platform = 'android') {
  return app.inject({
    method: 'POST', url: '/api/v1/partner/consent/background-location',
    headers: {
      'content-type': 'application/json', 'x-client-platform': platform,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: payload as Record<string, unknown>,
  });
}

const ledger = (subjectId: string) => app.prisma.consentRecord.findMany({
  where: { subjectId, documentType: 'location_bg_consent' },
  orderBy: { capturedAt: 'asc' },
  select: { subjectType: true, action: true, documentVersion: true, documentContentHash: true, surface: true, evidence: true },
});

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.ready();
});

afterAll(async () => {
  // Ledger rows are append-only by design and stay (fresh subjects, no collision).
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('[R18] background-location consent in the ledger', () => {
  it('a mover\'s yes is one granted row, anchored to the disclosure\'s exact words', async () => {
    const { userId, token } = await makeUser(['RIDER']);
    const res = await post(token, { granted: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ granted: true, changed: true });

    const rows = await ledger(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subjectType: 'driver', action: 'granted', documentVersion: LOCATION_BG_CONSENT_VERSION, surface: 'android',
      documentContentHash: createHash('sha256').update(LOCATION_BG_CONSENT_V1, 'utf8').digest('hex'),
    });
    expect(rows[0]!.evidence).toMatchObject({ control: 'background_location_disclosure', osPermission: 'granted' });

    const doc = await app.prisma.legalDocument.findUniqueOrThrow({
      where: { documentType_version_locale: { documentType: 'location_bg_consent', version: LOCATION_BG_CONSENT_VERSION, locale: 'en-GY' } },
    });
    expect(doc.renderedText).toBe(LOCATION_BG_CONSENT_V1);
    expect(doc.publishedAt).not.toBeNull();
  });

  it('the disclosure words are pinned: new words need a new version', () => {
    expect(LOCATION_BG_CONSENT_VERSION).toBe('v1');
    expect(LOCATION_BG_CONSENT_V1.split('\n')).toEqual([
      'Swift needs your location in the background',
      'While you are online, Swift collects your location even when the app is closed or not in use — so jobs can reach you, and so the customer can watch their delivery move.',
      'Where you are, while you are online',
      'Sent only to Swift — never sold, never shared with advertisers',
      'Stops the moment you go offline',
      'You can go online either way. Without background access Swift tracks you only while the app is on screen.',
      '[Allow background location] [Only while app is open]',
    ]);
  });

  it('repeating yes writes nothing; no then yes are new rows (withdrawn, re_granted)', async () => {
    const { userId, token } = await makeUser(['DRIVER']);
    expect((await post(token, { granted: true }, 'ios')).json().data).toEqual({ granted: true, changed: true });
    expect((await post(token, { granted: true }, 'ios')).json().data).toEqual({ granted: true, changed: false });
    expect((await post(token, { granted: false }, 'ios')).json().data).toEqual({ granted: false, changed: true });
    expect((await post(token, { granted: false }, 'ios')).json().data).toEqual({ granted: false, changed: false });
    expect((await post(token, { granted: true }, 'ios')).json().data).toEqual({ granted: true, changed: true });
    expect((await ledger(userId)).map((r) => [r.action, r.surface])).toEqual([
      ['granted', 'ios'], ['withdrawn', 'ios'], ['re_granted', 'ios'],
    ]);
  });

  it('a no from someone who never said yes writes nothing', async () => {
    const { userId, token } = await makeUser(['MOVER']);
    expect((await post(token, { granted: false })).json().data).toEqual({ granted: false, changed: false });
    expect(await ledger(userId)).toHaveLength(0);
  });

  it('two yeses at once leave one row', async () => {
    const { userId, token } = await makeUser(['RIDER']);
    const answers = await Promise.all([post(token, { granted: true }), post(token, { granted: true }), post(token, { granted: true })]);
    expect(answers.map((a) => a.statusCode)).toEqual([200, 200, 200]);
    expect(await ledger(userId)).toHaveLength(1);
  });

  it('only movers: a customer is refused before the body is read, and nothing is written', async () => {
    const { userId, token } = await makeUser(['CUSTOMER']);
    const refused = await post(token, { granted: true });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('NOT_A_MOVER');
    expect((await post(token, { nonsense: 1 })).statusCode).toBe(403);
    expect(await ledger(userId)).toHaveLength(0);
  });

  it('no token is 401; a malformed body is 400 and writes nothing', async () => {
    expect((await post(null, { granted: true })).statusCode).toBe(401);
    const { userId, token } = await makeUser(['RIDER']);
    expect((await post(token, { granted: 'yes' })).statusCode).toBe(400);
    expect((await post(token, { granted: true, extra: 1 })).statusCode).toBe(400);
    expect(await ledger(userId)).toHaveLength(0);
  });
});
