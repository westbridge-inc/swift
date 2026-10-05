import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { devChannelLog, resetDevChannelLog } from '../providers/notifications/channels';
import { storeOtp } from '../utils/otp';
import { SosService } from '../modules/safety/sos.service';
import { drainSosEscalations } from '../modules/safety/sos-escalation';
import { responseAuthorityFor } from '../modules/safety/deletion-hold';
import { EMERGENCY_CONTACT_IS_YOU_MESSAGE, isOwnNumber } from '../modules/safety/emergency-contact.service';

// ---------------------------------------------------------------------------
// [Q9] The owner, on his phone: "it's not stopping people from using their
// own number". An emergency contact is the person texted when you hold the
// emergency button. add() checked duplicates and the cap and never compared
// the number with the account's own phone, so a person could list
// themselves — the emergency text then goes to the phone in their own hand —
// and "confirm" that contact with the code sent to that same phone, which
// defeats the confirmation.
//
// Now the own number is refused at add, verify and resend, and skipped by
// every path that picks who an alert texts: the staging of the SOS, its
// delivery, the all-clear, and the escrow read after an erasure. Rows saved
// before the rule are kept, marked on read, and never alerted. Every check
// compares with the phone the account holds NOW, so a contact that becomes
// the owner's own number later (a changed phone) is caught the same way.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
// This file's own block: nothing else in the repo draws a 592997 number (the
// widest random span elsewhere ends at 592_995_000_000). Owners and contacts
// come from disjoint halves, so a phone change onto a contact number never
// collides with another account's phone.
const ownerBase = 592_997_000_000 + Math.floor(Math.random() * 400_000);
const contactBase = 592_997_500_000 + Math.floor(Math.random() * 400_000);
let seq = 0;
let cseq = 0;
const ownerPhone = () => `+${ownerBase + (seq += 1)}`;
const contactPhone = () => `+${contactBase + (cseq += 1)}`;

async function makeUser(opts: { firstName?: string; phone?: string; customer?: boolean } = {}) {
  const phone = opts.phone ?? ownerPhone();
  const user = await app.prisma.user.create({
    data: {
      phone, firstName: opts.firstName ?? 'Q9', lastName: `Owner${seq}`, email: `q9-${nanoid(8)}@example.com`,
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(opts.customer ? { customer: { create: {} } } : {}),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'q9', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { userId: user.id, token, phone };
}

/** A row written straight to the table, the way add() saved one before the rule. */
function seedContact(userId: string, phoneE164: string, opts: { name?: string; priority?: number; verified?: boolean } = {}) {
  return app.prisma.emergencyContact.create({
    data: { userId, name: opts.name ?? 'Contact', phoneE164, priority: opts.priority ?? 1, verifiedAt: opts.verified ? new Date() : null },
  });
}

function req(method: 'GET' | 'POST' | 'DELETE', url: string, token: string, payload?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (payload !== undefined) headers['content-type'] = 'application/json';
  return app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers });
}
const add = (token: string, phoneE164: string, name = 'Mom') => req('POST', '/api/v1/safety/emergency-contacts', token, { name, phoneE164 });
const list = async (token: string) => (await req('GET', '/api/v1/safety/emergency-contacts', token)).json().data as Array<{ id: string; phoneE164: string; verifiedAt: string | null; isOwnNumber: boolean }>;
const smsTo = (phone: string) => devChannelLog.filter((e) => e.channel === 'sms' && e.to === phone);

function codeFor(phone: string): string {
  const sms = [...devChannelLog].reverse().find((e) => e.channel === 'sms' && e.to === phone);
  const m = sms?.body.match(/code (\d{6})/);
  if (!m) throw new Error('no confirmation SMS for that number');
  return m[1]!;
}

/** The emergency button through the real routes, then the confirm that ends the reconsider window. */
async function pressSos(token: string): Promise<string> {
  const pressed = await req('POST', '/api/v1/safety/sos', token, { source: 'BUTTON', lat: 6.8, lng: -58.15 });
  expect(pressed.statusCode, pressed.body).toBe(200);
  const id: string = pressed.json().data.id;
  if (pressed.json().data.status !== 'ACTIVE') {
    const confirmed = await req('POST', `/api/v1/safety/sos/${id}/confirm`, token, {});
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json().data.status).toBe('ACTIVE');
  }
  return id;
}

const contactRowsOf = (sosAlertId: string) => app.prisma.sosEscalation.findMany({ where: { sosAlertId, channel: 'CONTACT_SMS' } });

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
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
});

beforeEach(() => resetDevChannelLog());

