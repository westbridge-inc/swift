import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { generateKeyPair, randomBytes, type KeyObject } from 'node:crypto';
import { nanoid } from 'nanoid';
import { Prisma } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { runWithoutTenant, runWithTenant } from '../plugins/tenant-context';
import { rateLimitKey } from '../utils/rate-limit-key';
import { adsRoutes } from '../modules/ads/ads.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { AdCheckoutService } from '../modules/ads/checkout.service';
import { BookingService } from '../modules/ads/booking.service';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { MMG_CHECKOUT_TTL_MS, AD_HOLD_PAST_CHECKOUT_MS, MmgCheckoutService } from '../modules/billing/mmg-checkout.service';
import { MMG_CHECKOUT_RUNTIME_DECORATION, mmgCheckoutPublicRoutes, type MmgCheckoutRuntime } from '../modules/billing/mmg-checkout.routes';
import { MMG_FEE_REVERSAL_SWITCH, MmgFeeReversalService } from '../modules/billing/mmg-fee-reversal';
import { ensureProviderIdentityBackfill, resetProviderIdentityBackfillCacheForTests } from '../modules/billing/provider-identity-backfill';
import { AD_LATE_PAYMENT_LIKELY, AD_LOOKUP_NEVER_CONFIRMED, AD_NO_REPLY_UNRESOLVED, AD_POSSIBLE_MATCH, AUTO_CLOSE_LATE_RECORD_AUDIT, AUTO_CLOSE_WATCH_EVERY_MS, AUTO_CLOSE_WATCH_FIRST_MS, AUTO_CLOSE_WATCH_MS, AUTO_CLOSE_WATCH_PURPOSE, NO_REPLY_CHECK_BACKOFF_MS, NO_REPLY_CHECK_MAX_ATTEMPTS, NO_REPLY_CLOSED_REASON, NO_REPLY_FIRST_CHECK_AFTER_EXPIRY_MS } from '../modules/billing/mmg-expired-hold-check';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { MMG_AD_PRODUCT_DESCRIPTION, MMG_CHECKOUT_PRODUCT_DESCRIPTION, SANDBOX_MERCHANT_ID, SandboxMmgCheckoutProvider, type MmgCheckoutProvider } from '../providers/mmg/mmg-checkout';
import { lookupDetailFrom, type MmgCheckoutLookupClient, type MmgLookupDetail } from '../providers/mmg/mmg-provider';
import { FakeMmgHistory } from './helpers/mmg-history-fake';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { testPrismaClient } from './helpers/test-prisma-client';

// ---------------------------------------------------------------------------
// [ADS-ON · owner ruling 3 Nov] Advertisers pay on MMG's checkout page, and an invoice is paid only after MMG's own
// lookup confirms it. Against the real database (triggers, checks), the real routes and the sandbox's real request
// and reply cryptography; MMG's lookup and history are scripted, in the UAT shapes the fee's suites use. No MMG fact
// is invented here: where MMG's documents are silent, the switch stays off.
//
// Money rules pinned here (GUARDRAILS s1):
//   A1 a reply proves nothing: only MMG's lookup settles an invoice, once, and settlement commits with it
//   A2 the amount is the invoice's, down to the database
//   A3 one page per invoice; no new page while a payment on the campaign is unresolved
//   A4 a second payment on a settled invoice reaches a person, never "already paid"
//   A5 a payment that outruns its slots is recorded and owed back
//   A6 a page nobody answered is read against MMG's records before the next page opens
//   A7 the switch off takes no money; there is no typed-reference settlement anywhere
//   A8 a page MMG's records closed is watched for a week, and no second page opens until the week reads clean
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const MIN = 60_000;
const RETURN_URL = '/api/v1/billing/mmg-checkout/return';
const tenantId = 'swift-default';
// A plain client: for what must reach the database itself, past every tenant extension.
const raw = testPrismaClient();
let app: FastifyInstance;
let service: MmgCheckoutService;
let sandbox: SandboxMmgCheckoutProvider;
let generatedPair: { publicKey: KeyObject; privateKey: KeyObject };
let checkoutProvider: () => MmgCheckoutProvider;
let adSettlement: AdCheckoutService;
const saved: Record<string, string | undefined> = {};

const lookups = new Map<string, MmgLookupDetail>();
const history = new FakeMmgHistory();
const lookup: MmgCheckoutLookupClient = {
  transactionLookupDetail: async (id) => lookups.get(id) ?? { outcome: 'not_found' },
  transactionHistoryRows: (query) => history.transactionHistoryRows(query),
};
const gyStamp = (at: Date) => new Date(at.getTime() - 4 * 3_600_000).toISOString();
const uatAnswer = (txn: string, amountGyd: number): Record<string, unknown> => ({
  transactionStatus: 'successful', amount: String(amountGyd), currency: 'GYD', creationDate: gyStamp(new Date()),
  subType: 'subscriber_mpay', transactionReference: `L${txn}`,
  creditParty: [{ key: 'accountid', value: SANDBOX_MERCHANT_ID }], debitParty: [{ key: 'accountid', value: '6000002' }],
  metadata: [{ key: 'amount', value: String(amountGyd) }, { key: 'merchant', value: 'Swift' }, { key: 'description', value: '' }],
  descriptionText: null,
});
function mmgPaid(row: { merchantTransactionId: string }, txn: string, amountGyd: number) {
  lookups.set(txn, lookupDetailFrom(uatAnswer(txn, amountGyd), txn));
  history.holds(txn, amountGyd, { external_id: row.merchantTransactionId });
}

const RUN = nanoid(6).toUpperCase().replace(/[^A-Z0-9]/g, 'Q');
let seq = 0;
const tx = (name: string) => `${name}${RUN}${(seq += 1)}`;
const key = () => `tap-${nanoid(12)}`;
const phoneBase = 592_649_000_000 + Math.floor(Math.random() * 900_000);
const AMOUNT = 5000;
const FUTURE = new Date('2027-06-07T00:00:00Z');

