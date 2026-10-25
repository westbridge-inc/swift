import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { checkOtpDailyBudget, checkSafetySmsBudget, smsDestinationAllowed } from '../utils/sms-budget';
import { guyanaDayKey } from '../utils/guyana-day';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { TripShareService } from '../modules/safety/trip-share.service';
import { EmergencyContactService } from '../modules/safety/emergency-contact.service';
import { sendStepUpOtp } from '../modules/auth/step-up';
import { AuthService } from '../modules/auth/auth.service';
import { devChannelLog, resetDevChannelLog, type NotificationChannels } from '../providers/notifications/channels';

// Cost guardrails: hard daily ceilings on OTP SMS so an abuse spike can't run up
// the Twilio bill. Failure paths first — prove the caps actually block, the
// per-IP budget trips before anything shared can be drained, known phones draw
// from a budget junk cannot touch, and a refund gives a failed send back.
describe('OTP SMS daily budget (cost guardrails)', () => {
  let redis: Redis;
  const day = guyanaDayKey(new Date());
  const origPhoneCap = process.env['OTP_PHONE_DAILY_CAP'];
  const origIpCap = process.env['OTP_IP_DAILY_CAP'];
  const origGlobalCap = process.env['OTP_GLOBAL_DAILY_CAP'];
  const origKnownCap = process.env['OTP_KNOWN_DAILY_CAP'];
  // TEST-NET-3 addresses reserved for this suite — never shared with other
  // suites, so repeat runs cannot accumulate against them.
  const IP_A = '203.0.113.200';
  const IP_B = '203.0.113.201';

  beforeAll(() => {
    redis = new Redis(process.env['REDIS_URL'] || 'redis://localhost:6382');
  });

  afterAll(async () => {
    // Restore env so the rest of the suite runs with default caps.
    if (origPhoneCap === undefined) delete process.env['OTP_PHONE_DAILY_CAP']; else process.env['OTP_PHONE_DAILY_CAP'] = origPhoneCap;
    if (origIpCap === undefined) delete process.env['OTP_IP_DAILY_CAP']; else process.env['OTP_IP_DAILY_CAP'] = origIpCap;
    if (origGlobalCap === undefined) delete process.env['OTP_GLOBAL_DAILY_CAP']; else process.env['OTP_GLOBAL_DAILY_CAP'] = origGlobalCap;
    if (origKnownCap === undefined) delete process.env['OTP_KNOWN_DAILY_CAP']; else process.env['OTP_KNOWN_DAILY_CAP'] = origKnownCap;
    await redis.del(
      `sms_global_day:${day}`,
      `sms_known_day:${day}`,
      `otp_ip_day:${day}:${IP_A}`,
      `otp_ip_day:${day}:${IP_B}`,
    );
    await redis.quit();
  });

  it('blocks a phone once its daily cap is exceeded', async () => {
    process.env['OTP_PHONE_DAILY_CAP'] = '3';
    process.env['OTP_GLOBAL_DAILY_CAP'] = '1000000';
    const phone = `+592budget${Date.now()}`;
    await redis.del(`otp_phone_day:${day}:${phone}`);

    const out = [];
    for (let i = 0; i < 4; i++) out.push(await checkOtpDailyBudget(redis, phone));

    expect(out.slice(0, 3).every((r) => r.allowed)).toBe(true);
    expect(out[3]).toEqual({ allowed: false, reason: 'phone_daily' });
  });

  it('trips the global circuit breaker across different phones', async () => {
    process.env['OTP_PHONE_DAILY_CAP'] = '1000000';
    process.env['OTP_GLOBAL_DAILY_CAP'] = '2';
    await redis.del(`sms_global_day:${day}`);

    const r1 = await checkOtpDailyBudget(redis, `+592ga${Date.now()}`);
    const r2 = await checkOtpDailyBudget(redis, `+592gb${Date.now()}`);
    const r3 = await checkOtpDailyBudget(redis, `+592gc${Date.now()}`);

    expect(r1.allowed && r2.allowed).toBe(true);
    expect(r3).toEqual({ allowed: false, reason: 'global_daily' });
  });

  it('a per-IP budget trips before one actor can drain the shared global counter', async () => {
    process.env['OTP_PHONE_DAILY_CAP'] = '1000000';
    process.env['OTP_IP_DAILY_CAP'] = '2';
    process.env['OTP_GLOBAL_DAILY_CAP'] = '1000000';
    await redis.del(`otp_ip_day:${day}:${IP_A}`, `sms_global_day:${day}`);

    const out = [];
    for (let i = 0; i < 3; i++) out.push(await checkOtpDailyBudget(redis, `+592ip${Date.now()}${i}`, { ip: IP_A }));

    expect(out[0]!.allowed && out[1]!.allowed).toBe(true);
    expect(out[2]).toMatchObject({ allowed: false, reason: 'ip_daily' });
    // The shared counter absorbed only the two allowed attempts — a third
    // throwaway number from the same IP never reached it.
    expect(Number(await redis.get(`sms_global_day:${day}`))).toBe(2);
  });

  it('known phones draw from a separate budget that junk numbers cannot exhaust', async () => {
    process.env['OTP_PHONE_DAILY_CAP'] = '1000000';
    process.env['OTP_IP_DAILY_CAP'] = '1000000';
    process.env['OTP_GLOBAL_DAILY_CAP'] = '1';
    process.env['OTP_KNOWN_DAILY_CAP'] = '1000000';
    await redis.del(`sms_global_day:${day}`, `sms_known_day:${day}`);

    const junk1 = await checkOtpDailyBudget(redis, `+592j1${Date.now()}`);
    const junk2 = await checkOtpDailyBudget(redis, `+592j2${Date.now()}`);
    const known = await checkOtpDailyBudget(redis, `+592known${Date.now()}`, { knownPhone: true });

    expect(junk1.allowed).toBe(true);
    expect(junk2).toMatchObject({ allowed: false, reason: 'global_daily' });
    expect(known.allowed).toBe(true); // junk exhaustion never touches the known budget
    expect(Number(await redis.get(`sms_global_day:${day}`))).toBe(2);
    expect(Number(await redis.get(`sms_known_day:${day}`))).toBe(1);
  });

  it('known phones skip the per-IP counter: a NAT IP exhausted by junk still serves existing accounts', async () => {
    // Guyana's mobile subscribers share carrier-NAT IPs with everyone else on
    // the carrier — including an attacker. The per-IP counter exists to stop
    // throwaway numbers draining the SHARED budget; it must never lock an
    // existing account out of its own login.
    process.env['OTP_PHONE_DAILY_CAP'] = '1000000';
    process.env['OTP_IP_DAILY_CAP'] = '1';
    process.env['OTP_GLOBAL_DAILY_CAP'] = '1000000';
    process.env['OTP_KNOWN_DAILY_CAP'] = '1000000';
    await redis.del(`otp_ip_day:${day}:${IP_A}`, `sms_known_day:${day}`);

    const junk1 = await checkOtpDailyBudget(redis, `+592n1${Date.now()}`, { ip: IP_A });
    const junk2 = await checkOtpDailyBudget(redis, `+592n2${Date.now()}`, { ip: IP_A });
    const known = await checkOtpDailyBudget(redis, `+592nk${Date.now()}`, { ip: IP_A, knownPhone: true });

    expect(junk1.allowed).toBe(true);
    expect(junk2).toMatchObject({ allowed: false, reason: 'ip_daily' });
    expect(known.allowed).toBe(true);
    // The known send neither consulted nor advanced the exhausted per-IP counter.
    expect(Number(await redis.get(`otp_ip_day:${day}:${IP_A}`))).toBe(2);
    expect(Number(await redis.get(`sms_known_day:${day}`))).toBe(1);
  });

  it('refund undoes the counters a provider failure just spent', async () => {
    process.env['OTP_PHONE_DAILY_CAP'] = '1000000';
    process.env['OTP_IP_DAILY_CAP'] = '1000000';
    process.env['OTP_GLOBAL_DAILY_CAP'] = '1000000';
    const phone = `+592ref${Date.now()}`;
    await redis.del(`otp_phone_day:${day}:${phone}`, `otp_ip_day:${day}:${IP_B}`, `sms_global_day:${day}`);

    const res = await checkOtpDailyBudget(redis, phone, { ip: IP_B });
    expect(res.allowed).toBe(true);
    expect(typeof res.refund).toBe('function');

    const counts = async () => Promise.all([
      redis.get(`otp_phone_day:${day}:${phone}`),
      redis.get(`otp_ip_day:${day}:${IP_B}`),
      redis.get(`sms_global_day:${day}`),
    ]);
    expect(await counts()).toEqual(['1', '1', '1']);

    await res.refund!();
    expect(await counts()).toEqual(['0', '0', '0']);
    // A refund never digs a negative hole.
    await res.refund!();
    expect(await counts()).toEqual(['0', '0', '0']);
  });
});