afterAll(async () => {
  // The evidence bundle and the ops page name the alert by a plain id, so they
  // go first; escalation rows cascade with the alert.
  const alertIds = (await app.prisma.sosAlert.findMany({ where: { actorUserId: { in: createdUserIds } }, select: { id: true } })).map((a) => a.id);
  for (const id of alertIds) {
    await app.prisma.notification.deleteMany({ where: { data: { path: ['sosAlertId'], equals: id } } }).catch(() => {});
  }
  await app.prisma.evidenceBundle.deleteMany({ where: { sosAlertId: { in: alertIds } } }).catch(() => {});
  await app.prisma.opsAlert.deleteMany({ where: { sosAlertId: { in: alertIds } } }).catch(() => {});
  await app.prisma.sosAlert.deleteMany({ where: { id: { in: alertIds } } });
  await app.prisma.safetyDeletionHold.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.emergencyContact.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('[Q9] one comparison decides whether a number is the account’s own', () => {
  it('the same number matches however it is written; a different number, no phone and the erasure tombstone never do', () => {
    expect(isOwnNumber('+5929970000001', '+5929970000001')).toBe(true);
    expect(isOwnNumber('+5929970000001', '5929970000001')).toBe(true); // an account phone stored without its +
    expect(isOwnNumber('+5929970000001', '+592 997-000 0001')).toBe(true); // the platform normaliser strips formatting
    expect(isOwnNumber('+5929970000002', '+5929970000001')).toBe(false);
    expect(isOwnNumber('+5929970000001', null)).toBe(false);
    expect(isOwnNumber('+5929970000001', undefined)).toBe(false);
    expect(isOwnNumber('', '')).toBe(false);
    // `deleted:` is what erasure writes over the phone: not a phone, never a match
    expect(isOwnNumber('+5929970000001', 'deleted:5929970000001')).toBe(false);
  });
});

describe('[Q9] the routes refuse the account’s own number', () => {
  it('adding your own number is 422 EMERGENCY_CONTACT_IS_YOU: no row, no code; someone else is saved and texted as before', async () => {
    const me = await makeUser();
    const own = await add(me.token, me.phone);
    expect(own.statusCode, own.body).toBe(422);
    expect(own.json().error.code).toBe('EMERGENCY_CONTACT_IS_YOU');
    expect(own.json().error.message).toBe('An emergency contact must be someone else. Enter their number, not yours.');
    expect(EMERGENCY_CONTACT_IS_YOU_MESSAGE).toBe(own.json().error.message);
    expect(await app.prisma.emergencyContact.count({ where: { userId: me.userId } })).toBe(0);
    expect(smsTo(me.phone)).toHaveLength(0);

    const other = contactPhone();
    const ok = await add(me.token, other);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().data.codeSent).toBe(true);
    expect(ok.json().data.phoneE164).toBe(other);
    expect(smsTo(other)).toHaveLength(1);
    expect(await app.prisma.emergencyContact.count({ where: { userId: me.userId } })).toBe(1);
  });

  it('an account phone stored without its + is still the same number', async () => {
    const digits = ownerPhone().slice(1);
    const me = await makeUser({ phone: digits });
    const res = await add(me.token, `+${digits}`);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.code).toBe('EMERGENCY_CONTACT_IS_YOU');
    expect(await app.prisma.emergencyContact.count({ where: { userId: me.userId } })).toBe(0);
    expect(smsTo(`+${digits}`)).toHaveLength(0);
  });

  it('a self-contact saved before the rule can never be confirmed or re-texted — even with the code it was sent — and the list marks it', async () => {
    const me = await makeUser();
    const self = await seedContact(me.userId, me.phone, { name: 'Me' });
    // The code the old add() texted to the owner's own phone, still live.
    await storeOtp(app.redis, `ec:${self.id}`, '246810');

    const resend = await req('POST', `/api/v1/safety/emergency-contacts/${self.id}/resend`, me.token);
    expect(resend.statusCode, resend.body).toBe(422);
    expect(resend.json().error.code).toBe('EMERGENCY_CONTACT_IS_YOU');
    expect(smsTo(me.phone)).toHaveLength(0);

    const verify = await req('POST', `/api/v1/safety/emergency-contacts/${self.id}/verify`, me.token, { code: '246810' });
    expect(verify.statusCode, verify.body).toBe(422);
    expect(verify.json().error.code).toBe('EMERGENCY_CONTACT_IS_YOU');
    expect((await app.prisma.emergencyContact.findUniqueOrThrow({ where: { id: self.id } })).verifiedAt).toBeNull();

    const rows = await list(me.token);
    expect(rows.map((c) => [c.id, c.isOwnNumber])).toEqual([[self.id, true]]); // kept, not deleted — and marked
  });
});

