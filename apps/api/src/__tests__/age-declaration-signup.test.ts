import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { requestOtp, registrationProofFor } from './helpers/otp';
import { SIGNUP_CONTINUATION_COOKIE, resetBrowserOriginsForTests } from '../modules/auth/browser-session';
import { AGE_DECLARATION_V1, AGE_DECLARATION_VERSION } from '../modules/auth/age-declaration';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [Owner ruling 15 Oct 2026 · Terms "You must be at least 18 years old" · Privacy §8] A sign-up
// carries a required "I am 18 or older" tick: the website now, the phone app from build 12. The
// server records it in the consent ledger (anchored to the exact words) and refuses a sign-up from
// the website, or from any client that sends the field, without it. Phone builds 9, 10 and 11 send
// no such field and must keep signing up (GUARDRAILS §7: never break a live store build).
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const ORIGIN = 'http://localhost:3001';
const WEB = { 'x-swift-client': 'web', origin: ORIGIN } as const;
const RUN = nanoid(6).toLowerCase();
const userIds: string[] = [];
const newPhone = () => testPhone();
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

beforeAll(async () => {
  process.env['CORS_ORIGIN'] = ORIGIN;
  resetBrowserOriginsForTests();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.ready();
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:age-declaration');
  delete process.env['CORS_ORIGIN'];
  resetBrowserOriginsForTests();
  await app.close();
});

async function ledger(userId: string) {
  return runWithoutTenant(() => app.prisma.consentRecord.findMany({
    where: { subjectId: userId }, orderBy: { documentType: 'asc' },
    select: { documentType: true, documentVersion: true, documentContentHash: true, action: true, surface: true, evidence: true },
  }), 'test-read:age-declaration');
}

function nativeRegister(phone: string, registrationProof: string, extra: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: '/api/v1/auth/register',
    payload: { phone, registrationProof, firstName: 'Age', lastName: `Tick${RUN}`, acceptTerms: true, ...extra },
  });
}

/** A browser sign-up up to the register call: verify-otp sets the HttpOnly continuation cookie. */
async function webContinuation(phone: string): Promise<string> {
  const code = await requestOtp(app, phone);
  const verified = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-otp', headers: WEB, payload: { phone, code } });
  expect(verified.statusCode, verified.body).toBe(200);
  const line = ([] as string[]).concat((verified.headers['set-cookie'] as string | string[]) ?? [])
    .find((l) => l.startsWith(`${SIGNUP_CONTINUATION_COOKIE}=`));
  expect(line).toBeTruthy();
  return line!.split(';')[0]!;
}

describe('the 18+ tick is recorded and required [owner ruling 15 Oct 2026]', () => {
  it('the words beside the tick are pinned: new words need a new version', () => {
    expect(AGE_DECLARATION_VERSION).toBe('v1');
    expect(sha256(AGE_DECLARATION_V1)).toBe(sha256('I am 18 or older.'));
  });

  it('a ticked phone sign-up (build 12) writes an age row anchored to the exact words, in the account transaction', async () => {
    const phone = newPhone();
    const res = await nativeRegister(phone, await registrationProofFor(app, phone), { ageConfirmed: true });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().data.user.id as string;
    userIds.push(id);
    const rows = await ledger(id);
    expect(rows.map((r) => [r.documentType, r.action])).toEqual([
      ['age_declaration', 'granted'],
      ['privacy_policy', 'granted'],
      ['terms_of_service', 'granted'],
    ]);
    const age = rows[0]!;
    expect(age.documentVersion).toBe('v1');
    expect(age.documentContentHash).toBe(sha256('I am 18 or older.'));
    expect(age.surface).toBe('mobile');
    expect(age.evidence).toMatchObject({ control: 'age_18_checkbox', path: 'auth/register' });
    const doc = await runWithoutTenant(() => app.prisma.legalDocument.findUniqueOrThrow({
      where: { documentType_version_locale: { documentType: 'age_declaration', version: 'v1', locale: 'en-GY' } },
    }), 'test-read:age-declaration');
    expect(doc.renderedText).toBe('I am 18 or older.');
    expect(doc.publishedAt).toBeInstanceOf(Date);
  });

  it('an unticked phone sign-up (ageConfirmed false) is refused, creates nothing, and leaves the code usable for a ticked retry', async () => {
    const phone = newPhone();
    const proof = await registrationProofFor(app, phone);
    const refused = await nativeRegister(phone, proof, { ageConfirmed: false });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().error.code).toBe('AGE_CONFIRMATION_REQUIRED');
    expect(refused.json().error.message).toMatch(/18 or older/);
    expect(await runWithoutTenant(() => app.prisma.user.count({ where: { phone } }), 'test-read:age-declaration')).toBe(0);

    const retried = await nativeRegister(phone, proof, { ageConfirmed: true });
    expect(retried.statusCode, retried.body).toBe(201);
    userIds.push(retried.json().data.user.id);
  });

  it('phone builds 9, 10 and 11 (no such field) still sign up, and no age row is fabricated for them', async () => {
    const phone = newPhone();
    const res = await nativeRegister(phone, await registrationProofFor(app, phone), {});
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().data.user.id as string;
    userIds.push(id);
    expect((await ledger(id)).map((r) => r.documentType)).toEqual(['privacy_policy', 'terms_of_service']);
  });

  it('the website must send the tick: without it the sign-up is refused before the continuation is spent', async () => {
    const phone = newPhone();
    const cookie = await webContinuation(phone);
    const refused = await app.inject({
      method: 'POST', url: '/api/v1/auth/register', headers: { ...WEB, cookie },
      payload: { phone, firstName: 'Web', lastName: `NoTick${RUN}`, acceptTerms: true },
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().error.code).toBe('AGE_CONFIRMATION_REQUIRED');
    expect(await runWithoutTenant(() => app.prisma.user.count({ where: { phone } }), 'test-read:age-declaration')).toBe(0);

    const ticked = await app.inject({
      method: 'POST', url: '/api/v1/auth/register', headers: { ...WEB, cookie },
      payload: { phone, firstName: 'Web', lastName: `Tick${RUN}`, acceptTerms: true, ageConfirmed: true },
    });
    expect(ticked.statusCode, ticked.body).toBe(201);
    const id = ticked.json().data.user.id as string;
    userIds.push(id);
    const age = (await ledger(id)).find((r) => r.documentType === 'age_declaration');
    expect(age).toMatchObject({ action: 'granted', documentVersion: 'v1', surface: 'web' });
  });
});
