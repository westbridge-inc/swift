import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { devChannelLog, resetDevChannelLog } from '../providers/notifications/channels';

// ---------------------------------------------------------------------------
// Emergency contacts (safety §5). The number is proven by a one-time SMS
// handshake — the contact receives a code and relays it back. Failure paths
// first: only the owner can touch their contacts, a wrong code is rejected, the
// confirmation SMS is rate-limited (so it can't be weaponised as an SMS bomb),
// and a cap bounds the list. Re-adding a proven number keeps its verification.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
let seq = 0;
const phoneBase = 592_701_000_000 + Math.floor(Math.random() * 150_000_000);
let cseq = 0;
const contactPhone = () => `+${592_706_000_000 + Math.floor(Math.random() * 80_000_000) + (cseq += 1)}`;

async function makeUser(firstName = 'Ec') {
  seq += 1;
  const user = await app.prisma.user.create({ data: { phone: `+${phoneBase + seq}`, firstName, lastName: `U${seq}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'ec', deviceType: 'test', expiresAt: new Date(Date.now() + 86400000) } });
  return { userId: user.id, token };
}

function req(method: 'GET' | 'POST' | 'DELETE', url: string, token: string, payload?: unknown) {
  // Only send a JSON content-type when there's a body — otherwise Fastify rejects
  // an empty body as malformed JSON (400) before the handler/authz ever runs.
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (payload !== undefined) headers['content-type'] = 'application/json';
  return app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers });
}
const add = (token: string, phoneE164: string, extra: Record<string, unknown> = {}) => req('POST', '/api/v1/safety/emergency-contacts', token, { name: 'Mom', phoneE164, ...extra });

/** Pull the code out of the most recent confirmation SMS to a number. */
function codeFor(phone: string): string {
  const sms = [...devChannelLog].reverse().find((e) => e.channel === 'sms' && e.to === phone);
  const m = sms?.body.match(/code (\d{6})/);
  if (!m) throw new Error(`no confirmation SMS for ${phone}`);
  return m[1]!;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  // Keep the shared daily SMS budget out of the way — this suite exercises the
  // per-minute rate-limit, not the budget ceiling (that path is auth's).
  process.env['OTP_PHONE_DAILY_CAP'] = '1000';
  process.env['OTP_GLOBAL_DAILY_CAP'] = '1000000';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();
});

beforeEach(() => resetDevChannelLog());

afterAll(async () => {
  await app.prisma.emergencyContact.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('emergency contacts', () => {
  it('add sends a confirmation SMS and the contact starts unverified', async () => {
    const me = await makeUser('Alea');
    const phone = contactPhone();
    const res = await add(me.token, phone);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.verifiedAt).toBeNull();
    expect(res.json().data.codeSent).toBe(true);

    const sms = devChannelLog.find((e) => e.channel === 'sms' && e.to === phone);
    expect(sms).toBeTruthy();
    expect(sms!.body).toContain('emergency contact');
    expect(sms!.body).toContain('Alea'); // the owner's first name, so the contact knows who added them
    expect(sms!.body).toMatch(/code \d{6}/);
  });

  it('the relayed code verifies the number; a wrong code is rejected', async () => {
    const me = await makeUser();
    const phone = contactPhone();
    const id = (await add(me.token, phone)).json().data.id as string;
    const code = codeFor(phone);

    const wrong = code === '111111' ? '222222' : '111111';
    const bad = await req('POST', `/api/v1/safety/emergency-contacts/${id}/verify`, me.token, { code: wrong });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('INVALID_CODE');

    const ok = await req('POST', `/api/v1/safety/emergency-contacts/${id}/verify`, me.token, { code });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.verifiedAt).toBeTruthy();

    const list = (await req('GET', '/api/v1/safety/emergency-contacts', me.token)).json().data;
    expect(list.find((c: { id: string }) => c.id === id)?.verifiedAt).toBeTruthy();
  });

  it('a stranger cannot verify, resend, delete, or see my contact', async () => {
    const me = await makeUser();
    const stranger = await makeUser();
    const phone = contactPhone();
    const id = (await add(me.token, phone)).json().data.id as string;

    expect((await req('POST', `/api/v1/safety/emergency-contacts/${id}/verify`, stranger.token, { code: '123456' })).statusCode).toBe(403);
    expect((await req('POST', `/api/v1/safety/emergency-contacts/${id}/resend`, stranger.token)).statusCode).toBe(403);
    expect((await req('DELETE', `/api/v1/safety/emergency-contacts/${id}`, stranger.token)).statusCode).toBe(403);
    // and the stranger's own list never contains it
    expect((await req('GET', '/api/v1/safety/emergency-contacts', stranger.token)).json().data).toHaveLength(0);
  });

  it('an explicit resend is rate-limited per target phone (anti-bomb)', async () => {
    const me = await makeUser();
    const phone = contactPhone();
    const id = (await add(me.token, phone)).json().data.id as string; // first SMS just went out
    const res = await req('POST', `/api/v1/safety/emergency-contacts/${id}/resend`, me.token);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
  });

  it('re-adding a proven number updates details WITHOUT dropping verification or duplicating', async () => {
    const me = await makeUser();
    const phone = contactPhone();
    const id = (await add(me.token, phone, { name: 'Mom' })).json().data.id as string;
    await req('POST', `/api/v1/safety/emergency-contacts/${id}/verify`, me.token, { code: codeFor(phone) });

    const again = await add(me.token, phone, { name: 'Mother', priority: 2 });
    expect(again.statusCode).toBe(200);
    expect(again.json().data.id).toBe(id); // same row (upsert on userId+phone)
    expect(again.json().data.codeSent).toBe(false); // already verified → no new code

    const mine = (await req('GET', '/api/v1/safety/emergency-contacts', me.token)).json().data as Array<{ id: string; name: string; priority: number; verifiedAt: string | null; phoneE164: string }>;
    const row = mine.filter((c) => c.phoneE164 === phone);
    expect(row).toHaveLength(1); // not duplicated
    expect(row[0]!.name).toBe('Mother');
    expect(row[0]!.priority).toBe(2);
    expect(row[0]!.verifiedAt).toBeTruthy(); // verification preserved
  });

  it('caps the number of contacts', async () => {
    const me = await makeUser();
    // default cap is 5
    for (let i = 0; i < 5; i++) {
      expect((await add(me.token, contactPhone())).statusCode).toBe(200);
    }
    const over = await add(me.token, contactPhone());
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe('TOO_MANY_CONTACTS');
  });

  it('delete removes it', async () => {
    const me = await makeUser();
    const phone = contactPhone();
    const id = (await add(me.token, phone)).json().data.id as string;
    expect((await req('DELETE', `/api/v1/safety/emergency-contacts/${id}`, me.token)).statusCode).toBe(200);
    const mine = (await req('GET', '/api/v1/safety/emergency-contacts', me.token)).json().data as Array<{ id: string }>;
    expect(mine.find((c) => c.id === id)).toBeUndefined();
  });

  it('rejects a malformed phone number', async () => {
    const me = await makeUser();
    const res = await add(me.token, '0600-not-e164');
    expect(res.statusCode).toBe(400);
  });
});
