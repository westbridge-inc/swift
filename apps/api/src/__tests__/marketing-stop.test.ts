/**
 * [R22 · research B13 · DPA s.17(2)-(5)] EVERY MARKETING TEXT AND E-MAIL SAYS IT IS FROM SWIFT
 * AND HOW TO STOP IT, AND A TEXTED STOP WORKS.
 *
 *  - A marketing text is "Swift: <offer> Reply STOP to opt out." (GSM-7, at most two parts);
 *    a marketing e-mail starts "From Swift (Westbridge Inc.)" and ends with how to stop.
 *  - Nothing is sent without a grant to the current marketing words; no marketing TEXT is sent
 *    while the inbound STOP door is not configured.
 *  - A signed STOP from the provider withdraws marketing consent in the ledger (surface 'sms');
 *    unsigned or wrongly signed posts are refused before anything is read.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { currentConsentDetailed } from '../modules/legal/consent.service';
import { setMarketingConsent } from '../modules/legal/marketing-consent';
import {
  marketingSmsText, marketingEmailContent, sendMarketingSms, sendMarketingEmail, isStopKeyword,
} from '../modules/notification/marketing-message';
import { smsInboundRoutes, twilioSignature, STOP_CONFIRMATION } from '../modules/notification/sms-inbound.routes';
import type { EmailProvider, SmsProvider } from '../providers/notifications/channels';

const TOKEN = `tok-${nanoid(12)}`;
const URL = 'https://api.example.test/api/v1/sms/inbound';
const READY = { TWILIO_AUTH_TOKEN: TOKEN, TWILIO_INBOUND_SMS_URL: URL };
const NUM = String(Date.now()).slice(-6);
let app: FastifyInstance;
const users: string[] = [];
let seq = 0;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'marketing-stop-test');

async function person(opts: { email?: boolean } = {}) {
  seq += 1;
  const phone = `+59279${NUM}${String(seq).padStart(2, '0')}`;
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone, firstName: 'Offer', lastName: `Stop${seq}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', status: 'ACTIVE',
    isPhoneVerified: true, customer: { create: {} }, ...(opts.email ? { email: `r22-${NUM}-${seq}@example.test` } : {}),
  } }));
  users.push(u.id);
  return { userId: u.id, phone };
}
const consentTo = (userId: string, granted: boolean) => runWithTenant('swift-default', () => setMarketingConsent(app.prisma, {
  userId, granted, surface: 'web', evidence: { control: 'marketing_toggle', path: 'test' },
}));
const latest = (userId: string) => system(() => currentConsentDetailed(app.prisma, 'customer', userId, 'marketing_consent'));
const rowCount = (userId: string) => system(() => app.prisma.consentRecord.count({ where: { subjectId: userId, documentType: 'marketing_consent' } }));

function fakeSms() {
  const sent: Array<{ to: string; body: string }> = [];
  const sms: SmsProvider = { async sendSms(to, body) { sent.push({ to, body }); return { ref: 'r22' }; } };
  return { sms, sent };
}
function fakeEmail() {
  const sent: Array<{ to: string; subject: string; body: string }> = [];
  const email: EmailProvider = { async sendEmail(to, subject, body) { sent.push({ to, subject, body }); return { ref: 'r22' }; } };
  return { email, sent };
}

function setEnv(values: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** A post the way the provider sends it: a form, signed over URL + sorted fields. */
function inbound(fields: Record<string, string>, opts: { sign?: 'right' | 'wrong' | 'none' } = {}) {
  const form = new URLSearchParams(fields).toString();
  const asArrays = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, [v]]));
  const signature = opts.sign === 'none' ? undefined
    : opts.sign === 'wrong' ? twilioSignature(`${TOKEN}x`, URL, asArrays)
      : twilioSignature(TOKEN, URL, asArrays);
  return app.inject({
    method: 'POST', url: '/api/v1/sms/inbound', payload: form,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(signature ? { 'x-twilio-signature': signature } : {}) },
  });
}
const stopFrom = (phone: string, body = 'STOP', sign: 'right' | 'wrong' | 'none' = 'right') =>
  inbound({ MessageSid: `SM${nanoid(32)}`, From: phone, To: '+15550000000', Body: body }, { sign });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(smsInboundRoutes, { prefix: '/api/v1/sms' });
  await app.ready();
});

