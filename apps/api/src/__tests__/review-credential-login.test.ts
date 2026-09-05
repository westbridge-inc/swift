/**
 * [STA-1 Part 3 / DL-1 / DL-6 / DL-9] The store reviewer logs in through the
 * same door as everyone else, and the door knows the difference only by what
 * the identifier resolves to.
 *
 * send-otp for a review identifier sends NO SMS and answers exactly as
 * production does; verify-otp accepts the static code only when armed, only
 * five times, only once, only for a user IN the credential's REVIEW tenant;
 * a production identifier is untouched. Every authenticated request from a
 * REVIEW tenant then passes the review gate: a dead session is 410 on any
 * surface, a live one binds its anchor exactly once (device location first,
 * launch city otherwise). tenant.kind rides /me and the login response for
 * the in-app chip.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithoutTenant } from '../plugins/tenant-context';
import { AuthService } from '../modules/auth/auth.service';
import { hashReviewCode, REVIEW_CODE_MAX_ATTEMPTS } from '../modules/review/credentials';
import { LAUNCH_CITY, LOCATION_HEADER } from '../modules/review/gate';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const P_REVIEW = `+59278${NUM}1`;   // the fiction's customer
const P_PROD = `+59278${NUM}2`;     // a real customer, no credential
const P_TRAP = `+59278${NUM}3`;     // a real customer whose number someone wrote a credential for
const P_PLANT = `+59278${NUM}4`;    // a real customer with a credential row planted under the PRODUCTION tenant
const CODE = '246810';
const REVIEW = `review-login-${RUN}`;
const PRODUCTION = 'swift-default';

let app: FastifyInstance;
let svc: AuthService;
const sent: string[] = [];
let reviewUserId = '';
let prodUserId = '';
let trapUserId = '';
let plantUserId = '';
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'sta1-review-login-test');
const device = { deviceId: `sta1-${RUN}`, deviceType: 'test', ipAddress: '127.0.0.1', userAgent: 'vitest' };

async function bearerFor(userId: string): Promise<string> {
  const token = app.jwt.sign({ userId, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: {
    userId, token, refreshToken: nanoid(64), authMethod: 'OTP',
    deviceId: `sta1-${nanoid(6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000),
  } });
  return token;
}
const liveSession = (ttlMs = 86_400_000) => system(() => app.prisma.reviewSession.create({ data: { tenantId: REVIEW, expiresAt: new Date(Date.now() + ttlMs) } }));
const me = (token: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}`, ...headers } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['DEV_OTP_BYPASS'] = '0';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.ready();
  const channels = { sms: { sendSms: async (to: string) => { sent.push(to); return { ref: 'ok' }; } } } as unknown as NonNullable<ConstructorParameters<typeof AuthService>[1]>;
  svc = new AuthService(app, channels);

  await system(async () => {
    await app.prisma.tenant.create({ data: { id: REVIEW, name: 'Review login fiction', slug: REVIEW, kind: 'REVIEW', purgeProtected: true } });
    const mk = (phone: string, tenantId: string, isSynthetic: boolean) => app.prisma.user.create({ data: {
      phone, firstName: 'F', lastName: 'L', activeRole: 'CUSTOMER', tenantId, isSynthetic, isPhoneVerified: true,
    } });
    reviewUserId = (await mk(P_REVIEW, REVIEW, true)).id;
    prodUserId = (await mk(P_PROD, PRODUCTION, false)).id;
    trapUserId = (await mk(P_TRAP, PRODUCTION, false)).id;
    plantUserId = (await mk(P_PLANT, PRODUCTION, false)).id;
    await app.prisma.reviewCredential.create({ data: { id: `rc-${RUN}-p`, tenantId: PRODUCTION, role: 'CUSTOMER', identifier: P_PLANT, staticOtpHash: hashReviewCode(`rc-${RUN}-p`, CODE) } });
    for (const [identifier, id] of [[P_REVIEW, `rc-${RUN}-r`], [P_TRAP, `rc-${RUN}-t`]] as const) {
      await app.prisma.reviewCredential.create({ data: { id, tenantId: REVIEW, role: 'CUSTOMER', identifier, staticOtpHash: hashReviewCode(id, CODE) } });
    }
  });
  for (const p of [P_REVIEW, P_PROD, P_TRAP, P_PLANT]) await app.redis.del(`otp_rate:${p}`, `otp_hr:${p}`, `otp:${p}`, `review_otp:${p}`, `review_otp_fail:${p}`);
});

afterAll(async () => {
  await system(async () => {
    const ids = [reviewUserId, prodUserId, trapUserId, plantUserId];
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.reviewSession.deleteMany({ where: { tenantId: REVIEW } });
    await app.prisma.reviewCredential.deleteMany({ where: { OR: [{ tenantId: REVIEW }, { identifier: P_PLANT }] } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    await app.prisma.tenant.updateMany({ where: { id: REVIEW }, data: { purgeProtected: false } });
    await app.prisma.tenant.deleteMany({ where: { id: REVIEW } });
  });
  for (const p of [P_REVIEW, P_PROD, P_TRAP, P_PLANT]) await app.redis.del(`otp_rate:${p}`, `otp_hr:${p}`, `otp:${p}`, `review_otp:${p}`, `review_otp_fail:${p}`, `otp_verified:${p}`);
  await app.close();
});

describe('[DL-6] send-otp', () => {
  it('a review identifier gets the production answer and NO SMS; a production identifier gets its SMS', async () => {
    const review = await svc.sendOtp(P_REVIEW);
    expect(review).toEqual({ message: 'OTP sent successfully', expiresIn: 300 });
    expect(sent).not.toContain(P_REVIEW);
    const prod = await svc.sendOtp(P_PROD);
    expect(prod).toEqual({ message: 'OTP sent successfully', expiresIn: 300 });
    expect(sent).toContain(P_PROD);
  });
});

describe('[Part 3] verify-otp with a static code', () => {
  it('the wrong code fails with the production string; five failures lock with the production string; the right code is then refused too', async () => {
    for (let i = 0; i < REVIEW_CODE_MAX_ATTEMPTS; i++) {
      await expect(svc.verifyOtp(P_REVIEW, '000000', device)).rejects.toMatchObject({ code: 'INVALID_OTP', message: 'Invalid OTP code' });
    }
    await expect(svc.verifyOtp(P_REVIEW, CODE, device)).rejects.toMatchObject({ code: 'INVALID_OTP', message: 'Too many attempts. Request a new OTP.' });
  });

  it('the right code logs the fiction’s customer in, the response names tenant.kind REVIEW, and the code is single-use', async () => {
    await app.redis.del(`review_otp_fail:${P_REVIEW}`, `otp_rate:${P_REVIEW}`);
    await svc.sendOtp(P_REVIEW);
    const result = await svc.verifyOtp(P_REVIEW, CODE, device);
    expect(result.isNewUser).toBe(false);
    expect(result.user!.id).toBe(reviewUserId);
    expect(result.user!.tenantId).toBe(REVIEW);
    expect((result.user as { tenant?: { kind: string } }).tenant).toEqual({ kind: 'REVIEW' });
    expect(result.tokens!.accessToken).toBeTruthy();
    await expect(svc.verifyOtp(P_REVIEW, CODE, device)).rejects.toMatchObject({ code: 'INVALID_OTP', message: 'OTP expired or not found. Request a new one.' });
  });

  it('without send-otp first, the static code is refused', async () => {
    await app.redis.del(`review_otp:${P_REVIEW}`);
    await expect(svc.verifyOtp(P_REVIEW, CODE, device)).rejects.toMatchObject({ code: 'INVALID_OTP', message: 'OTP expired or not found. Request a new one.' });
  });

  it('a credential written for a PRODUCTION customer’s number opens nothing: the right code is refused and no registration window opens', async () => {
    await app.redis.del(`otp_rate:${P_TRAP}`);
    expect(await svc.sendOtp(P_TRAP)).toEqual({ message: 'OTP sent successfully', expiresIn: 300 });
    expect(sent).not.toContain(P_TRAP);
    await expect(svc.verifyOtp(P_TRAP, CODE, device)).rejects.toMatchObject({ code: 'INVALID_OTP' });
    expect(await app.redis.get(`otp_verified:${P_TRAP}`)).toBeNull();
    expect(await system(() => app.prisma.session.count({ where: { userId: trapUserId } }))).toBe(0);
  });

  it('a credential row planted under the PRODUCTION tenant is not a review credential: the SMS goes out and the static code means nothing', async () => {
    await app.redis.del(`otp_rate:${P_PLANT}`);
    await svc.sendOtp(P_PLANT);
    expect(sent).toContain(P_PLANT);
    await expect(svc.verifyOtp(P_PLANT, CODE, device)).rejects.toMatchObject({ code: 'INVALID_OTP', message: 'Invalid OTP code' });
    expect(await system(() => app.prisma.session.count({ where: { userId: plantUserId } }))).toBe(0);
  });

  it('a production identifier still takes the real OTP path: the static code means nothing to it', async () => {
    await app.redis.del(`otp_rate:${P_PROD}`);
    await svc.sendOtp(P_PROD);
    await expect(svc.verifyOtp(P_PROD, CODE, device)).rejects.toMatchObject({ code: 'INVALID_OTP', message: 'Invalid OTP code' });
  });
});

describe('[3.1 / DL-9] the review gate on authenticated requests', () => {
  it('no live review session → 410 REVIEW_SESSION_CLOSED on /me; a production customer is untouched and sees tenant.kind PRODUCTION', async () => {
    const reviewer = await bearerFor(reviewUserId);
    const dead = await me(reviewer);
    expect(dead.statusCode).toBe(410);
    expect(dead.json().error.code).toBe('REVIEW_SESSION_CLOSED');
    const real = await me(await bearerFor(prodUserId));
    expect(real.statusCode).toBe(200);
    expect(real.json().data.user.tenant).toEqual({ kind: 'PRODUCTION' });
  });

  it('a live session binds the anchor from the device header ONCE, exposes tenant.kind REVIEW, and a later header does not move it', async () => {
    const s = await liveSession();
    const reviewer = await bearerFor(reviewUserId);
    const first = await me(reviewer, { [LOCATION_HEADER]: '6.81,-58.16' });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.user.tenant).toEqual({ kind: 'REVIEW' });
    let row = await system(() => app.prisma.reviewSession.findUniqueOrThrow({ where: { id: s.id } }));
    expect([row.status, row.anchorLat, row.anchorLng, row.anchorSource]).toEqual(['ANCHORED', 6.81, -58.16, 'DEVICE_GPS']);
    expect(row.lastSeenAt).toBeInstanceOf(Date);
    const second = await me(reviewer, { [LOCATION_HEADER]: '10.5,-61.2' });
    expect(second.statusCode).toBe(200);
    row = await system(() => app.prisma.reviewSession.findUniqueOrThrow({ where: { id: s.id } }));
    expect([row.anchorLat, row.anchorLng]).toEqual([6.81, -58.16]);
    await system(() => app.prisma.reviewSession.update({ where: { id: s.id }, data: { status: 'REVOKED' } }));
  });

  it('an unparseable or absent location header falls back to the IP-geo provider — the launch city, marked IP_GEO', async () => {
    const s = await liveSession();
    const res = await me(await bearerFor(reviewUserId), { [LOCATION_HEADER]: 'somewhere' });
    expect(res.statusCode).toBe(200);
    const row = await system(() => app.prisma.reviewSession.findUniqueOrThrow({ where: { id: s.id } }));
    expect([row.anchorLat, row.anchorLng, row.anchorSource]).toEqual([LAUNCH_CITY.lat, LAUNCH_CITY.lng, 'IP_GEO']);
    await system(() => app.prisma.reviewSession.update({ where: { id: s.id }, data: { status: 'REVOKED' } }));
  });

  it('a session past its expiresAt is expired ON READ and every request is 410 from then on — never production data', async () => {
    const s = await liveSession(-1);
    const reviewer = await bearerFor(reviewUserId);
    const res = await me(reviewer);
    expect(res.statusCode).toBe(410);
    const row = await system(() => app.prisma.reviewSession.findUniqueOrThrow({ where: { id: s.id } }));
    expect(row.status).toBe('EXPIRED');
    expect(row.anchorLat).toBeNull();
    expect((await me(reviewer)).statusCode).toBe(410);
  });
});
