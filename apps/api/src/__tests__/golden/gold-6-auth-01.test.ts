import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../../plugins/prisma';
import { redisPlugin } from '../../plugins/redis';
import { authPlugin } from '../../plugins/auth';
import { socketPlugin } from '../../plugins/socket';
import { registerErrorHandler } from '../../middleware/error-handler';
import { authRoutes } from '../../modules/auth/auth.routes';
import { devChannelLog, getChannels, resetDevChannelLog } from '../../providers/notifications/channels';
import { LEGAL_VERSION } from '../../modules/legal/legal.routes';
import { hashSignal, normalizePhone } from '../../modules/integrity/normalize';
import { guyanaDayKey } from '../../utils/guyana-day';

// ---------------------------------------------------------------------------
// GOLD-6 · AUTH-01 — Guyana-only phone signup + OTP, the pilot's golden journey.
//
// ONE real Fastify composition (prismaPlugin / redisPlugin / authPlugin /
// socketPlugin with the REAL mounted auth route module) drives the whole
// unauthenticated signup journey — send-otp → verify-otp → register →
// GET /me — as real requests, asserted on durable rows:
//
//   · happy path: a Guyana number gets a code; the code issues ONE single-use
//     registration proof; register creates exactly one account (customer row,
//     OTP session, consent ledgered at LEGAL_VERSION) and the issued session
//     serves GET /me
//   · bad/expired OTP: a wrong code is refused (400 INVALID_OTP) without
//     consuming the ceremony; a lapsed record refuses the REAL code; five
//     wrong guesses lock the code even for the real one
//   · resend throttling: a second send within the 60s cooldown is refused
//     (429 RATE_LIMITED) before a second SMS leaves, and the armed code stands
//   · non-Guyana denial: a Trinidad number is refused at the front door
//     (400 COUNTRY_NOT_ACTIVE) before any budget/rate counter or SMS is spent
//   · registration replay: the exact same register request replays to a
//     refusal (403 REGISTRATION_PROOF_REQUIRED), a proof is phone-bound, and
//     exactly one account / customer / session / signup attempt exists
//
// Device-gated (stated, never faked): real SMS delivery through Twilio. Codes
// are read from the dev notification channel log (providers/notifications/
// channels.ts) — the same seam the other golden suites use. The OTP check is
// never bypassed: DEV_OTP_BYPASS stays pinned off by the vitest config.
//
// Phone prefix +5920276 — grep-proven unused in apps/api/src before this file.
// Consent rows are append-only at the database (DCR-1 NR-1): this file never
// deletes them — subject ids are fresh per run, so residue cannot collide.
// ---------------------------------------------------------------------------

const PHONE_PREFIX = '+5920276';
/** Trinidad & Tobago — a real Caribbean market that is NOT in the V1 launch. */
const FOREIGN_PHONE = '+18682001234';
const FIXTURE = 'gold6-auth01-fixture';

let app: FastifyInstance;
let seq = 0;
const phone = () => { seq += 1; return `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`; };
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);

function post(url: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url,
    payload,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function get(url: string, headers: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url, headers });
}

const smsTo = (p: string) => devChannelLog.filter((e) => e.channel === 'sms' && e.to === p);

/** The code the REAL send-otp path handed the dev SMS adapter. */
function codeFor(p: string): string {
  const sms = [...devChannelLog].reverse().find((e) => e.channel === 'sms' && e.to === p);
  const code = sms?.body.match(/verification code is: (\d{6})/)?.[1];
  expect(code, `expected one dev SMS carrying a 6-digit code for ${p}`).toBeTruthy();
  return code!;
}

async function sendCode(p: string): Promise<string> {
  const res = await post('/api/v1/auth/send-otp', { phone: p });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().success).toBe(true);
  expect(res.json().data).toEqual({ message: 'OTP sent successfully', expiresIn: 300 });
  return codeFor(p);
}

const wrongCode = (real: string) => (real === '000000' ? '111111' : '000000');