async function makeUser(role: 'CUSTOMER' | 'ADMIN' = 'CUSTOMER') {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Ad', lastName: `Pay${seq}`, roles: [role], activeRole: role, isPhoneVerified: true, ...(role === 'ADMIN' ? { admin: { create: { permissions: ['*'] } } } : {}) },
  });
  const token = app.jwt.sign({ userId: user.id, role, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `adpay-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { userId: user.id, token };
}

/** An approved advertiser with one campaign, its slots held and its invoice unpaid. */
async function invoiced(opts: { amount?: number } = {}) {
  const owner = await makeUser();
  const advertiser = await app.prisma.advertiser.create({ data: { companyName: `Pay Co ${nanoid(5)}`, industry: 'RETAIL', contactName: 'C', contactEmail: 'c@x.gy', contactPhone: '+5926000000', createdByUserId: owner.userId, status: 'APPROVED' } });
  await app.prisma.advertiserMember.create({ data: { advertiserId: advertiser.id, userId: owner.userId, role: 'OWNER', acceptedAt: new Date() } });
  const placement = await app.prisma.adPlacement.create({ data: { key: `pay_${nanoid(6)}`, name: 'Pay', tier: 3, mediaKind: 'IMAGE', weeklyPrice: opts.amount ?? AMOUNT, slotsPerWeek: 6 } });
  const campaign = await app.prisma.adCampaign.create({ data: { advertiserId: advertiser.id, placementId: placement.id, name: 'Pay', cities: ['*'], startWeek: FUTURE, endWeek: FUTURE, totalAmount: opts.amount ?? AMOUNT } });
  const { invoice } = await new AdCheckoutService(app.prisma, app.io).checkout(campaign.id, 'MOCK');
  return { owner, advertiser, placement, campaign, invoice };
}
const start = (invoiceId: string, token: string, clientKey: string | null = key()) => app.inject({
  method: 'POST', url: `/api/v1/ads/invoices/${invoiceId}/mmg-checkout`,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-client-platform': 'web', ...(clientKey ? { 'idempotency-key': clientKey } : {}) }, payload: {},
});
async function open(f: { invoice: { id: string }; owner: { token: string } }) {
  const res = await start(f.invoice.id, f.owner.token);
  expect(res.statusCode, res.body).toBe(201);
  const data = res.json().data as { ref: string; checkoutUrl: string; amountGyd: number; status: string };
  return { ...data, row: await app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: data.ref } }) };
}
const ret = (params: unknown) => app.inject({ method: 'POST', url: RETURN_URL, headers: { 'content-type': 'application/json' }, payload: { outcome: 'success', params } });
const replyOf = (row: { merchantTransactionId: string }, code: string, txn?: string) =>
  sandbox.sandboxReplyToken({ merchantTransactionId: row.merchantTransactionId, ...(txn ? { transactionId: txn } : {}), ResultCode: code });
const intentOf = (id: string) => app.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id } });
const invoiceOf = (id: string) => app.prisma.adInvoice.findUniqueOrThrow({ where: { id } });
const campaignOf = (id: string) => app.prisma.adCampaign.findUniqueOrThrow({ where: { id } });
const told = (userId: string) => app.prisma.notification.findMany({ where: { userId } });
const paidBy = (row: { id: string }) => app.prisma.providerPayment.count({ where: { creditedPaymentId: `mco:${row.id}` } });
const campaignsOf = async (f: { advertiser: { id: string }; campaign: { id: string }; owner: { token: string } }) => {
  const res = await app.inject({ method: 'GET', url: `/api/v1/ads/advertiser/${f.advertiser.id}/campaigns`, headers: { authorization: `Bearer ${f.owner.token}` } });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().data as Array<{ id: string; invoices: Array<{ id: string; payable: boolean; paymentConfirming: boolean }> }>).find((c) => c.id === f.campaign.id)!;
};

async function buildApp(): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  registerEmptyJsonBodyParser(server);
  await server.register(rateLimit, { max: 1000, timeWindow: '1 minute', keyGenerator: rateLimitKey((token) => server.jwt.verify(token)) });
  await server.register(prismaPlugin);
  await server.register(redisPlugin);
  await server.register(authPlugin);
  await server.register(socketPlugin);
  const notifications = new NotificationService(server.prisma, server.io);
  const billing = new BillingService(server.prisma, notifications, getPaymentProvider());
  adSettlement = new AdCheckoutService(server.prisma, server.io);
  service = new MmgCheckoutService(server.prisma, billing, notifications, { checkout: () => checkoutProvider(), lookup: () => lookup, adSettlement: () => adSettlement });
  const runtime: MmgCheckoutRuntime = { service, checkout: () => checkoutProvider(), notifications };
  server.decorate(MMG_CHECKOUT_RUNTIME_DECORATION, runtime);
  await server.register(adsRoutes, { prefix: '/api/v1/ads' });
  await server.register(adminRoutes, { prefix: '/api/v1/admin' });
  await server.register(mmgCheckoutPublicRoutes, { prefix: '/api/v1/billing/mmg-checkout' });
  await server.ready();
  return server;
}

beforeAll(async () => {
  for (const name of ['ADS_ENABLED', 'ADS_MMG_CHECKOUT', 'MMG_CHECKOUT_ENABLED', 'MASTER_KEK', 'MMG_CHECKOUT_CREATION_ZONE', 'NODE_ENV']) saved[name] = process.env[name];
  process.env['NODE_ENV'] = 'development';
  delete process.env['MMG_DRIVER'];
  process.env['ADS_ENABLED'] = '1';
  process.env['ADS_MMG_CHECKOUT'] = '1';
  process.env['MMG_CHECKOUT_ENABLED'] = '1';
  process.env['MASTER_KEK'] = randomBytes(32).toString('base64');
  process.env['MMG_CHECKOUT_CREATION_ZONE'] = 'GUYANA_WALL_CLOCK';
  resetKeyProviderForTests();
  generatedPair = await new Promise<{ publicKey: KeyObject; privateKey: KeyObject }>((res, rej) => {
    generateKeyPair('rsa', { modulusLength: 4096 }, (err, publicKey, privateKey) => (err ? rej(err) : res({ publicKey, privateKey })));
  });
  sandbox = new SandboxMmgCheckoutProvider({ request: generatedPair, result: generatedPair }, 'GUYANA_WALL_CLOCK');
  checkoutProvider = () => sandbox;
  app = await buildApp();
  resetProviderIdentityBackfillCacheForTests();
  await ensureProviderIdentityBackfill(app.prisma);
}, 120_000);

beforeEach(() => {
  lookups.clear();
  history.reset();
  process.env['ADS_MMG_CHECKOUT'] = '1';
  process.env['MMG_CHECKOUT_ENABLED'] = '1';
  delete process.env['AD_PAYMENT_CONFIRM_MANUAL_ONLY'];
});

afterAll(async () => {
  // Money evidence is append-only: the fixtures stay in place, every id unique per run (as the fee and refund suites).
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  resetKeyProviderForTests();
  await raw.$disconnect();
  await app?.close();
});

describe('the switch, and who may pay', () => {
  it('A7: with the switch off, no MMG page opens for an ad', async () => {
    const f = await invoiced();
    process.env['ADS_MMG_CHECKOUT'] = '0';
    const res = await start(f.invoice.id, f.owner.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PAY_ACTION_OFF');
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { adInvoiceId: f.invoice.id } })).toBe(0);
  });

  it.each(['true', '2', ''])('only exactly 1 opens it: %j does not', async (value) => {
    const f = await invoiced();
    process.env['ADS_MMG_CHECKOUT'] = value;
    expect((await start(f.invoice.id, f.owner.token)).json().error.code).toBe('PAY_ACTION_OFF');
  });

  it('with MMG\'s own checkout off, no page opens either', async () => {
    const f = await invoiced();
    process.env['MMG_CHECKOUT_ENABLED'] = '0';
    expect((await start(f.invoice.id, f.owner.token)).json().error.code).toBe('PAY_ACTION_OFF');
  });

  it('A7: there is no typed-reference settlement: the admin route is gone', async () => {
    const f = await invoiced();
    const admin = await makeUser('ADMIN');
    const res = await app.inject({ method: 'PUT', url: `/api/v1/admin/ads/invoices/${f.invoice.id}/mark-paid`, headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json', 'x-swift-reason': TEST_ADMIN_REASON }, payload: { reference: 'a typed number' } });
    expect(res.statusCode).toBe(404);
    expect((await invoiceOf(f.invoice.id)).status).toBe('UNPAID');
  });

  it('only the owner may pay: a manager is refused, an outsider sees nothing', async () => {
    const f = await invoiced();
    const manager = await makeUser();
    await app.prisma.advertiserMember.create({ data: { advertiserId: f.advertiser.id, userId: manager.userId, role: 'MANAGER', acceptedAt: new Date() } });
    expect((await start(f.invoice.id, manager.token)).statusCode).toBe(403);
    const outsider = await makeUser();
    expect((await start(f.invoice.id, outsider.token)).statusCode).toBe(404);
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { adInvoiceId: f.invoice.id } })).toBe(0);
  });

  it('the checkout kill switch closes the page too: rollback means unavailable, on every door', async () => {
    const f = await invoiced();
    process.env['AD_CHECKOUT_KILL'] = '1';
    try {
      const res = await start(f.invoice.id, f.owner.token);
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('ADS_CHECKOUT_UNAVAILABLE');
    } finally { delete process.env['AD_CHECKOUT_KILL']; }
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { adInvoiceId: f.invoice.id } })).toBe(0);
  });

  it('a second owner tapping Pay while the first owner\'s page is open is told not to pay, never "subscription not found"', async () => {
    const f = await invoiced();
    await open(f);
    const second = await makeUser();
    await app.prisma.advertiserMember.create({ data: { advertiserId: f.advertiser.id, userId: second.userId, role: 'OWNER', acceptedAt: new Date() } });
    const res = await start(f.invoice.id, second.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PAYMENT_CONFIRMING');
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { adInvoiceId: f.invoice.id } })).toBe(1);
  });

  it('a suspended advertiser cannot open a page, even as owner', async () => {
    const f = await invoiced();
    await app.prisma.advertiser.update({ where: { id: f.advertiser.id }, data: { status: 'SUSPENDED' } });
    expect((await start(f.invoice.id, f.owner.token)).statusCode).toBe(403);
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { adInvoiceId: f.invoice.id } })).toBe(0);
  });

  // The auth gate answers a REVIEW user before any route, so this asks the route's own rule with a tenant that is
  // not a review tenant but is not production either: a crawler tenant.
  it('a tenant that is not production never opens a real page', async () => {
    const id = `ad-crawler-${nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    await raw.tenant.create({ data: { id, name: 'Ad crawler', slug: id, isActive: false, kind: 'CRAWLER' } });
    const owner = await makeUser();
    await raw.user.update({ where: { id: owner.userId }, data: { tenantId: id } });
    const advertiser = await raw.advertiser.create({ data: { tenantId: id, companyName: `Crawler Co ${nanoid(5)}`, industry: 'RETAIL', contactName: 'C', contactEmail: 'c@x.gy', contactPhone: '+5926000000', createdByUserId: owner.userId, status: 'APPROVED' } });
    await raw.advertiserMember.create({ data: { advertiserId: advertiser.id, userId: owner.userId, role: 'OWNER', acceptedAt: new Date() } });
    const placement = await raw.adPlacement.create({ data: { tenantId: id, key: `pay_${nanoid(6)}`, name: 'Pay', tier: 3, mediaKind: 'IMAGE', weeklyPrice: AMOUNT, slotsPerWeek: 6 } });
    const campaign = await raw.adCampaign.create({ data: { tenantId: id, advertiserId: advertiser.id, placementId: placement.id, name: 'Pay', cities: ['*'], startWeek: FUTURE, endWeek: FUTURE, totalAmount: AMOUNT, status: 'PENDING_PAYMENT' } });
    const invoice = await raw.adInvoice.create({ data: { tenantId: id, advertiserId: advertiser.id, campaignId: campaign.id, number: `ADS-CRAWL-${nanoid(6)}`, amount: AMOUNT } });
    // Contained: a request's tenant must not leak into the fixtures of the tests after this one.
    const res = await runWithoutTenant(() => start(invoice.id, owner.token), 'ad-mmg-crawler-request');
    expect(res.json().error.code).toBe('PAY_ACTION_OFF');
    expect(await raw.mmgCheckoutIntent.count({ where: { adInvoiceId: invoice.id } })).toBe(0);
  });

  it('a campaign list says an invoice can be paid only to the one who can pay it, only while it is on', async () => {
    const f = await invoiced();
    const read = async (token: string) => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/ads/advertiser/${f.advertiser.id}/campaigns`, headers: { authorization: `Bearer ${token}` } });
      return (res.json().data as Array<{ invoices: Array<{ payable: boolean }> }>)[0]!.invoices[0]!.payable;
    };
    expect(await read(f.owner.token)).toBe(true);
    const analyst = await makeUser();
    await app.prisma.advertiserMember.create({ data: { advertiserId: f.advertiser.id, userId: analyst.userId, role: 'ANALYST', acceptedAt: new Date() } });
    expect(await read(analyst.token)).toBe(false);
    process.env['ADS_MMG_CHECKOUT'] = '0';
    expect(await read(f.owner.token)).toBe(false);
  });
});

describe('opening the page', () => {
  it('A2: the page asks MMG for the invoice\'s own amount, as advertising, and no fee clock is touched', async () => {
    const f = await invoiced();
    const page = await open(f);
    expect(page.amountGyd).toBe(AMOUNT);
    expect(page.row.adInvoiceId).toBe(f.invoice.id);
    expect(page.row.subscriptionId).toBeNull();
    const request = sandbox.sandboxReadRequest(page.checkoutUrl);
    expect(request['amount']).toBe(String(AMOUNT));
    expect(request['productDescription']).toBe(MMG_AD_PRODUCT_DESCRIPTION);
    // The boot proof that a request fits the key is built with the fee's words: an ad's may never be longer.
    expect(MMG_AD_PRODUCT_DESCRIPTION.length).toBeLessThanOrEqual(MMG_CHECKOUT_PRODUCT_DESCRIPTION.length);
    expect(request['merchantTransactionId']).toBe(page.row.merchantTransactionId);
  });

  it('a page is refused without an Idempotency-Key', async () => {
    const f = await invoiced();
    expect((await start(f.invoice.id, f.owner.token, null)).json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('A3: the same tap, and any other tap while it is open, is the same one page', async () => {
    const f = await invoiced();
    const k = key();
    const first = await start(f.invoice.id, f.owner.token, k);
    expect(first.statusCode).toBe(201);
    const again = await start(f.invoice.id, f.owner.token, k);
    const other = await start(f.invoice.id, f.owner.token);
    expect([again.statusCode, other.statusCode]).toEqual([200, 200]);
    expect(new Set([first, again, other].map((r) => r.json().data.ref)).size).toBe(1);
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { adInvoiceId: f.invoice.id } })).toBe(1);
  });

  it('A3: taps at the same instant still open one page', async () => {
    const f = await invoiced();
    const res = await Promise.all(Array.from({ length: 5 }, () => start(f.invoice.id, f.owner.token)));
    expect(res.every((r) => r.statusCode === 200 || r.statusCode === 201), res.map((r) => r.body).join()).toBe(true);
    expect(await app.prisma.mmgCheckoutIntent.count({ where: { adInvoiceId: f.invoice.id } })).toBe(1);
  });

  it('a key used for one invoice never answers for another', async () => {
    const a = await invoiced();
    const b = await invoiced();
    await app.prisma.advertiserMember.create({ data: { advertiserId: b.advertiser.id, userId: a.owner.userId, role: 'OWNER', acceptedAt: new Date() } });
    const k = key();
    await start(a.invoice.id, a.owner.token, k);
    expect((await start(b.invoice.id, a.owner.token, k)).json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('an invoice with cents is refused, never rounded', async () => {
    const f = await invoiced({ amount: 1500.5 });
    const res = await start(f.invoice.id, f.owner.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVOICE_NOT_PAYABLE');
  });

  it('a paid invoice opens nothing', async () => {
    const f = await invoiced();
    await adSettlement.markPaid(f.invoice.id, { providerRef: tx('SETTLED') });
    expect((await start(f.invoice.id, f.owner.token)).json().error.code).toBe('INVOICE_NOT_PAYABLE');
  });

  it('an open page is never handed out for an invoice paid meanwhile: the same tap, or a new one', async () => {
    const f = await invoiced();
    const first = await open(f);
    await raw.mmgCheckoutIntent.update({ where: { id: first.ref }, data: { status: 'NOT_PAID', reason: 'MMG_SAID_NOT_PAID', nextCheckAt: null } });
    const tap = key();
    const second = await start(f.invoice.id, f.owner.token, tap);
    expect(second.statusCode).toBe(201);
    await adSettlement.markPaid(f.invoice.id, { providerRef: tx('MEANWHILE') });
    expect((await intentOf(second.json().data.ref)).status).toBe('OPEN');
    for (const again of [tap, key()]) {
      const res = await start(f.invoice.id, f.owner.token, again);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('INVOICE_NOT_PAYABLE');
      expect(res.body).not.toContain('checkoutUrl');
    }
  });

  it('an open page is never handed to an advertiser suspended since: the same tap, or a new one', async () => {
    const f = await invoiced();
    const tap = key();
    expect((await start(f.invoice.id, f.owner.token, tap)).statusCode).toBe(201);
    await raw.advertiser.update({ where: { id: f.advertiser.id }, data: { status: 'SUSPENDED' } });
    for (const again of [tap, key()]) {
      const res = await start(f.invoice.id, f.owner.token, again);
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('checkoutUrl');
    }
  });

  it('an open page is never handed out while another payment on the campaign is with a person', async () => {
    const f = await invoiced();
    const first = await open(f);
    await raw.mmgCheckoutIntent.update({ where: { id: first.ref }, data: { status: 'NOT_PAID', reason: 'MMG_SAID_NOT_PAID', nextCheckAt: null } });
    const tap = key();
    expect((await start(f.invoice.id, f.owner.token, tap)).statusCode).toBe(201);
    await raw.mmgCheckoutIntent.update({ where: { id: first.ref }, data: { status: 'HELD', reason: 'CHECKOUT_NOT_OPEN' } });
    for (const again of [tap, key()]) {
      const res = await start(f.invoice.id, f.owner.token, again);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PAYMENT_CONFIRMING');
      expect(res.body).not.toContain('checkoutUrl');
    }
    expect((await campaignsOf(f)).invoices.find((i) => i.id === f.invoice.id)).toMatchObject({ payable: false, paymentConfirming: true });
  });

  it('an open page is never handed out for a campaign an admin stopped', async () => {
    const f = await invoiced();
    const tap = key();
    expect((await start(f.invoice.id, f.owner.token, tap)).statusCode).toBe(201);
    await raw.adCampaign.update({ where: { id: f.campaign.id }, data: { status: 'REJECTED' } });
    expect((await start(f.invoice.id, f.owner.token, tap)).json().error.code).toBe('INVOICE_NOT_PAYABLE');
    expect((await campaignsOf(f)).invoices.find((i) => i.id === f.invoice.id)?.payable).toBe(false);
  });

  it('the campaign list says what a tap would get: its own open page can be handed back, a suspended advertiser pays nothing', async () => {
    const f = await invoiced();
    await open(f);
    expect((await campaignsOf(f)).invoices.find((i) => i.id === f.invoice.id)?.payable).toBe(true);
    await raw.advertiser.update({ where: { id: f.advertiser.id }, data: { status: 'SUSPENDED' } });
    expect((await campaignsOf(f)).invoices.find((i) => i.id === f.invoice.id)?.payable).toBe(false);
  });

  it('opening a page and the expiry sweep serialize on the campaign: the sweep waits, and finds the page', async () => {
    const f = await invoiced();
    await app.prisma.adBooking.updateMany({ where: { campaignId: f.campaign.id }, data: { reservedUntil: new Date(Date.now() - MIN) } });
    let sweep: Promise<unknown> = Promise.resolve();
    const { created } = await service.createAdCheckout({
      invoiceId: f.invoice.id, userId: f.owner.userId, platform: 'web', clientKey: key(),
      // Inside the page's transaction, under its lock: the sweep starts here and must wait for this commit.
      authorize: async () => {
        sweep = new BookingService(app.prisma).releaseExpired();
        await new Promise((resolve) => setTimeout(resolve, 250));
      },
    });
    await sweep;
    expect(created).toBe(true);
    expect((await campaignOf(f.campaign.id)).status).toBe('PENDING_PAYMENT');
    expect((await invoiceOf(f.invoice.id)).status).toBe('UNPAID');
    expect(await app.prisma.adBooking.count({ where: { campaignId: f.campaign.id, status: 'RESERVED' } })).toBe(1);
    await app.prisma.adBooking.updateMany({ where: { campaignId: f.campaign.id }, data: { reservedUntil: new Date(Date.now() + DAY) } });
  });

  it('the slots outlast the page, and the sweep leaves them while a page is open', async () => {
    const f = await invoiced();
    const page = await open(f);
    const holds = await app.prisma.adBooking.findMany({ where: { campaignId: f.campaign.id } });
    const reservedUntil = holds[0]!.reservedUntil!.getTime();
    expect(reservedUntil).toBe(page.row.expiresAt.getTime() + AD_HOLD_PAST_CHECKOUT_MS);
    expect(reservedUntil - Date.now()).toBeGreaterThan(MMG_CHECKOUT_TTL_MS);
    await app.prisma.adBooking.updateMany({ where: { campaignId: f.campaign.id }, data: { reservedUntil: new Date(Date.now() - MIN) } });
    await new BookingService(app.prisma).releaseExpired();
    expect((await campaignOf(f.campaign.id)).status).toBe('PENDING_PAYMENT');
    expect((await invoiceOf(f.invoice.id)).status).toBe('UNPAID');
    expect(await app.prisma.adBooking.count({ where: { campaignId: f.campaign.id, status: 'RESERVED' } })).toBe(1);
    // A sweep test elsewhere counts every expired hold in the database: this one leaves none behind.
    await app.prisma.adBooking.updateMany({ where: { campaignId: f.campaign.id }, data: { reservedUntil: new Date(Date.now() + DAY) } });
  });
});

describe('A1: only MMG\'s lookup settles', () => {
  it('a confirmed payment settles the invoice once, in one commit, and the page learns who it is talking to', async () => {
    const f = await invoiced();
    const page = await open(f);
    const txn = tx('PAID');
    mmgPaid(page.row, txn, AMOUNT);
    const res = await ret({ token: replyOf(page.row, '0', txn) });
    expect(res.json().data).toEqual({ state: 'CONFIRMED', audience: 'ADVERTISER' });
    const invoice = await invoiceOf(f.invoice.id);
    expect([invoice.status, invoice.providerRef]).toEqual(['PAID', txn]);
    expect(invoice.paidAt).toBeInstanceOf(Date);
    expect((await campaignOf(f.campaign.id)).status).toBe('PENDING_REVIEW');
    expect(await app.prisma.adBooking.count({ where: { campaignId: f.campaign.id, status: 'CONFIRMED' } })).toBe(1);
    const row = await intentOf(page.ref);
    expect([row.status, row.mmgTransactionId]).toEqual(['CONFIRMED', txn]);
    expect(await paidBy(row)).toBeGreaterThanOrEqual(1);
    const audit = await app.prisma.adsAuditLog.findFirstOrThrow({ where: { entityId: f.invoice.id, action: 'INVOICE_MARK_PAID' } });
    expect([audit.actorUserId, audit.reason]).toEqual([`mmg-checkout:${page.ref}`, txn]);
    expect((await told(f.owner.userId)).map((n) => (n.data as { kind?: string }).kind)).toContain('ad_invoice_receipt');
  });

  it('a success reply with nothing behind it settles nothing', async () => {
    const f = await invoiced();
    const page = await open(f);
    const res = await ret({ token: replyOf(page.row, '0', tx('FAKE')) });
    expect(res.json().data.state).toBe('CONFIRMING');
    expect((await invoiceOf(f.invoice.id)).status).toBe('UNPAID');
    expect((await intentOf(page.ref)).status).toBe('CONFIRMING');
  });

  it('a following request reads the server\'s state, for a member, and only by its own invoice', async () => {
    const f = await invoiced();
    const page = await open(f);
    const read = (invoiceId: string, token: string) => app.inject({ method: 'GET', url: `/api/v1/ads/invoices/${invoiceId}/mmg-checkout/${page.ref}`, headers: { authorization: `Bearer ${token}` } });
    expect((await read(f.invoice.id, f.owner.token)).json().data).toMatchObject({ ref: page.ref, status: 'OPEN', amountGyd: AMOUNT });
    const other = await invoiced();
    expect((await read(other.invoice.id, other.owner.token)).statusCode).toBe(404);
    expect((await read(f.invoice.id, other.owner.token)).statusCode).toBe(404);
  });

  it('a replayed reply settles nothing more', async () => {
    const f = await invoiced();
    const page = await open(f);
    const txn = tx('REPLAY');
    mmgPaid(page.row, txn, AMOUNT);
    const token = replyOf(page.row, '0', txn);
    await ret({ token });
    expect((await ret({ token })).json().data.state).toBe('CONFIRMED');
    expect(await app.prisma.adsAuditLog.count({ where: { entityId: f.invoice.id, action: 'INVOICE_MARK_PAID' } })).toBe(1);
  });

  it('a different amount at MMG goes to a person, and the invoice stays unpaid', async () => {
    const f = await invoiced();
    const page = await open(f);
    const txn = tx('SHORT');
    mmgPaid(page.row, txn, AMOUNT - 1);
    await ret({ token: replyOf(page.row, '0', txn) });
    expect((await intentOf(page.ref)).status).toBe('HELD');
    expect((await invoiceOf(f.invoice.id)).status).toBe('UNPAID');
    const notice = (await told(f.owner.userId)).find((n) => (n.data as { kind?: string }).kind === 'ad_mmg_checkout');
    expect((notice?.data as { status?: string }).status).toBe('HELD');
  });

  it('one MMG transaction settles one invoice: the same transaction on a second goes to a person', async () => {
    const a = await invoiced();
    const b = await invoiced();
    const first = await open(a);
    const second = await open(b);
    const txn = tx('ONCE');
    mmgPaid(first.row, txn, AMOUNT);
    await ret({ token: replyOf(first.row, '0', txn) });
    await ret({ token: replyOf(second.row, '0', txn) });
    expect((await invoiceOf(a.invoice.id)).status).toBe('PAID');
    expect((await invoiceOf(b.invoice.id)).status).toBe('UNPAID');
    expect((await intentOf(second.ref)).status).not.toBe('CONFIRMED');
  });

  it('settlement and confirmation are one commit: a failed settlement leaves nothing, and the checkout is looked at again', async () => {
    const f = await invoiced();
    const page = await open(f);
    const txn = tx('ATOMIC');
    mmgPaid(page.row, txn, AMOUNT);
    const spy = vi.spyOn(adSettlement, 'settleInTx').mockRejectedValueOnce(new Error('the database went away'));
    await ret({ token: replyOf(page.row, '0', txn) }).catch(() => undefined);
    spy.mockRestore();
    const row = await intentOf(page.ref);
    expect(row.providerPaymentId).toBeNull();
    expect(row.status).toBe('CONFIRMING');
    expect((await invoiceOf(f.invoice.id)).status).toBe('UNPAID');
    await app.prisma.mmgCheckoutIntent.update({ where: { id: row.id }, data: { nextCheckAt: new Date() } });
    await service.pollIntents();
    expect((await intentOf(page.ref)).status).toBe('CONFIRMED');
    expect((await invoiceOf(f.invoice.id)).status).toBe('PAID');
  });

  it('settlement paused: a confirmed payment waits, and settles once it is released', async () => {
    const f = await invoiced();
    const page = await open(f);
    const txn = tx('PAUSE');
    mmgPaid(page.row, txn, AMOUNT);
    process.env['AD_PAYMENT_CONFIRM_MANUAL_ONLY'] = '1';
    await ret({ token: replyOf(page.row, '0', txn) });
    expect((await intentOf(page.ref)).status).toBe('CONFIRMING');
    expect((await invoiceOf(f.invoice.id)).status).toBe('UNPAID');
    delete process.env['AD_PAYMENT_CONFIRM_MANUAL_ONLY'];
    await app.prisma.mmgCheckoutIntent.update({ where: { id: page.ref }, data: { nextCheckAt: new Date() } });
    await service.pollIntents();
    expect((await invoiceOf(f.invoice.id)).status).toBe('PAID');
  });

  it('with nothing wired to settle an invoice, a confirmed payment waits: it is not lost, and nothing is claimed', async () => {
    const f = await invoiced();
    const page = await open(f);
    const txn = tx('NOSETTLER');
    mmgPaid(page.row, txn, AMOUNT);
    const notifications = new NotificationService(app.prisma, app.io);
    const bare = new MmgCheckoutService(app.prisma, new BillingService(app.prisma, notifications, getPaymentProvider()), notifications, { checkout: () => checkoutProvider(), lookup: () => lookup });
    await bare.observeReply({ source: 'NOTIFY', params: { token: replyOf(page.row, '0', txn) } });
    const row = await intentOf(page.ref);
    expect([row.status, row.providerPaymentId]).toEqual(['CONFIRMING', null]);
    expect((await invoiceOf(f.invoice.id)).status).toBe('UNPAID');
  });

  it('MMG\'s own not-paid answer releases the page, and the advertiser may try again', async () => {
    const f = await invoiced();
    const page = await open(f);
    expect((await ret({ token: replyOf(page.row, '2') })).json().data).toEqual({ state: 'NOT_PAID', audience: 'ADVERTISER' });
    const notice = (await told(f.owner.userId)).find((n) => (n.data as { kind?: string }).kind === 'ad_mmg_checkout');
    expect((notice?.data as { status?: string }).status).toBe('NOT_PAID');
    const next = await start(f.invoice.id, f.owner.token);
    expect(next.statusCode).toBe(201);
    expect(next.json().data.ref).not.toBe(page.ref);
  });

  it('a fee\'s reply reads exactly as it always did: no audience', async () => {
    expect((await ret({ token: sandbox.sandboxReplyToken({ merchantTransactionId: '123456789012345678', ResultCode: '0' }) })).json().data).toEqual({ state: 'UNKNOWN' });
  });
});

describe('A4: a second payment on a settled invoice', () => {
  it('a page MMG\'s records closed as unpaid, shown paid after the next page settled the invoice, reaches a person', async () => {
    const f = await invoiced();
    const first = await open(f);
    // A page that ran out unanswered, that MMG's records closed as not paid, and whose week read clean: the next page may open.
    await raw.mmgCheckoutIntent.update({ where: { id: first.ref }, data: { status: 'NOT_PAID', reason: NO_REPLY_CLOSED_REASON, nextCheckAt: null } });
    await raw.mmgCheckoutObservation.create({ data: { tenantId, intentId: first.ref, source: 'HISTORY', failure: 'HISTORY_NOT_FOUND', body: { purpose: AUTO_CLOSE_WATCH_PURPOSE, decision: 'WATCH_DONE' } } });
    const second = await open(f);
    const paid = tx('SECOND');
    mmgPaid(second.row, paid, AMOUNT);
    await ret({ token: replyOf(second.row, '0', paid) });
    expect((await invoiceOf(f.invoice.id)).providerRef).toBe(paid);
    const late = tx('FIRSTPAGE');
    mmgPaid(first.row, late, AMOUNT);
    await ret({ token: replyOf(first.row, '0', late) });
    const row = await intentOf(first.ref);
    expect(row.status).toBe('HELD');
    expect(row.providerPaymentId).toBeNull();
    expect((await invoiceOf(f.invoice.id)).providerRef).toBe(paid);
  });

  it('the settlement itself refuses it: MMG confirmed a payment on an invoice another payment settled, and it is held, never "already paid"', async () => {
    const f = await invoiced();
    const page = await open(f);
    const other = tx('OTHERPAYMENT');
    await adSettlement.markPaid(f.invoice.id, { providerRef: other });
    const txn = tx('THISPAYMENT');
    mmgPaid(page.row, txn, AMOUNT);
    await ret({ token: replyOf(page.row, '0', txn) });
    const row = await intentOf(page.ref);
    expect([row.status, row.reason]).toEqual(['HELD', 'AD_INVOICE_ALREADY_PAID']);
    expect(row.providerPaymentId).toBeNull();
    expect((await invoiceOf(f.invoice.id)).providerRef).toBe(other);
    expect(await app.prisma.providerPayment.count({ where: { creditedPaymentId: `mco:${page.ref}` } })).toBe(0);
    expect((await told(f.owner.userId)).some((n) => (n.data as { status?: string }).status === 'HELD')).toBe(true);
  });
});

describe('A5: a payment that outruns its slots', () => {
  it('is recorded, confirms no inventory, and the whole amount is owed back', async () => {
    const f = await invoiced();
    const page = await open(f);
    // Nobody answered, so nothing is keeping the slots any more.
    await raw.mmgCheckoutIntent.update({ where: { id: page.ref }, data: { status: 'EXPIRED', reason: 'NO_REPLY' } });
    await app.prisma.adBooking.updateMany({ where: { campaignId: f.campaign.id }, data: { reservedUntil: new Date(Date.now() - MIN) } });
    await new BookingService(app.prisma).releaseExpired();
    expect((await campaignOf(f.campaign.id)).status).toBe('DRAFT');
    expect((await invoiceOf(f.invoice.id)).status).toBe('VOID');
    const txn = tx('LATECAPTURE');
    mmgPaid(page.row, txn, AMOUNT);
    await ret({ token: replyOf(page.row, '0', txn) });
    expect((await invoiceOf(f.invoice.id)).status).toBe('PAID');
    expect((await campaignOf(f.campaign.id)).status).toBe('DRAFT');
    expect(await app.prisma.adBooking.count({ where: { campaignId: f.campaign.id, status: 'CONFIRMED' } })).toBe(0);
    expect(await app.prisma.adRefundIntent.count({ where: { campaignId: f.campaign.id, reason: 'LATE_CAPTURE' } })).toBe(1);
    expect(await start(f.invoice.id, f.owner.token).then((r) => r.statusCode)).toBe(409);
    // The advertiser paid and has no booking: they hear both, and never that their ad is in review.
    const notice = (await told(f.owner.userId)).find((n) => (n.data as { status?: string }).status === 'LATE_CAPTURE');
    expect(notice?.title).toBe('We received your payment, but your ad was not placed');
    expect(notice?.body).toContain('owed back');
    expect(notice?.body).toContain('do not pay again');
    expect(notice?.body).not.toContain('review');
  });
});

describe('A6: a page nobody answered', () => {
  const after = (row: { expiresAt: Date }, ms: number) => new Date(row.expiresAt.getTime() + ms);

  /** A page that ran out unanswered, and one earlier confirmed payment for the read to be proven against. */
  async function abandoned() {
    const control = await invoiced();
    const paid = await open(control);
    const txn = tx('CONTROL');
    mmgPaid(paid.row, txn, AMOUNT);
    await ret({ token: replyOf(paid.row, '0', txn) });
    const f = await invoiced();
    const page = await open(f);
    await app.prisma.mmgCheckoutIntent.update({ where: { id: page.ref }, data: { expiresAt: new Date(Date.now() - NO_REPLY_FIRST_CHECK_AFTER_EXPIRY_MS - 5 * MIN) } });
    await service.pollIntents();
    expect((await intentOf(page.ref)).status).not.toBe('OPEN');
    return { ...f, page, controlTxn: txn };
  }

  it('blocks the next page, and is closed as not paid only once MMG\'s records show nothing, read and proven healthy', async () => {
    const f = await invoiced();
    const page = await open(f);
    await app.prisma.mmgCheckoutIntent.update({ where: { id: page.ref }, data: { expiresAt: new Date(Date.now() - MIN) } });
    await service.pollIntents();
    expect((await intentOf(page.ref)).status).toBe('EXPIRED');
    const blocked = await start(f.invoice.id, f.owner.token);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('PAYMENT_CONFIRMING');
    const g = await abandoned();
    const row = await intentOf(g.page.ref);
    expect([row.status, row.reason]).toEqual(['NOT_PAID', NO_REPLY_CLOSED_REASON]);
    expect((await invoiceOf(g.invoice.id)).status).toBe('UNPAID');
  });

  it('a record at MMG that could be this payment goes to a person, and nothing is credited', async () => {
    const f = await invoiced();
    const page = await open(f);
    await app.prisma.mmgCheckoutIntent.update({ where: { id: page.ref }, data: { expiresAt: new Date(Date.now() - MIN) } });
    await service.pollIntents();
    history.holds(tx('UNEXPLAINED'), AMOUNT, { external_id: 'somebody-else', modificationDate: gyStamp(new Date(page.row.createdAt.getTime() + MIN)) });
    const paid = await invoiced();
    const control = await open(paid);
    const txn = tx('CONTROL2');
    mmgPaid(control.row, txn, AMOUNT);
    await ret({ token: replyOf(control.row, '0', txn) });
    await service.pollIntents(after(await intentOf(page.ref), NO_REPLY_FIRST_CHECK_AFTER_EXPIRY_MS + MIN));
    const row = await intentOf(page.ref);
    expect([row.status, row.reason]).toEqual(['HELD', AD_NO_REPLY_UNRESOLVED]);
    expect(row.providerPaymentId).toBeNull();
    expect((await invoiceOf(f.invoice.id)).status).toBe('UNPAID');
    expect((await start(f.invoice.id, f.owner.token)).json().error.code).toBe('PAYMENT_CONFIRMING');
  });

  /** A page that ran out unanswered, with an earlier confirmed payment for the read to be proven against. */
  async function ranOut() {
    const f = await invoiced();
    const page = await open(f);
    await raw.mmgCheckoutIntent.update({ where: { id: page.ref }, data: { expiresAt: new Date(Date.now() - MIN) } });
    await service.pollIntents();
    const paid = await invoiced();
    const control = await open(paid);
    const txn = tx('CONTROL4');
    mmgPaid(control.row, txn, AMOUNT);
    await ret({ token: replyOf(control.row, '0', txn) });
    return { ...f, page, row: await intentOf(page.ref) };
  }

  it('a reply nobody could tie to a checkout, in its window, leaves it to a person: it might be this one', async () => {
    const f = await ranOut();
    await raw.mmgCheckoutObservation.create({ data: { source: 'RETURN', failure: 'NO_TOKEN', createdAt: new Date(f.page.row.createdAt.getTime() + MIN) } });
    await service.pollIntents(after(f.row, NO_REPLY_FIRST_CHECK_AFTER_EXPIRY_MS + MIN));
    expect([(await intentOf(f.page.ref)).status, (await intentOf(f.page.ref)).reason]).toEqual(['HELD', AD_NO_REPLY_UNRESOLVED]);
    await raw.mmgCheckoutObservation.deleteMany({ where: { source: 'RETURN', failure: 'NO_TOKEN', createdAt: new Date(f.page.row.createdAt.getTime() + MIN) } });
  });

  it('when the checks run out, it goes to a person: it is never forgotten, and never closed on a guess', async () => {
    const f = await ranOut();
    const first = after(f.row, NO_REPLY_FIRST_CHECK_AFTER_EXPIRY_MS);
    await raw.mmgCheckoutObservation.createMany({ data: Array.from({ length: NO_REPLY_CHECK_MAX_ATTEMPTS }, (_, i) => ({ tenantId, intentId: f.page.ref, source: 'HISTORY', createdAt: new Date(first.getTime() + i * MIN), failure: 'HISTORY_FAILED' })) });
    await service.pollIntents(new Date(first.getTime() + 2 * DAY));
    expect([(await intentOf(f.page.ref)).status, (await intentOf(f.page.ref)).reason]).toEqual(['HELD', AD_NO_REPLY_UNRESOLVED]);
  });

  it('a page that named a transaction MMG never confirmed goes to a person once its late checks end', async () => {
    const f = await invoiced();
    const page = await open(f);
    await raw.mmgCheckoutIntent.update({ where: { id: page.ref }, data: { status: 'EXPIRED', reason: 'LOOKUP_NEVER_CONFIRMED', candidates: [tx('NEVER')], nextCheckAt: null, replyAt: new Date() } });
    await service.pollIntents();
    expect([(await intentOf(page.ref)).status, (await intentOf(page.ref)).reason]).toEqual(['HELD', AD_LOOKUP_NEVER_CONFIRMED]);
  });

  it('a page that ran out with an answer on record and no transaction goes to a person: it is never left blocking with nobody told', async () => {
    const f = await invoiced();
    const page = await open(f);
    await raw.mmgCheckoutIntent.update({ where: { id: page.ref }, data: { status: 'EXPIRED', reason: 'LOOKUP_NEVER_CONFIRMED', candidates: [], nextCheckAt: null, replyAt: new Date() } });
    await service.pollIntents();
    const row = await intentOf(page.ref);
    expect([row.status, row.reason, row.candidates]).toEqual(['HELD', AD_LOOKUP_NEVER_CONFIRMED, []]);
    expect((await invoiceOf(f.invoice.id)).status).toBe('UNPAID');
    expect((await told(f.owner.userId)).some((n) => (n.data as { status?: string }).status === 'HELD')).toBe(true);
  });

  /** How long a page can wait for a read: as long as all the checks would have taken. */
  const CHECKS_SPAN = NO_REPLY_FIRST_CHECK_AFTER_EXPIRY_MS + NO_REPLY_CHECK_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0);

  it('with no time zone to read MMG by, a page waits as long as the checks would have taken, then goes to a person', async () => {
    const f = await invoiced();
    const page = await open(f);
    await raw.mmgCheckoutIntent.update({ where: { id: page.ref }, data: { expiresAt: new Date(Date.now() - MIN) } });
    await service.pollIntents();
    const row = await intentOf(page.ref);
    const keys = { request: generatedPair, result: generatedPair };
    checkoutProvider = () => new SandboxMmgCheckoutProvider(keys, null);
    try {
      await service.pollIntents(after(row, CHECKS_SPAN - MIN));
      expect([(await intentOf(page.ref)).status, (await intentOf(page.ref)).reason]).toEqual(['EXPIRED', 'NO_REPLY']);
      await service.pollIntents(after(row, CHECKS_SPAN + MIN));
    } finally {
      checkoutProvider = () => sandbox;
    }
    expect([(await intentOf(page.ref)).status, (await intentOf(page.ref)).reason]).toEqual(['HELD', AD_NO_REPLY_UNRESOLVED]);
    expect(history.queries).toEqual([]);
    expect((await told(f.owner.userId)).some((n) => (n.data as { status?: string }).status === 'HELD')).toBe(true);
    expect((await invoiceOf(f.invoice.id)).status).toBe('UNPAID');
  });

  it('with no confirmed payment to prove a read with, a page waits as long as the checks would have taken, then goes to a person', async () => {
    const operator = `adread-${nanoid(8)}`;
    await raw.tenant.create({ data: { id: operator, name: 'New operator', slug: operator, isActive: true } });
    const owner = await makeUser();
    const advertiser = await raw.advertiser.create({ data: { tenantId: operator, companyName: `New Co ${nanoid(5)}`, industry: 'RETAIL', contactName: 'C', contactEmail: 'c@x.gy', contactPhone: '+5926000000', createdByUserId: owner.userId, status: 'APPROVED' } });
    const placement = await raw.adPlacement.create({ data: { tenantId: operator, key: `new_${nanoid(6)}`, name: 'New', tier: 3, mediaKind: 'IMAGE', weeklyPrice: AMOUNT, slotsPerWeek: 6 } });
    const campaign = await raw.adCampaign.create({ data: { tenantId: operator, advertiserId: advertiser.id, placementId: placement.id, name: 'New', cities: ['*'], startWeek: FUTURE, endWeek: FUTURE, totalAmount: AMOUNT } });
    const invoice = await raw.adInvoice.create({ data: { tenantId: operator, advertiserId: advertiser.id, campaignId: campaign.id, number: `ADS-TEST-${nanoid(8)}`, amount: AMOUNT, provider: 'MMG' } });
    const page = await raw.mmgCheckoutIntent.create({ data: {
      tenantId: operator, adInvoiceId: invoice.id, merchantTransactionId: `8${String(Date.now())}${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`, amount: AMOUNT, currencyCode: 'GYD',
      createdByUserId: owner.userId, platform: 'web', expiresAt: new Date(Date.now() + MIN), checkoutUrlSealed: Buffer.alloc(40, 1), checkoutUrlDek: Buffer.alloc(40, 2),
    } });
    await raw.mmgCheckoutIntent.update({ where: { id: page.id }, data: { status: 'EXPIRED', reason: 'NO_REPLY', expiresAt: new Date(Date.now() - MIN) } });
    const rowOf = () => raw.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: page.id } });
    const row = await rowOf();
    await service.pollIntents(after(row, CHECKS_SPAN - MIN));
    expect((await rowOf()).status).toBe('EXPIRED');
    await service.pollIntents(after(row, CHECKS_SPAN + MIN));
    expect([(await rowOf()).status, (await rowOf()).reason]).toEqual(['HELD', AD_NO_REPLY_UNRESOLVED]);
  });

  it('a failed read closes nothing: it stays unresolved and is asked again', async () => {
    const f = await invoiced();
    const page = await open(f);
    await app.prisma.mmgCheckoutIntent.update({ where: { id: page.ref }, data: { expiresAt: new Date(Date.now() - MIN) } });
    await service.pollIntents();
    const paid = await invoiced();
    const control = await open(paid);
    const txn = tx('CONTROL3');
    mmgPaid(control.row, txn, AMOUNT);
    await ret({ token: replyOf(control.row, '0', txn) });
    history.answer = async () => ({ outcome: 'error', reason: 'MMG is down' });
    await service.pollIntents(after(await intentOf(page.ref), NO_REPLY_FIRST_CHECK_AFTER_EXPIRY_MS + MIN));
    const row = await intentOf(page.ref);
    expect([row.status, row.reason]).toEqual(['EXPIRED', 'NO_REPLY']);
  });
});

describe('A8: the week after an automatic close', () => {
  const HOUR = 3_600_000;
  const later = (from: Date, ms: number) => new Date(from.getTime() + ms);
  const decisionsOf = async (ref: string) => (await raw.mmgCheckoutObservation.findMany({
    where: { intentId: ref, source: 'HISTORY', body: { path: ['purpose'], equals: AUTO_CLOSE_WATCH_PURPOSE } }, orderBy: { id: 'asc' },
  })).map((o) => (o.body as { decision: string }).decision);

  // The fixtures stay in place, and a watch reads a bounded number of checkouts a pass, oldest first: what other
  // tests left behind is taken out of the poll, so each test reads its own page.
  beforeEach(async () => {
    await raw.mmgCheckoutIntent.updateMany({ where: { adInvoiceId: { not: null }, status: { in: ['OPEN', 'CONFIRMING', 'EXPIRED'] } }, data: { status: 'HELD', reason: 'ANOTHER_TEST', nextCheckAt: null } });
    const earlier = await raw.mmgCheckoutIntent.findMany({ where: { adInvoiceId: { not: null }, status: 'NOT_PAID', reason: NO_REPLY_CLOSED_REASON }, select: { id: true } });
    await raw.mmgCheckoutObservation.createMany({ data: earlier.map((c) => ({ tenantId, intentId: c.id, source: 'HISTORY', failure: 'HISTORY_NOT_FOUND', body: { purpose: AUTO_CLOSE_WATCH_PURPOSE, decision: 'WATCH_DONE' } })) });
  });

  /** A page that ran out unanswered, closed as not paid on MMG's records, read and proven healthy. */
  async function closed(at?: Date) {
    const control = await invoiced();
    const paid = await open(control);
    const txn = tx('CONTROL');
    mmgPaid(paid.row, txn, AMOUNT);
    await ret({ token: replyOf(paid.row, '0', txn) });
    const f = await invoiced();
    const page = await open(f);
    await raw.mmgCheckoutIntent.update({ where: { id: page.ref }, data: { expiresAt: new Date(Date.now() - NO_REPLY_FIRST_CHECK_AFTER_EXPIRY_MS - 5 * MIN) } });
    // After the control's payment: the read that proves it reaches back from this moment.
    const closedAt = at ?? new Date();
    await service.pollIntents(closedAt);
    const row = await intentOf(page.ref);
    expect([row.status, row.reason]).toEqual(['NOT_PAID', NO_REPLY_CLOSED_REASON]);
    return { ...f, page, closedAt };
  }
  const refused = async (f: { invoice: { id: string }; owner: { token: string } }) => {
    const res = await start(f.invoice.id, f.owner.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PAYMENT_CONFIRMING');
  };

  it('a paid record MMG shows only now goes to a person: nothing settles, the advertiser is told, no second page opens', async () => {
    const f = await closed();
    const late = tx('ONLYINHISTORY');
    history.holds(late, AMOUNT, { external_id: f.page.row.merchantTransactionId, modificationDate: gyStamp(later(f.closedAt, 4 * HOUR)) });
    await service.pollIntents(later(f.closedAt, DAY));
    const row = await intentOf(f.page.ref);
    expect([row.status, row.reason]).toEqual(['HELD', AD_LATE_PAYMENT_LIKELY]);
    expect(row.providerPaymentId).toBeNull();
    expect((await invoiceOf(f.invoice.id)).status).toBe('UNPAID');
    expect(await paidBy({ id: f.page.ref })).toBe(0);
    expect((await told(f.owner.userId)).some((n) => (n.data as { status?: string }).status === 'HELD')).toBe(true);
    expect(await app.prisma.auditLog.count({ where: { action: AUTO_CLOSE_LATE_RECORD_AUDIT, entityId: f.page.ref } })).toBe(1);
    await refused(f);
  });

  it('a record dated before the close, that MMG shows only after it, is found too', async () => {
    const f = await closed(later(new Date(), 2 * DAY));
    history.holds(tx('BACKDATED'), AMOUNT, { external_id: f.page.row.merchantTransactionId, modificationDate: gyStamp(new Date(f.page.row.createdAt.getTime() + MIN)) });
    await service.pollIntents(later(f.closedAt, DAY));
    expect((await intentOf(f.page.ref)).reason).toBe(AD_LATE_PAYMENT_LIKELY);
  });

  it('a record naming the page that is not plainly its payment goes to a person as a possible match', async () => {
    const f = await closed();
    history.holds(tx('OTHERAMOUNT'), AMOUNT + 1, { external_id: f.page.row.merchantTransactionId, modificationDate: gyStamp(later(f.closedAt, HOUR)) });
    await service.pollIntents(later(f.closedAt, DAY));
    const row = await intentOf(f.page.ref);
    expect([row.status, row.reason]).toEqual(['HELD', AD_POSSIBLE_MATCH]);
    expect(row.providerPaymentId).toBeNull();
  });

  it('a second page waits out the week, opens once the week has read clean, and the page is not read again', async () => {
    const f = await closed();
    await refused(f);
    expect((await campaignsOf(f)).invoices[0]).toMatchObject({ payable: false, paymentConfirming: true });
    for (let t = AUTO_CLOSE_WATCH_FIRST_MS; t < AUTO_CLOSE_WATCH_MS; t += AUTO_CLOSE_WATCH_EVERY_MS) {
      await service.pollIntents(later(f.closedAt, t));
      expect((await decisionsOf(f.page.ref)).at(-1)).toBe('WATCH_CLEAR');
    }
    await refused(f);
    await service.pollIntents(later(f.closedAt, AUTO_CLOSE_WATCH_MS + AUTO_CLOSE_WATCH_EVERY_MS));
    expect((await decisionsOf(f.page.ref)).at(-1)).toBe('WATCH_DONE');
    const reads = history.queries.length;
    await service.pollIntents(later(f.closedAt, AUTO_CLOSE_WATCH_MS + 2 * DAY));
    expect(history.queries.length).toBe(reads);
    expect((await intentOf(f.page.ref)).status).toBe('NOT_PAID');
    expect((await campaignsOf(f)).invoices[0]).toMatchObject({ payable: true, paymentConfirming: false });
    expect((await open(f)).ref).not.toBe(f.page.ref);
  });

  it('the week is the close\'s, however long after the page that was: its last hour is read, and a record after it is not this watch\'s', async () => {
    const f = await closed(later(new Date(), 2 * DAY));
    history.holds(tx('LASTHOUR'), AMOUNT, { external_id: f.page.row.merchantTransactionId, modificationDate: gyStamp(later(f.closedAt, AUTO_CLOSE_WATCH_MS - 10 * MIN)) });
    const g = await closed(f.closedAt);
    history.holds(tx('AFTERTHEWEEK'), AMOUNT, { external_id: g.page.row.merchantTransactionId, modificationDate: gyStamp(later(g.closedAt, AUTO_CLOSE_WATCH_MS + HOUR)) });
    for (let i = 0; i < 40; i += 1) await service.pollIntents(later(f.closedAt, AUTO_CLOSE_WATCH_MS + DAY));
    expect((await intentOf(f.page.ref)).reason).toBe(AD_LATE_PAYMENT_LIKELY);
    expect((await intentOf(g.page.ref)).status).toBe('NOT_PAID');
    expect((await decisionsOf(g.page.ref)).at(-1)).toBe('WATCH_DONE');
  });

  it('a worker that stopped catches up: a record inside the week is found however late it looks', async () => {
    const f = await closed();
    history.holds(tx('WORKERDOWN'), AMOUNT, { external_id: f.page.row.merchantTransactionId, modificationDate: gyStamp(later(f.closedAt, 5 * DAY)) });
    const long = later(f.closedAt, 40 * DAY);
    for (let i = 0; i < 20 && (await intentOf(f.page.ref)).status !== 'HELD'; i += 1) await service.pollIntents(long);
    expect((await intentOf(f.page.ref)).reason).toBe(AD_LATE_PAYMENT_LIKELY);
  });

  it('a failed read clears nothing, and a week it never finished stays blocked, in front of a person', async () => {
    const f = await closed();
    history.answer = async () => ({ outcome: 'error', reason: 'MMG is down' });
    await service.pollIntents(later(f.closedAt, DAY));
    expect(await decisionsOf(f.page.ref)).toEqual(['WATCH_READ_FAILED']);
    await refused(f);
    await service.pollIntents(later(f.closedAt, AUTO_CLOSE_WATCH_MS + DAY + HOUR));
    expect((await decisionsOf(f.page.ref)).at(-1)).toBe('WATCH_ENDED_INCOMPLETE');
    await refused(f);
    const reads = history.queries.length;
    await service.pollIntents(later(f.closedAt, AUTO_CLOSE_WATCH_MS + 3 * DAY));
    expect(history.queries.length).toBe(reads);
  });

  it('a close with no record of the read behind it is watched all the same', async () => {
    const f = await invoiced();
    const page = await open(f);
    await raw.mmgCheckoutIntent.update({ where: { id: page.ref }, data: { status: 'NOT_PAID', reason: NO_REPLY_CLOSED_REASON, nextCheckAt: null } });
    history.holds(tx('NORECORD'), AMOUNT, { external_id: page.row.merchantTransactionId, modificationDate: gyStamp(new Date(Date.now() + 3 * HOUR)) });
    await service.pollIntents(new Date(Date.now() + DAY));
    expect((await intentOf(page.ref)).reason).toBe(AD_LATE_PAYMENT_LIKELY);
  });
});

describe('no reversal, and the database\'s own floor', () => {
  const sealedFields = { checkoutUrlSealed: Buffer.alloc(40, 1), checkoutUrlDek: Buffer.alloc(40, 2) };
  const birth = (invoice: { id: string }, userId: string, data: Record<string, unknown> = {}) => raw.mmgCheckoutIntent.create({
    data: {
      tenantId, adInvoiceId: invoice.id, merchantTransactionId: `9${String(Date.now())}${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`,
      amount: AMOUNT, currencyCode: 'GYD', createdByUserId: userId, platform: 'web', expiresAt: new Date(Date.now() + MMG_CHECKOUT_TTL_MS), ...sealedFields, ...data,
    } as never,
  });

  it('a reversal of an ad checkout is refused: MMG\'s rules for it are not known, so Swift promises none', async () => {
    const f = await invoiced();
    const page = await open(f);
    const txn = tx('NOREVERSE');
    mmgPaid(page.row, txn, AMOUNT);
    await ret({ token: replyOf(page.row, '0', txn) });
    vi.stubEnv(MMG_FEE_REVERSAL_SWITCH, 'on');
    vi.stubEnv('MMG_DRIVER', 'sandbox');
    const reversals = new MmgFeeReversalService({ prisma: app.prisma, billing: {} as never, notifications: new NotificationService(app.prisma, app.io), client: () => ({}) as never });
    await expect(runWithTenant(tenantId, () => reversals.requestReversal({ tenantId, checkoutId: page.ref, amountGyd: AMOUNT, reason: 'A reason for the test', actorId: f.owner.userId, approvalId: null }, async () => {})))
      .rejects.toMatchObject({ code: 'AD_CHECKOUT' });
    vi.unstubAllEnvs();
    process.env['ADS_ENABLED'] = '1';
    expect(await app.prisma.mmgFeeReversal.count({ where: { checkoutId: page.ref } })).toBe(0);
  });

  it('A2: a checkout for any other amount is refused by the database', async () => {
    const f = await invoiced();
    await expect(birth(f.invoice, f.owner.userId, { amount: AMOUNT - 1 })).rejects.toThrow();
  });

  it('a checkout under another tenant, or for a paid invoice, is refused by the database', async () => {
    const f = await invoiced();
    await expect(birth(f.invoice, f.owner.userId, { tenantId: 'another-tenant' })).rejects.toThrow();
    await adSettlement.markPaid(f.invoice.id, { providerRef: tx('FLOOR') });
    await expect(birth(f.invoice, f.owner.userId)).rejects.toThrow();
  });

  it('A3: a second open checkout for an invoice is refused by the database', async () => {
    const f = await invoiced();
    await open(f);
    await expect(birth(f.invoice, f.owner.userId)).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
  });

  it('a checkout has exactly one payer', async () => {
    const f = await invoiced();
    const sub = await app.prisma.subscription.findFirst({ select: { id: true } });
    await expect(birth(f.invoice, f.owner.userId, { subscriptionId: sub?.id ?? 'x' })).rejects.toThrow();
  });

  it('an ad checkout can never change hands', async () => {
    const a = await invoiced();
    const b = await invoiced();
    const page = await open(a);
    await expect(app.prisma.mmgCheckoutIntent.update({ where: { id: page.ref }, data: { adInvoiceId: b.invoice.id } })).rejects.toThrow(/immutable/);
    await expect(app.prisma.mmgCheckoutIntent.update({ where: { id: page.ref }, data: { amount: 1 } })).rejects.toThrow(/immutable/);
    await expect(app.prisma.mmgCheckoutIntent.update({ where: { id: page.ref }, data: { createdByUserId: b.owner.userId } })).rejects.toThrow(/immutable/);
  });
});
