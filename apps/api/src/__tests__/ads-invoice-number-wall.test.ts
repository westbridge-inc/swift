/**
 * [ADS-ON · REVIEW-M #2325] An ad invoice number under production's tenant posture. Numbers are unique across
 * operators, and a request sees one operator behind the wall: a number worked out from the rows would be one another
 * operator already holds, and that operator's first invoice could never be issued. Measured through the route, on
 * the app's own client on a walled login, so the sequence's grant is proven as well. Synthetic fixtures only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { testPrismaClient } from './helpers/test-prisma-client';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';
import { sessionCredentialDigest } from '../lib/session-credential';

// [R048-001] creates only this suite's temporary request/system LOGIN roles, by raw DDL.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND', 'ADS_ENABLED'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const RUN = wordFreeTag(8);
const DEFAULT_OPERATOR = 'swift-default';
const OTHER_OPERATOR = `adnum-${RUN}`;
const DAY = 86_400_000;
const WEEK = new Date('2027-06-14T00:00:00Z');

let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let app: FastifyInstance;
let prismaModule: typeof import('../plugins/prisma') | null = null;
const payers: Array<{ userId: string; advertiserId: string; campaignId: string; token: string }> = [];
// Far past anything the sequence reaches: a number worked out from what the second operator can see lands on the first's.
const SEEN = 900_000_000 + Math.floor(Math.random() * 90_000_000);
const numberOf = (seq: number) => `ADS-${new Date().getUTCFullYear()}-${seq}`;

async function payerIn(tenantId: string) {
  const tag = nanoid(8);
  const user = await owner.user.create({ data: { phone: testPhone(), firstName: 'Ads', lastName: `Number${RUN}`, tenantId, isPhoneVerified: true, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', customer: { create: {} } } });
  const advertiser = await owner.advertiser.create({ data: { tenantId, companyName: `Number Co ${tag}`, industry: 'RETAIL', contactName: 'N', contactEmail: `n-${RUN}@example.test`, contactPhone: '+5926000000', status: 'APPROVED', createdByUserId: user.id } });
  await owner.advertiserMember.create({ data: { advertiserId: advertiser.id, userId: user.id, role: 'OWNER', acceptedAt: new Date() } });
  const placement = await owner.adPlacement.create({ data: { tenantId, key: `adnum_${tag}`, name: 'Number', tier: 3, mediaKind: 'IMAGE', weeklyPrice: 1000, slotsPerWeek: 6 } });
  const campaign = await owner.adCampaign.create({ data: { tenantId, advertiserId: advertiser.id, placementId: placement.id, name: `Number ${tag}`, cities: ['*'], startWeek: WEEK, endWeek: WEEK, totalAmount: 1000 } });
  return { userId: user.id, advertiserId: advertiser.id, campaignId: campaign.id };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  owner = testPrismaClient(TEST_URL);
  logins = await createTenantProbeLogins(owner, TEST_URL);
  await owner.tenant.create({ data: { id: OTHER_OPERATOR, name: 'Ad number operator', slug: OTHER_OPERATOR, isActive: true } });
  const people = [await payerIn(DEFAULT_OPERATOR), await payerIn(OTHER_OPERATOR)];
  const voidInvoice = (person: (typeof people)[number], tenantId: string, seq: number) => owner.adInvoice.create({ data: { tenantId, advertiserId: person.advertiserId, campaignId: person.campaignId, number: numberOf(seq), amount: 1000, status: 'VOID' } });
  await voidInvoice(people[1]!, OTHER_OPERATOR, SEEN);
  await voidInvoice(people[0]!, DEFAULT_OPERATOR, SEEN + 1);

  // The app's OWN client on the walled login, and the contract's settings, BEFORE the app's modules load their client.
  process.env['DATABASE_URL'] = logins.requestUrl;
  process.env['SYSTEM_DATABASE_URL'] = logins.systemUrl;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  process.env['ADS_ENABLED'] = '1';
  const Fastify = (await import('fastify')).default;
  prismaModule = await import('../plugins/prisma');
  const { redisPlugin } = await import('../plugins/redis');
  const { authPlugin } = await import('../plugins/auth');
  const { socketPlugin } = await import('../plugins/socket');
  const { registerErrorHandler } = await import('../middleware/error-handler');
  const { beginRequestTenantContext } = await import('../plugins/tenant-context');
  const { adsRoutes } = await import('../modules/ads/ads.routes');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaModule.prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  // server.ts's request context boundary: every request starts with no tenant bound.
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(adsRoutes, { prefix: '/api/v1/ads' });
  await app.ready();
  for (const person of people) {
    const token = app.jwt.sign({ userId: person.userId, role: 'CUSTOMER', jti: nanoid(8) });
    await owner.session.create({ data: { userId: person.userId, token: sessionCredentialDigest(token), refreshToken: sessionCredentialDigest(nanoid(48)), deviceId: `adnum-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
    payers.push({ ...person, token });
  }
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prismaModule?.systemPrismaClient()?.$disconnect().catch(() => {});
  prismaModule?.setSystemPrismaClient(null);
  for (const k of ENV_KEYS) {
    if (priorEnv[k] === undefined) delete process.env[k]; else process.env[k] = priorEnv[k];
  }
  await logins?.cleanup();
  await owner.adInvoice.deleteMany({ where: { number: { in: [numberOf(SEEN), numberOf(SEEN + 1)] } } });
  await owner.$disconnect();
});

describe('an ad invoice number under the tenant wall', () => {
  const checkout = (payer: { campaignId: string; token: string }) => app.inject({
    method: 'POST', url: `/api/v1/ads/campaigns/${payer.campaignId}/checkout`,
    headers: { authorization: `Bearer ${payer.token}`, 'content-type': 'application/json' }, payload: { provider: 'MOCK' },
  });

  it('a second operator can invoice: neither can see the other\'s numbers, and no number is issued twice', async () => {
    const [first, second] = [await checkout(payers[0]!), await checkout(payers[1]!)];
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    const numbers = [first.json().data.number as string, second.json().data.number as string];
    expect(new Set(numbers).size).toBe(2);
    expect(numbers).not.toContain(numberOf(SEEN + 1));
    const issued = await owner.adInvoice.findMany({ where: { campaignId: { in: payers.map((p) => p.campaignId) }, status: 'UNPAID' }, select: { tenantId: true, number: true } });
    expect(new Map(issued.map((i) => [i.tenantId, i.number]))).toEqual(new Map([[DEFAULT_OPERATOR, numbers[0]], [OTHER_OPERATOR, numbers[1]]]));
  });
});