/**
 * The fenced OTP record's Redis key derives from the same documented hash the
 * service uses (signup-continuation.ts `phoneSlot`). It is replicated here ONLY
 * to shorten the record's TTL for the expiry case — never to read, forge or
 * otherwise reach a code (codes are HMAC-hashed at rest).
 */
const otpRecordKey = (p: string) => `signup_otp:{${createHash('sha256').update('swift:signup-phone:v1\0').update(p).digest('hex')}}:record`;

async function waitFor(cond: () => Promise<boolean>, withinMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > withinMs) throw new Error('waitFor condition not met');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A crashed earlier run leaves nothing this file's deterministic numbers can
 *  collide with. Consent rows are deliberately left: consent_records is
 *  append-only at the database (a BEFORE DELETE trigger refuses the janitor). */
async function purgeFixtures() {
  await sys(async () => {
    const users = await app.prisma.user.findMany({
      where: { phone: { startsWith: PHONE_PREFIX } },
      select: { id: true },
    });
    const ids = users.map((u) => u.id);
    if (ids.length > 0) {
      const members = await app.prisma.identityClusterMember.findMany({
        where: { accountId: { in: ids } },
        select: { clusterId: true },
      });
      const clusterIds = [...new Set(members.map((m) => m.clusterId))];
      await app.prisma.exceptionGrant.deleteMany({ where: { clusterId: { in: clusterIds } } });
      await app.prisma.identityKey.deleteMany({ where: { accountId: { in: ids } } });
      await app.prisma.identityClusterMember.deleteMany({ where: { accountId: { in: ids } } });
      await app.prisma.identityCluster.deleteMany({
        where: { OR: [{ id: { in: clusterIds } }, { mergedIntoId: { in: clusterIds } }] },
      });
      await app.prisma.enforcementAction.deleteMany({ where: { accountId: { in: ids } } });
      await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
      await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    // Signup velocity rows carry only hashes — select them by the same
    // deterministic phone hash captureSignup writes (16 covers every case
    // plus any crashed run).
    const phoneHashes = Array.from({ length: 16 }, (_, i) =>
      hashSignal(normalizePhone(`${PHONE_PREFIX}${String(i + 1).padStart(3, '0')}`)));
    await app.prisma.signupAttempt.deleteMany({ where: { phoneHash: { in: phoneHashes } } });
  });

  // Redis hygiene: per-phone cooldowns/hourly/budget keys, this slot's fenced
  // OTP/continuation keys (the proof-keyed digest is unpredictable, so it is
  // swept by scan), and the loopback per-IP daily budget counter. The shared
  // global daily counter is never touched — other suites own it.
  const day = guyanaDayKey(new Date());
  const redisKeys: string[] = [`otp_ip_day:${day}:127.0.0.1`];
  for (let i = 1; i <= 16; i += 1) {
    const p = `${PHONE_PREFIX}${String(i).padStart(3, '0')}`;
    const slot = createHash('sha256').update('swift:signup-phone:v1\0').update(p).digest('hex');
    redisKeys.push(`otp_rate:${p}`, `otp_hr:${p}`, `otp_attempt:${p}`, `otp:${p}`, `otp_phone_day:${day}:${p}`);
    redisKeys.push(`signup_otp:{${slot}}:record`, `signup_continuation:{${slot}}:otp_generation`, `signup_continuation:{${slot}}:current`);
    let cursor = '0';
    do {
      const [next, keys] = await app.redis.scan(cursor, 'MATCH', `signup_continuation:{${slot}}:*`, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) redisKeys.push(...keys);
    } while (cursor !== '0');
  }
  await app.redis.del(...redisKeys);
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  // Keep the shared daily SMS budgets out of the way — this suite exercises
  // the OTP ceremony, not the cost ceilings (each ceiling has its own suite).
  process.env['OTP_PHONE_DAILY_CAP'] = '1000';
  process.env['OTP_GLOBAL_DAILY_CAP'] = '1000000';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  // The production composition (app.ts) gives every request a fresh tenant
  // store before auth — replicate it.
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.ready();

  // Every SMS in this file must land in the dev adapter's in-memory log, never
  // a real provider: the configured provider is the dev one (checked first),
  // and a probe sent through the configured channel appears in the dev log.
  expect(process.env['NOTIFICATION_PROVIDER'] ?? 'dev').toBe('dev');
  resetDevChannelLog();
  await getChannels().sms.sendSms(`${PHONE_PREFIX}999`, 'gold6 channel probe');
  expect(devChannelLog.filter((e) => e.channel === 'sms' && e.to === `${PHONE_PREFIX}999`)).toHaveLength(1);
  resetDevChannelLog();

  await purgeFixtures();
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

beforeEach(() => resetDevChannelLog());

describe('GOLD-6 · AUTH-01 — happy path: send-otp → verify-otp → register → GET /me', () => {
  it('one Guyana number walks the full journey and leaves exactly the durable rows it promised', async () => {
    const phoneNumber = phone();

    const sent = await post('/api/v1/auth/send-otp', { phone: phoneNumber });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json().data).toEqual({ message: 'OTP sent successfully', expiresIn: 300 });
    const code = codeFor(phoneNumber);
    expect(smsTo(phoneNumber)).toHaveLength(1);

    const verified = await post('/api/v1/auth/verify-otp', { phone: phoneNumber, code });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json().data.isNewUser).toBe(true);
    expect(verified.json().data.phone).toBe(phoneNumber);
    const proof = verified.json().data.registrationProof as string;
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verified.json().data.expiresIn).toBe(600);

    const registered = await post('/api/v1/auth/register', {
      phone: phoneNumber,
      registrationProof: proof,
      firstName: 'Gold6',
      lastName: 'Pilot',
      role: 'CUSTOMER',
      countryCode: 'GY',
      acceptTerms: true,
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const regData = registered.json().data;
    expect(regData.user.phone).toBe(phoneNumber);
    expect(regData.user.firstName).toBe('Gold6');
    expect(regData.user.lastName).toBe('Pilot');
    expect(regData.user.roles).toEqual(['CUSTOMER']);
    expect(regData.user.activeRole).toBe('CUSTOMER');
    expect(regData.user.countryCode).toBe('GY');
    expect(regData.user.isPhoneVerified).toBe(true);
    expect(regData.user.trustLevel).toBe('L1');
    expect(regData.user.status).toBe('ACTIVE');
    expect(regData.user.customer).toBeDefined();
    expect(regData.tokens.accessToken).toBeTruthy();
    expect(regData.tokens.refreshToken).toBeTruthy();
    expect(regData.tokens.expiresIn).toBe(900);
    expect(regData.onboarding).toEqual({ next: 'BROWSE', requiredDocuments: [] });

    // The session issued by register serves the authenticated read.
    const me = await get('/api/v1/auth/me', { authorization: `Bearer ${regData.tokens.accessToken}` });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().data.user.id).toBe(regData.user.id);
    expect(me.json().data.user.phone).toBe(phoneNumber);
    expect(me.json().data.user.firstName).toBe('Gold6');
    expect(me.json().data.user.roles).toEqual(['CUSTOMER']);
    expect(me.json().data.user.status).toBe('ACTIVE');
    expect(me.json().data.client).toBeNull();
    expect(me.json().data.sessionId).toBeTruthy();

    // Durable rows: one account, its customer, its OTP session, its consent.
    const user = await sys(() => app.prisma.user.findUniqueOrThrow({ where: { phone: phoneNumber } }));
    expect(user.id).toBe(regData.user.id);
    expect(user.roles).toEqual(['CUSTOMER']);
    expect(user).toMatchObject({
      isPhoneVerified: true,
      trustLevel: 'L1',
      countryCode: 'GY',
      status: 'ACTIVE',
      tenantId: 'swift-default',
      tosVersion: LEGAL_VERSION,
    });
    expect(user.acceptedTermsAt).toBeInstanceOf(Date);
    await sys(() => app.prisma.customer.findUniqueOrThrow({ where: { userId: user.id } }));
    const session = await sys(() => app.prisma.session.findUniqueOrThrow({ where: { token: regData.tokens.accessToken } }));
    expect(session.userId).toBe(user.id);
    expect(session.authMethod).toBe('OTP');
    expect(me.json().data.sessionId).toBe(session.id);
    // Consent is ledgered with the exact legal version, in the same
    // transaction as the account.
    const consents = await sys(() => app.prisma.consentRecord.findMany({ where: { subjectId: user.id } }));
    expect(consents.map((c) => c.documentType).sort()).toEqual(['privacy_policy', 'terms_of_service']);
    expect(consents.every((c) =>
      c.subjectType === 'customer' && c.action === 'granted' && c.documentVersion === LEGAL_VERSION)).toBe(true);
    // The /me tenant view agrees with the account's real tenant row.
    const tenant = await sys(() => app.prisma.tenant.findUniqueOrThrow({ where: { id: 'swift-default' } }));
    expect(me.json().data.user.tenant).toEqual({ kind: tenant.kind });

    // Wrong-party refusals on the authenticated read: nobody else's
    // credential — or none at all — opens /me.
    expect((await get('/api/v1/auth/me')).statusCode).toBe(401);
    const forged = await get('/api/v1/auth/me', { authorization: 'Bearer not-a-real-token' });
    expect(forged.statusCode).toBe(401);
    expect(forged.json().error.code).toBe('UNAUTHORIZED');
  });
});