afterEach(() => setEnv({ TWILIO_AUTH_TOKEN: undefined, TWILIO_INBOUND_SMS_URL: undefined }));

afterAll(async () => {
  // consent_records are append-only evidence: the rows stay, keyed to this run's people.
  await system(async () => {
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => undefined);
  });
  await app.close();
});

describe('[R22] a marketing text and e-mail name Swift and say how to stop', () => {
  it('text: "Swift: <offer> Reply STOP to opt out." in GSM-7, at most two parts', () => {
    expect(marketingSmsText('  20% off your next ride  this weekend ')).toBe('Swift: 20% off your next ride this weekend Reply STOP to opt out.');
    expect(() => marketingSmsText('Free delivery — today only')).toThrow(/GSM-7/);
    expect(() => marketingSmsText('x'.repeat(300))).toThrow(/at most 2 SMS parts/);
    expect(() => marketingSmsText('   ')).toThrow(/needs words/);
  });

  it('e-mail: the sender first, the way to stop last (STOP by text only once it works)', () => {
    const off = marketingEmailContent({ subject: 'Weekend offer', text: 'Free delivery on Saturday.' }, {});
    expect(off.subject).toBe('Swift: Weekend offer');
    expect(off.body.split('\n')[0]).toBe('From Swift (Westbridge Inc.).');
    expect(off.body).toContain('switch off Account → Marketing messages in the Swift app');
    expect(off.body).not.toContain('STOP');
    const on = marketingEmailContent({ subject: 'Weekend offer', text: 'Free delivery on Saturday.' }, READY);
    expect(on.body).toContain('or reply STOP to any text from Swift');
  });

  it('the opt-out words: STOP and the standard keywords, any case, a trailing full stop allowed', () => {
    for (const w of ['STOP', 'stop', ' Stop. ', 'UNSUBSCRIBE', 'cancel', 'end', 'quit', 'STOPALL', 'optout']) expect(isStopKeyword(w), w).toBe(true);
    for (const w of ['', 'stop it', 'please stop', 'STOPPED', 'hello']) expect(isStopKeyword(w), w).toBe(false);
  });
});

describe('[R22] a marketing send goes only to a yes, and a text only while STOP works', () => {
  it('no text while the STOP door is not configured, even to a yes', async () => {
    const { userId } = await person();
    await consentTo(userId, true);
    const { sms, sent } = fakeSms();
    expect(await sendMarketingSms({ prisma: app.prisma, sms, env: {} }, userId, 'Free delivery today')).toBe('STOP_NOT_READY');
    expect(sent).toEqual([]);
  });

  it('a yes gets the text with the sender and the STOP line; no answer or a withdrawal gets nothing', async () => {
    const yes = await person(); const never = await person();
    await consentTo(yes.userId, true);
    const { sms, sent } = fakeSms();
    expect(await sendMarketingSms({ prisma: app.prisma, sms, env: READY }, yes.userId, 'Free delivery today')).toBe('SENT');
    expect(sent).toEqual([{ to: yes.phone, body: 'Swift: Free delivery today Reply STOP to opt out.' }]);
    expect(await sendMarketingSms({ prisma: app.prisma, sms, env: READY }, never.userId, 'Free delivery today')).toBe('NO_CONSENT');
    await consentTo(yes.userId, false);
    expect(await sendMarketingSms({ prisma: app.prisma, sms, env: READY }, yes.userId, 'Free delivery today')).toBe('NO_CONSENT');
    expect(sent).toHaveLength(1);
  });

  it('a marketing e-mail goes only to a yes, with the sender line and how to stop', async () => {
    const yes = await person({ email: true }); const never = await person({ email: true });
    await consentTo(yes.userId, true);
    const { email, sent } = fakeEmail();
    expect(await sendMarketingEmail({ prisma: app.prisma, email, env: {} }, yes.userId, { subject: 'Offer', text: 'Free delivery.' })).toBe('SENT');
    expect(sent[0]!.body.startsWith('From Swift (Westbridge Inc.).')).toBe(true);
    expect(sent[0]!.body).toContain('Account → Marketing messages');
    expect(await sendMarketingEmail({ prisma: app.prisma, email, env: {} }, never.userId, { subject: 'Offer', text: 'Free delivery.' })).toBe('NO_CONSENT');
    expect(sent).toHaveLength(1);
  });
});

