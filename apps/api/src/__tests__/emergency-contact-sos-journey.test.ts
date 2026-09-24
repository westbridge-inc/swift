import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { devChannelLog, resetDevChannelLog } from '../providers/notifications/channels';

// ---------------------------------------------------------------------------
// [phone feedback P3] The emergency contact the owner adds on his phone must
// be the one an SOS reaches — through the real routes, end to end:
//
//   the app sends the E.164 number the rebuilt form composes (+592 + the
//   local digits) → POST /safety/emergency-contacts texts the contact a
//   6-digit code → the contact reads it back → POST .../verify marks it
//   verified → the person holds the emergency button → POST /safety/sos,
//   then the confirm that ends the reconsider window → the alert goes ACTIVE
//   and the VERIFIED contact is texted where they are; a contact whose code
//   was never relayed is not.
//
// emergency-contacts.test.ts proves each contact route; sos-emergency-fanout
// proves the fan-out from rows it seeds directly. This is the chain between
// them, which is what the phone exercises.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
const alertIds: string[] = [];
let seq = 0;
const phoneBase = 592_708_000_000 + Math.floor(Math.random() * 100_000_000);
let cseq = 0;
/** A Guyana number exactly as the app composes it: +592 and seven local digits. */
const contactPhone = () => `+592${String(6_000_000 + Math.floor(Math.random() * 900_000) + (cseq += 1)).padStart(7, '0')}`;

async function makeUser(firstName = 'Asha') {
  seq += 1;
  const user = await app.prisma.user.create({ data: { phone: `+${phoneBase + seq}`, firstName, lastName: `Owner${seq}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'ec-sos', deviceType: 'test', expiresAt: new Date(Date.now() + 86400000) } });
  return { userId: user.id, token };
}

function req(method: 'GET' | 'POST', url: string, token: string, payload?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (payload !== undefined) headers['content-type'] = 'application/json';
  return app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers });
}

/** The code out of the confirmation SMS — what the contact reads back. */
function codeFor(phone: string): string {
  const sms = [...devChannelLog].reverse().find((e) => e.channel === 'sms' && e.to === phone);
  const m = sms?.body.match(/code (\d{6})/);
  if (!m) throw new Error(`no confirmation SMS for ${phone}`);
  return m[1]!;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  process.env['OTP_PHONE_DAILY_CAP'] = '1000';
  process.env['OTP_GLOBAL_DAILY_CAP'] = '1000000';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();
});

beforeEach(() => resetDevChannelLog());

afterAll(async () => {
  await app.prisma.sosAlert.deleteMany({ where: { id: { in: alertIds } } });
  await app.prisma.emergencyContact.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('add → confirm by code → SOS reaches exactly that contact', () => {
  it('the number the form composes is accepted, confirmed with the relayed code, and texted by the SOS', async () => {
    const { token } = await makeUser();
    const anitaPhone = contactPhone();
    const unprovenPhone = contactPhone();

    // 1. "Send code" — the body the app sends, with the composed E.164 number
    const added = await req('POST', '/api/v1/safety/emergency-contacts', token, { name: 'Anita', phoneE164: anitaPhone, relationship: 'Sister' });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json().data.verifiedAt).toBeNull();
    expect(added.json().data.codeSent).toBe(true);
    expect(added.json().data.phoneE164).toBe(anitaPhone);
    const contactId: string = added.json().data.id;

    // 2. the contact reads the 6-digit code back; the number is now proven
    const code = codeFor(anitaPhone);
    expect(code).toMatch(/^\d{6}$/);
    const verified = await req('POST', `/api/v1/safety/emergency-contacts/${contactId}/verify`, token, { code });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json().data.verifiedAt).toBeTruthy();

    // a second contact whose code is never relayed — the row exists, unproven
    const unproven = await req('POST', '/api/v1/safety/emergency-contacts', token, { name: 'Unproven', phoneE164: unprovenPhone });
    expect(unproven.statusCode, unproven.body).toBe(200);
    expect(unproven.json().data.verifiedAt).toBeNull();

    const list = await req('GET', '/api/v1/safety/emergency-contacts', token);
    expect(list.json().data.map((c: { phoneE164: string; verifiedAt: string | null }) => [c.phoneE164, c.verifiedAt != null]))
      .toEqual(expect.arrayContaining([[anitaPhone, true], [unprovenPhone, false]]));

    // 3. the emergency button, then the confirm that ends the reconsider window
    resetDevChannelLog();
    const pressed = await req('POST', '/api/v1/safety/sos', token, { source: 'BUTTON', lat: 6.8013, lng: -58.1551 });
    expect(pressed.statusCode, pressed.body).toBe(200);
    const alertId: string = pressed.json().data.id;
    alertIds.push(alertId);
    if (pressed.json().data.status !== 'ACTIVE') {
      const confirmed = await req('POST', `/api/v1/safety/sos/${alertId}/confirm`, token, {});
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(confirmed.json().data.status).toBe('ACTIVE');
    }

    // 4. the proven contact is texted where the person is; the unproven one is not
    const toAnita = devChannelLog.find((e) => e.channel === 'sms' && e.to === anitaPhone);
    const toUnproven = devChannelLog.find((e) => e.channel === 'sms' && e.to === unprovenPhone);
    expect(toAnita, 'the verified contact was not texted').toBeTruthy();
    expect(toAnita!.body).toContain('emergency SOS');
    expect(toAnita!.body).toContain('Asha');
    expect(toAnita!.body).toContain('maps.google.com');
    expect(toUnproven).toBeFalsy();

    const fresh = await app.prisma.sosAlert.findUniqueOrThrow({ where: { id: alertId } });
    expect(fresh.status).toBe('ACTIVE');
    const receipts = fresh.deliveryReceipts as { contacts?: Array<{ id: string; ok: boolean }> };
    expect(receipts.contacts).toEqual([{ id: contactId, ok: true }]);
  });

  it('a wrong code leaves the contact unproven — and an SOS then reaches nobody who knows you', async () => {
    const { token } = await makeUser('Rae');
    const phone = contactPhone();
    const added = await req('POST', '/api/v1/safety/emergency-contacts', token, { name: 'Typo', phoneE164: phone });
    expect(added.statusCode).toBe(200);
    const real = codeFor(phone);
    const wrong = real === '000000' ? '111111' : '000000';
    const rejected = await req('POST', `/api/v1/safety/emergency-contacts/${added.json().data.id}/verify`, token, { code: wrong });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe('INVALID_CODE');

    resetDevChannelLog();
    const pressed = await req('POST', '/api/v1/safety/sos', token, { source: 'BUTTON', lat: 6.8, lng: -58.15 });
    expect(pressed.statusCode, pressed.body).toBe(200);
    alertIds.push(pressed.json().data.id);
    if (pressed.json().data.status !== 'ACTIVE') {
      expect((await req('POST', `/api/v1/safety/sos/${pressed.json().data.id}/confirm`, token, {})).statusCode).toBe(200);
    }
    expect(devChannelLog.find((e) => e.channel === 'sms' && e.to === phone)).toBeFalsy();
  });
});