describe('GOLD-6 · AUTH-01 — bad and expired OTP', () => {
  it('a wrong code is refused with its real error and does not consume the ceremony', async () => {
    const phoneNumber = phone();
    const code = await sendCode(phoneNumber);

    const wrong = await post('/api/v1/auth/verify-otp', { phone: phoneNumber, code: wrongCode(code) });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('INVALID_OTP');
    expect(wrong.json().error.message).toContain('Invalid OTP code');

    const real = await post('/api/v1/auth/verify-otp', { phone: phoneNumber, code });
    expect(real.statusCode, real.body).toBe(200);
    expect(real.json().data.isNewUser).toBe(true);
    expect(await sys(() => app.prisma.user.count({ where: { phone: phoneNumber } }))).toBe(0);
  });

  it('an expired code refuses even the real 6 digits (the record lapsed)', async () => {
    const phoneNumber = phone();
    const code = await sendCode(phoneNumber);

    // Shorten the REAL record's 300s TTL to milliseconds instead of sleeping
    // through five minutes: the verify path then sees a lapsed record, which
    // is exactly the expiry refusal.
    const recordKey = otpRecordKey(phoneNumber);
    expect(await app.redis.pexpire(recordKey, 50)).toBe(1);
    await waitFor(async () => (await app.redis.get(recordKey)) === null);

    const verified = await post('/api/v1/auth/verify-otp', { phone: phoneNumber, code });
    expect(verified.statusCode).toBe(400);
    expect(verified.json().error.code).toBe('INVALID_OTP');
    expect(verified.json().error.message).toMatch(/expired or not found/i);
    expect(await sys(() => app.prisma.user.count({ where: { phone: phoneNumber } }))).toBe(0);
  });

  it('five wrong guesses lock the code even for the real one', async () => {
    const phoneNumber = phone();
    const code = await sendCode(phoneNumber);
    const wrong = wrongCode(code);

    for (let i = 0; i < 5; i += 1) {
      const attempt = await post('/api/v1/auth/verify-otp', { phone: phoneNumber, code: wrong });
      expect(attempt.statusCode, attempt.body).toBe(400);
      expect(attempt.json().error.code).toBe('INVALID_OTP');
      expect(attempt.json().error.message).toContain('Invalid OTP code');
    }

    const locked = await post('/api/v1/auth/verify-otp', { phone: phoneNumber, code });
    expect(locked.statusCode).toBe(400);
    expect(locked.json().error.code).toBe('INVALID_OTP');
    expect(locked.json().error.message).toMatch(/too many attempts/i);
    expect(await sys(() => app.prisma.user.count({ where: { phone: phoneNumber } }))).toBe(0);
  });
});