// ---------------------------------------------------------------------------
// [AUD-L4-008] Safety texts have a budget of their own, and nothing budgeted is
// texted outside the launch market. A passenger's trip link and an emergency
// contact's confirmation code used to count against the SAME daily counters
// that login codes to unknown numbers use up, so a flood of fake logins could
// refuse them for the rest of the day. Graded through the real callers
// (TripShareService, EmergencyContactService, step-up, sendOtp) against
// Postgres and Redis, with a provider that records every call made to it.
// ---------------------------------------------------------------------------
describe('safety texts: a budget of their own, launch-market numbers only (AUD-L4-008)', () => {
  let app: FastifyInstance;
  const day = guyanaDayKey(new Date());
  const WIDE = '1000000';
  const CAPS = [
    'OTP_PHONE_DAILY_CAP', 'OTP_IP_DAILY_CAP', 'OTP_GLOBAL_DAILY_CAP', 'OTP_KNOWN_DAILY_CAP',
    'SMS_SAFETY_RECIPIENT_DAILY_CAP', 'SMS_SAFETY_SENDER_DAILY_CAP', 'SMS_SAFETY_DAILY_CAP',
  ] as const;
  type Cap = (typeof CAPS)[number];
  const saved: Partial<Record<Cap, string | undefined>> = {};
  /** Every cap wide open except the ones a test names. */
  const caps = (set: Partial<Record<Cap, string>> = {}) => {
    for (const c of CAPS) process.env[c] = set[c] ?? WIDE;
  };

  // +5920… is never a subscriber number, and +5920643… is reserved for this
  // block. The UK numbers are Ofcom's drama range; Trinidad's are NANP 555-01xx.
  const RUN = String(Math.floor(Math.random() * 900_000) + 100_000);
  const UK_START = Math.floor(Math.random() * 800);
  let n = 0;
  const phones: string[] = [];
  const track = (p: string) => { phones.push(p); return p; };
  const gy = () => track(`+5920643${RUN}${String((n += 1)).padStart(2, '0')}`);
  const uk = () => track(`+447700900${String(UK_START + (n += 1)).padStart(3, '0')}`);
  const tt = () => track(`+186855501${String((n += 1) % 100).padStart(2, '0')}`);
  const TEST_IP = '203.0.113.202'; // TEST-NET-3, reserved for this block
  const UNIT_SENDER = `sms-guard-unit-${RUN}`;

  // The provider: every call is an attempt, and it can be made to fail.
  const attempts: Array<{ to: string; body: string }> = [];
  let providerDown = false;
  const channels = {
    sms: {
      sendSms: async (to: string, body: string) => {
        attempts.push({ to, body });
        if (providerDown) throw new Error('provider down');
        return { ref: 'recorded' };
      },
    },
    push: { sendPush: async () => ({ sent: 0 }) },
    email: { sendEmail: async () => ({ ref: 'recorded' }) },
  } as unknown as NotificationChannels;
  const textsTo = (p: string) => attempts.filter((a) => a.to === p);

  const userIds: string[] = [];
  const orderIds: string[] = [];
  const fixture = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'sms-guard-test-fixture');
  /** The callers run the way a request runs them: bound to the account's tenant. */
  const asRequest = <T>(fn: () => Promise<T>) => runWithTenant('swift-default', fn);
  const count = async (key: string) => Number((await app.redis.get(key)) ?? 0);

  async function mkUser(phone: string, firstName = 'Guard') {
    const user = await fixture(() => app.prisma.user.create({
      data: { phone, firstName, lastName: 'SmsGuard', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true },
      select: { id: true },
    }));
    userIds.push(user.id);
    return user;
  }

  /** A passenger on a live taxi trip: the only trip a link can be shared for. */
  async function mkTrip() {
    const passenger = await mkUser(gy(), 'Asha');
    const order = await fixture(() => app.prisma.order.create({
      data: {
        customerId: passenger.id, orderType: 'TAXI', status: 'RIDE_IN_PROGRESS', orderNumber: `SG-${nanoid(8)}`,
        fulfillment: 'DELIVERY', pickupAddress: 'Stabroek Market', pickupLat: 6.8045, pickupLng: -58.1622,
        deliveryAddress: 'Camp Street', deliveryLat: 6.8145, deliveryLng: -58.1522,
        subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0,
        totalAmount: 1500, taxiFareTotal: 1500, paymentMethod: 'CASH',
      },
      select: { id: true },
    }));
    orderIds.push(order.id);
    return { passenger, order };
  }

  const contacts = () => new EmergencyContactService(app.prisma, app.redis, channels);
  const share = (passenger: { id: string }, order: { id: string }, sendToPhone: string) =>
    asRequest(() => new TripShareService(app.prisma, app.redis, channels).mint(passenger.id, order.id, { sendToPhone }));
  const addContact = (owner: { id: string }, phoneE164: string, name = 'Mom') =>
    asRequest(() => contacts().add({ userId: owner.id, name, phoneE164 }));

  beforeAll(async () => {
    for (const c of CAPS) saved[c] = process.env[c];
    app = Fastify({ logger: false });
    await app.register(prismaPlugin);
    await app.register(redisPlugin);
    await app.ready();
  });

  beforeEach(() => {
    attempts.length = 0;
    providerDown = false;
  });

  afterAll(async () => {
    for (const c of CAPS) {
      if (saved[c] === undefined) delete process.env[c]; else process.env[c] = saved[c];
    }
    const senders = [...userIds, UNIT_SENDER];
    const keys = [
      `sms_global_day:${day}`, `sms_known_day:${day}`, `sms_safety_day:${day}`, `otp_ip_day:${day}:${TEST_IP}`,
      ...phones.flatMap((p) => [`otp_phone_day:${day}:${p}`, `otp_rate:${p}`, `otp_hr:${p}`, `otp_rate:tripshare:${p}`, `otp_rate:ec:${p}`]),
      ...senders.flatMap((s) => [
        `sms_safety_sender_day:${day}:${s}`, `otp_rate:stepup:${s}`, `otp:stepup:${s}`,
        ...phones.map((p) => `sms_safety_recipient_day:${day}:${s}:${p}`),
      ]),
    ];
    for (let i = 0; i < keys.length; i += 500) await app.redis.del(...keys.slice(i, i + 500));
    await fixture(async () => {
      await app.prisma.tripShareToken.deleteMany({ where: { orderId: { in: orderIds } } });
      await app.prisma.emergencyContact.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    });
    await app.close();
  });

  it('draining the unknown-number login bucket leaves the trip link and the contact code ALLOWED', async () => {
    caps({ OTP_GLOBAL_DAILY_CAP: '1' });
    await app.redis.del(`sms_global_day:${day}`);
    // The flood: login codes to never-seen numbers use up the shared bucket.
    expect((await checkOtpDailyBudget(app.redis, gy())).allowed).toBe(true);
    expect(await checkOtpDailyBudget(app.redis, gy())).toEqual({ allowed: false, reason: 'global_daily' });

    const { passenger, order } = await mkTrip();
    const friend = gy();
    const link = await share(passenger, order, friend);
    expect(link.url).toContain('/trip/');
    expect(textsTo(friend)).toHaveLength(1);

    const owner = await mkUser(gy(), 'Owner');
    const mom = gy();
    expect((await addContact(owner, mom)).codeSent).toBe(true);
    expect(textsTo(mom)).toHaveLength(1);

    // Neither safety text touched the login bucket.
    expect(await count(`sms_global_day:${day}`)).toBe(2);
  });

  it('login codes that use up one number’s daily allowance do not silence safety texts to it, and safety texts never spend it', async () => {
    caps({ OTP_PHONE_DAILY_CAP: '2' });
    const mom = gy();
    for (let i = 0; i < 2; i++) expect((await checkOtpDailyBudget(app.redis, mom)).allowed).toBe(true);
    expect(await checkOtpDailyBudget(app.redis, mom)).toEqual({ allowed: false, reason: 'phone_daily' });

    const { passenger, order } = await mkTrip();
    await share(passenger, order, mom);
    const owner = await mkUser(gy(), 'Owner');
    expect((await addContact(owner, mom)).codeSent).toBe(true);
    expect(textsTo(mom)).toHaveLength(2);
    expect(await count(`otp_phone_day:${day}:${mom}`)).toBe(3); // the login counter never moved for them

    // The other way round: safety texts to a number leave its login allowance whole.
    const sister = gy();
    await share(passenger, order, sister);
    expect((await addContact(owner, sister, 'Sister')).codeSent).toBe(true);
    expect(await count(`otp_phone_day:${day}:${sister}`)).toBe(0);
    for (let i = 0; i < 2; i++) expect((await checkOtpDailyBudget(app.redis, sister)).allowed).toBe(true);
  });

  it('what one account has sent a number never uses up another account’s daily allowance to it', async () => {
    caps({ SMS_SAFETY_RECIPIENT_DAILY_CAP: '2', OTP_PHONE_DAILY_CAP: '2' });
    const mom = gy();
    // A stranger adds her, re-sends the code, and tries a third time.
    const stranger = await mkUser(gy(), 'Stranger');
    const added = await addContact(stranger, mom, 'Target');
    expect(added.codeSent).toBe(true);
    await app.redis.del(`otp_rate:ec:${mom}`); // a minute passes
    await asRequest(() => contacts().resend(stranger.id, added.contact.id));
    await app.redis.del(`otp_rate:ec:${mom}`);
    await expect(asRequest(() => contacts().resend(stranger.id, added.contact.id)))
      .rejects.toMatchObject({ statusCode: 429, code: 'SMS_BUDGET_EXCEEDED' });
    expect(textsTo(mom)).toHaveLength(2);

    // Her own family still reaches her: a trip link and a contact code. (A
    // minute passes first: the one-a-minute limit per number is a separate,
    // short guard. This is about the DAILY allowance.)
    await app.redis.del(`otp_rate:ec:${mom}`, `otp_rate:tripshare:${mom}`);
    const { passenger, order } = await mkTrip();
    await share(passenger, order, mom);
    const child = await mkUser(gy(), 'Child');
    expect((await addContact(child, mom)).codeSent).toBe(true);
    expect(textsTo(mom)).toHaveLength(4);
  });

  it('one account can send only so many safety texts a day, whatever the numbers', async () => {
    caps({ SMS_SAFETY_SENDER_DAILY_CAP: '2' });
    const { passenger, order } = await mkTrip();
    const [a, b, c] = [gy(), gy(), gy()];
    await share(passenger, order, a);
    await share(passenger, order, b);
    const ceilingBefore = await count(`sms_safety_day:${day}`);
    await expect(share(passenger, order, c)).rejects.toMatchObject({ statusCode: 429, code: 'SMS_BUDGET_EXCEEDED' });
    expect(textsTo(c)).toHaveLength(0);
    // Refused at its own allowance, it spent nothing shared: retrying cannot
    // wear down the platform-wide ceiling everyone else relies on.
    expect(await count(`sms_safety_day:${day}`)).toBe(ceilingBefore);

    // The same ceiling holds for contact codes: the third is not sent (the contact itself is still saved).
    const owner = await mkUser(gy(), 'Owner');
    expect((await addContact(owner, gy(), 'One')).codeSent).toBe(true);
    expect((await addContact(owner, gy(), 'Two')).codeSent).toBe(true);
    const third = gy();
    expect((await addContact(owner, third, 'Three')).codeSent).toBe(false);
    expect(textsTo(third)).toHaveLength(0);
  });

  it('all safety texts share one platform-wide daily ceiling of their own', async () => {
    caps({ SMS_SAFETY_DAILY_CAP: '2' });
    await app.redis.del(`sms_safety_day:${day}`);
    const globalBefore = await count(`sms_global_day:${day}`);
    const trips = [await mkTrip(), await mkTrip(), await mkTrip()];
    await share(trips[0]!.passenger, trips[0]!.order, gy());
    await share(trips[1]!.passenger, trips[1]!.order, gy());
    const last = gy();
    await expect(share(trips[2]!.passenger, trips[2]!.order, last))
      .rejects.toMatchObject({ statusCode: 429, code: 'SMS_BUDGET_EXCEEDED' });
    expect(textsTo(last)).toHaveLength(0);
    // It is not the login bucket: that counter did not move.
    expect(await count(`sms_global_day:${day}`)).toBe(globalBefore);
  });

  it('a text the provider fails to send gives back everything it counted', async () => {
    caps();
    providerDown = true;
    const counters = (p: string, sender: string) => Promise.all([
      count(`otp_phone_day:${day}:${p}`), count(`sms_global_day:${day}`),
      count(`sms_safety_recipient_day:${day}:${sender}:${p}`), count(`sms_safety_sender_day:${day}:${sender}`),
      count(`sms_safety_day:${day}`),
    ]);

    const { passenger, order } = await mkTrip();
    const friend = gy();
    const before = await counters(friend, passenger.id);
    const link = await share(passenger, order, friend); // the link still works; only the text failed
    expect(link.url).toContain('/trip/');
    expect(textsTo(friend)).toHaveLength(1); // the provider WAS asked
    expect(await counters(friend, passenger.id)).toEqual(before);

    const owner = await mkUser(gy(), 'Owner');
    const mom = gy();
    const before2 = await counters(mom, owner.id);
    await expect(addContact(owner, mom)).rejects.toMatchObject({ statusCode: 502, code: 'SMS_SEND_FAILED' });
    expect(textsTo(mom)).toHaveLength(1);
    expect(await counters(mom, owner.id)).toEqual(before2);
  });

  it('a number outside the launch market never reaches the SMS provider, on any budgeted path', async () => {
    caps();
    // The trip link: refused before the link exists.
    const { passenger, order } = await mkTrip();
    for (const abroad of [uk(), tt()]) {
      await expect(share(passenger, order, abroad)).rejects.toMatchObject({ statusCode: 400, code: 'COUNTRY_NOT_ACTIVE' });
    }
    expect(await fixture(() => app.prisma.tripShareToken.count({ where: { orderId: order.id } }))).toBe(0);

    // The contact code: on add (nothing is saved), and on a re-send for a row saved before this rule.
    const owner = await mkUser(gy(), 'Owner');
    await expect(addContact(owner, uk(), 'Cousin')).rejects.toMatchObject({ statusCode: 400, code: 'COUNTRY_NOT_ACTIVE' });
    expect(await fixture(() => app.prisma.emergencyContact.count({ where: { userId: owner.id } }))).toBe(0);
    const legacy = await fixture(() => app.prisma.emergencyContact.create({
      data: { userId: owner.id, name: 'Legacy', phoneE164: tt() },
      select: { id: true },
    }));
    await expect(asRequest(() => contacts().resend(owner.id, legacy.id))).rejects.toMatchObject({ statusCode: 400, code: 'COUNTRY_NOT_ACTIVE' });

    // The step-up code: an account whose own phone is outside the launch market.
    const away = await mkUser(uk(), 'Away');
    resetDevChannelLog();
    await expect(asRequest(() => sendStepUpOtp(app, away.id))).rejects.toMatchObject({ statusCode: 400, code: 'COUNTRY_NOT_ACTIVE' });
    expect(devChannelLog.filter((e) => e.channel === 'sms')).toEqual([]);

    // The login code: the guard that was already there, kept.
    await expect(new AuthService(app, channels).sendOtp(uk(), TEST_IP)).rejects.toMatchObject({ statusCode: 400, code: 'COUNTRY_NOT_ACTIVE' });

    // Not one attempt reached the provider, and nothing was counted for any of
    // these numbers: not even a one-a-minute claim.
    expect(attempts).toEqual([]);
    for (const p of phones.filter((x) => !x.startsWith('+592'))) {
      expect(await count(`otp_phone_day:${day}:${p}`)).toBe(0);
      expect(await count(`sms_safety_recipient_day:${day}:${passenger.id}:${p}`)).toBe(0);
      expect(await count(`sms_safety_recipient_day:${day}:${owner.id}:${p}`)).toBe(0);
      for (const claim of [`otp_rate:tripshare:${p}`, `otp_rate:ec:${p}`, `otp_rate:${p}`]) {
        expect(await app.redis.get(claim), claim).toBeNull();
      }
    }
    expect(await app.redis.get(`otp_rate:stepup:${away.id}`)).toBeNull();
  });

  it('both budgets refuse a number outside the launch market before counting anything', async () => {
    caps();
    const shared = () => Promise.all([count(`sms_global_day:${day}`), count(`sms_known_day:${day}`), count(`sms_safety_day:${day}`)]);
    const before = await shared();
    const home = gy();
    // A Guyana number without its + is not accepted either: one destination, one counter.
    for (const p of [uk(), tt(), track(home.slice(1))]) {
      expect(await checkOtpDailyBudget(app.redis, p)).toEqual({ allowed: false, reason: 'destination_country' });
      expect(await checkOtpDailyBudget(app.redis, p, { knownPhone: true })).toEqual({ allowed: false, reason: 'destination_country' });
      expect(await checkSafetySmsBudget(app.redis, p, { senderId: UNIT_SENDER })).toEqual({ allowed: false, reason: 'destination_country' });
      expect(await count(`otp_phone_day:${day}:${p}`)).toBe(0);
      expect(await count(`sms_safety_recipient_day:${day}:${UNIT_SENDER}:${p}`)).toBe(0);
      expect(smsDestinationAllowed(p)).toBe(false);
    }
    expect(await count(`sms_safety_sender_day:${day}:${UNIT_SENDER}`)).toBe(0);
    expect(await shared()).toEqual(before);
    expect(smsDestinationAllowed(home)).toBe(true);
  });
});