describe('[Q9] no alert ever texts the account’s own number', () => {
  it('a self-contact CONFIRMED before the rule: marked, refused at verify, never staged or texted by the SOS, left out of the all-clear', async () => {
    const me = await makeUser({ firstName: 'Asha' });
    const self = await seedContact(me.userId, me.phone, { name: 'Me', priority: 1, verified: true });
    const sister = await seedContact(me.userId, contactPhone(), { name: 'Sister', priority: 2, verified: true });

    expect((await list(me.token)).map((c) => [c.id, c.isOwnNumber])).toEqual([[self.id, true], [sister.id, false]]);
    const verify = await req('POST', `/api/v1/safety/emergency-contacts/${self.id}/verify`, me.token, { code: '123456' });
    expect(verify.statusCode, verify.body).toBe(422); // not the idempotent "already confirmed" answer

    const alertId = await pressSos(me.token);
    expect(smsTo(sister.phoneE164)).toHaveLength(1);
    expect(smsTo(sister.phoneE164)[0]!.body).toContain('emergency SOS');
    expect(smsTo(me.phone), 'the emergency text went to the phone in the person’s own hand').toHaveLength(0);
    expect((await contactRowsOf(alertId)).map((r) => r.targetKey)).toEqual([sister.id]);
    const receipts = (await app.prisma.sosAlert.findUniqueOrThrow({ where: { id: alertId } })).deliveryReceipts as { contacts?: unknown };
    expect(receipts.contacts).toEqual([{ id: sister.id, ok: true }]);

    resetDevChannelLog();
    await new SosService(app.prisma, app.io).resolve(alertId, 'ops-q9', 'SAFE_CONFIRMED');
    expect(smsTo(sister.phoneE164)[0]?.body).toContain('closed by our safety team');
    expect(smsTo(me.phone)).toHaveLength(0);
  });

  it('when the account phone changes to a contact’s number, that contact is the owner’s own from then on: marked, refused, not alerted', async () => {
    const me = await makeUser();
    const x = contactPhone();
    const added = await add(me.token, x, 'Brother');
    expect(added.statusCode, added.body).toBe(200);
    const contactId: string = added.json().data.id;
    expect((await req('POST', `/api/v1/safety/emergency-contacts/${contactId}/verify`, me.token, { code: codeFor(x) })).statusCode).toBe(200);
    expect((await list(me.token)).find((c) => c.id === contactId)?.isOwnNumber).toBe(false);

    // No route changes an account phone on main today; this write stands in
    // for any path that does. Nothing re-checks the contact at that moment —
    // every read and every alert compares with the phone held now.
    await app.prisma.user.update({ where: { id: me.userId }, data: { phone: x } });
    resetDevChannelLog();

    expect((await list(me.token)).find((c) => c.id === contactId)?.isOwnNumber).toBe(true);
    expect((await req('POST', `/api/v1/safety/emergency-contacts/${contactId}/resend`, me.token)).statusCode).toBe(422);
    expect((await req('POST', `/api/v1/safety/emergency-contacts/${contactId}/verify`, me.token, { code: '123456' })).statusCode).toBe(422);

    const alertId = await pressSos(me.token);
    expect(smsTo(x)).toHaveLength(0);
    expect(await contactRowsOf(alertId)).toHaveLength(0);
  });

  it('an SOS staged before the phone change and delivered after it skips that contact, and the receipt says why', async () => {
    const me = await makeUser();
    const x = contactPhone();
    const contact = await seedContact(me.userId, x, { name: 'Brother', verified: true });
    const sos = new SosService(app.prisma, app.io);
    sos.observer = { afterActive: async () => { throw new Error('process died'); } };
    await expect(sos.create({ actorUserId: me.userId, actorRole: 'CUSTOMER', immediate: true, lat: 6.8, lng: -58.15 })).rejects.toThrow('process died');
    const alert = await app.prisma.sosAlert.findFirstOrThrow({ where: { actorUserId: me.userId } });
    expect((await contactRowsOf(alert.id)).map((r) => `${r.targetKey}:${r.status}`)).toEqual([`${contact.id}:PENDING`]); // staged while x was someone else

    await app.prisma.user.update({ where: { id: me.userId }, data: { phone: x } });
    sos.observer = {};
    await drainSosEscalations(app.prisma, app.io, { alertIds: [alert.id] });

    expect(smsTo(x)).toHaveLength(0);
    const [row] = await contactRowsOf(alert.id);
    expect(row!.status).toBe('SKIPPED');
    expect(row!.receipt).toEqual({ skipped: 'contact-is-own-number' });
  });

  it('an account erased mid-emergency: the escrow is read without the self-contact, so the all-clear never texts the old own number', async () => {
    const me = await makeUser({ firstName: 'Asha', customer: true });
    const self = await seedContact(me.userId, me.phone, { name: 'Me', priority: 1, verified: true });
    const sister = await seedContact(me.userId, contactPhone(), { name: 'Sister', priority: 2, verified: true });
    const alert = await app.prisma.sosAlert.create({ data: { actorUserId: me.userId, actorRole: 'CUSTOMER', status: 'ACTIVE', triggerSource: 'BUTTON', triggeredAt: new Date() } });

    const deleted = await req('DELETE', '/api/v1/customer/account', me.token);
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json().data.status).toBe('PENDING_SAFETY_HOLD');
    expect(await app.prisma.emergencyContact.count({ where: { userId: me.userId } })).toBe(0); // live rows purged; the escrow holds both

    const authority = await responseAuthorityFor(app.prisma, me.userId);
    expect(authority.fromEscrow).toBe(true);
    expect(authority.contacts.map((c) => c.id)).toEqual([sister.id]);
    expect(authority.ownNumberContactIds).toEqual([self.id]);

    resetDevChannelLog();
    await new SosService(app.prisma, app.io).resolve(alert.id, 'ops-q9', 'FALSE_ALARM');
    expect(smsTo(sister.phoneE164)).toHaveLength(1);
    expect(smsTo(me.phone)).toHaveLength(0);
  });
});