describe('GOLD-6 · AUTH-01 — resend throttling', () => {
  it('a second send within the 60s cooldown is refused before another SMS leaves, and the armed code stands', async () => {
    const phoneNumber = phone();
    const code = await sendCode(phoneNumber);

    const again = await post('/api/v1/auth/send-otp', { phone: phoneNumber });
    expect(again.statusCode).toBe(429);
    expect(again.json().error.code).toBe('RATE_LIMITED');
    expect(again.json().error.message).toContain('Please wait before requesting another OTP');
    expect(smsTo(phoneNumber)).toHaveLength(1);

    const verified = await post('/api/v1/auth/verify-otp', { phone: phoneNumber, code });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json().data.isNewUser).toBe(true);
    expect(await sys(() => app.prisma.user.count({ where: { phone: phoneNumber } }))).toBe(0);
  });
});

describe('GOLD-6 · AUTH-01 — non-Guyana denial', () => {
  it('a Trinidad number is refused at the front door before any budget counter or SMS is spent', async () => {
    const day = guyanaDayKey(new Date());
    const globalBefore = Number((await app.redis.get(`sms_global_day:${day}`)) ?? 0);

    const refused = await post('/api/v1/auth/send-otp', { phone: FOREIGN_PHONE });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('COUNTRY_NOT_ACTIVE');
    expect(refused.json().error.message).toContain('available in Guyana only');

    expect(smsTo(FOREIGN_PHONE)).toHaveLength(0);
    expect(Number((await app.redis.get(`sms_global_day:${day}`)) ?? 0)).toBe(globalBefore);
    expect(await app.redis.get(`otp_rate:${FOREIGN_PHONE}`)).toBeNull();
    expect(await app.redis.get(`otp_hr:${FOREIGN_PHONE}`)).toBeNull();
  });
});