describe('[R22] a texted STOP withdraws marketing consent', () => {
  it('answers 503 and records nothing while not configured', async () => {
    const { userId, phone } = await person();
    await consentTo(userId, true);
    const before = await rowCount(userId);
    const res = await stopFrom(phone);
    expect(res.statusCode).toBe(503);
    expect(await rowCount(userId)).toBe(before);
  });

  it('refuses an unsigned post, a wrong signature and a non-form body before reading it', async () => {
    setEnv(READY);
    const { userId, phone } = await person();
    await consentTo(userId, true);
    const before = await rowCount(userId);
    expect((await stopFrom(phone, 'STOP', 'none')).statusCode).toBe(403);
    expect((await stopFrom(phone, 'STOP', 'wrong')).statusCode).toBe(403);
    const json = await app.inject({ method: 'POST', url: '/api/v1/sms/inbound', payload: { From: phone, Body: 'STOP' }, headers: { 'x-twilio-signature': 'x' } });
    expect(json.statusCode).toBe(403);
    expect(await rowCount(userId)).toBe(before);
    expect((await latest(userId))?.action).toBe('granted');
  });

  it('a signed STOP writes a withdrawal (surface sms), confirms by text, and marketing texts stop', async () => {
    setEnv(READY);
    const { userId, phone } = await person();
    await consentTo(userId, true);
    const res = await stopFrom(phone, ' stop. ');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.body).toContain(`<Message>${STOP_CONFIRMATION}</Message>`);
    const row = await system(() => app.prisma.consentRecord.findFirstOrThrow({
      where: { subjectId: userId, documentType: 'marketing_consent' }, orderBy: { capturedAt: 'desc' },
    }));
    expect(row.action).toBe('withdrawn');
    expect(row.surface).toBe('sms');
    expect(row.evidence).toMatchObject({ control: 'sms_stop', keyword: 'STOP' });
    const { sms, sent } = fakeSms();
    expect(await sendMarketingSms({ prisma: app.prisma, sms, env: READY }, userId, 'Free delivery today')).toBe('NO_CONSENT');
    expect(sent).toEqual([]);
    // a second STOP changes nothing: no second row
    const count = await rowCount(userId);
    expect((await stopFrom(phone, 'UNSUBSCRIBE')).statusCode).toBe(200);
    expect(await rowCount(userId)).toBe(count);
  });

  it('other words change nothing; an unknown number gets the same answer and nothing is written', async () => {
    setEnv(READY);
    const { userId, phone } = await person();
    await consentTo(userId, true);
    const before = await rowCount(userId);
    const hello = await stopFrom(phone, 'Hello, is my order coming?');
    expect(hello.statusCode).toBe(200);
    expect(hello.body).not.toContain('<Message>');
    expect(await rowCount(userId)).toBe(before);
    const unknown = await stopFrom(`+59270${NUM}99`);
    expect(unknown.statusCode).toBe(200);
    expect(unknown.body).toContain(`<Message>${STOP_CONFIRMATION}</Message>`);
  });
});