describe('GOLD-6 · AUTH-01 — registration replay', () => {
  it('the same register request replays to a refusal, a proof is phone-bound, and exactly one account exists', async () => {
    const phoneNumber = phone();
    const code = await sendCode(phoneNumber);
    const verified = await post('/api/v1/auth/verify-otp', { phone: phoneNumber, code });
    expect(verified.statusCode, verified.body).toBe(200);
    const proof = verified.json().data.registrationProof as string;
    const payload = { phone: phoneNumber, registrationProof: proof, firstName: 'Replay', lastName: 'Once', acceptTerms: true };

    // Wrong party FIRST, while the proof is still live [DS245 G6A1]: the proof
    // is phone-bound, so another number cannot spend it. (Tried after the
    // legitimate register, it would be refused only because the proof was
    // already consumed — proving nothing about the binding.)
    const otherPhone = phone();
    const stolen = await post('/api/v1/auth/register', { ...payload, phone: otherPhone });
    expect(stolen.statusCode).toBe(403);
    expect(stolen.json().error.code).toBe('REGISTRATION_PROOF_REQUIRED');
    expect(await sys(() => app.prisma.user.count({ where: { phone: otherPhone } }))).toBe(0);

    // The owner's proof survived the stolen attempt and still registers.
    const first = await post('/api/v1/auth/register', payload);
    expect(first.statusCode, first.body).toBe(201);
    const userId = first.json().data.user.id as string;

    // The registration window is single-use: the exact same request replays
    // to the same refusal a proof-less caller gets.
    const replay = await post('/api/v1/auth/register', payload);
    expect(replay.statusCode).toBe(403);
    expect(replay.json().error.code).toBe('REGISTRATION_PROOF_REQUIRED');

    // Durable: exactly ONE account, ONE customer, ONE session, ONE consent
    // grant pair and ONE signup-attempt row — the replay wrote nothing.
    const rows = await sys(() => app.prisma.user.findMany({ where: { phone: { in: [phoneNumber, otherPhone] } } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(userId);
    expect(await sys(() => app.prisma.customer.count({ where: { userId } }))).toBe(1);
    expect(await sys(() => app.prisma.session.count({ where: { userId } }))).toBe(1);
    expect(await sys(() => app.prisma.consentRecord.count({ where: { subjectId: userId, action: 'granted' } }))).toBe(2);
    expect(await sys(() => app.prisma.signupAttempt.count({
      where: { phoneHash: hashSignal(normalizePhone(phoneNumber)) },
    }))).toBe(1);
  });
});
