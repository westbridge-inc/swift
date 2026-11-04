import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerAuthRoutes } from './helpers/auth-routes-harness';
import { loginWithOtp } from './helpers/otp';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [BUG-HUNT F06] The Review Center's approval never sets the old documentsVerified flag, and GO reads the live document
// verdict, so a fully approved rider who is online read "Documents not verified" on three screens, beside a Verify
// button that looked required and did nothing a rider needed. The list filters, the person page and the mover page now
// answer from the same verdict GO uses. Synthetic data only.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const MOTORCYCLE_DOCS = ['drivers_licence', 'vehicle_registration', 'vehicle_insurance'];
const marker = nanoid(6).toLowerCase();
let app: FastifyInstance;
let adminToken: string;
const userIds: string[] = [];
const search = `Truth${marker.replace(/[^a-z]/g, 'x')}`;

async function makeRider(firstName: string, opts: { documents: boolean; legacy?: boolean }) {
  const user = await app.prisma.user.create({
    data: { phone: testPhone(), firstName, lastName: search, roles: ['MOVER', 'CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never, isPhoneVerified: true, countryCode: 'GY' },
  });
  userIds.push(user.id);
  const rider = await app.prisma.rider.create({ data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: opts.legacy ?? false } });
  if (opts.documents) {
    for (const docType of MOTORCYCLE_DOCS) {
      await app.prisma.verificationDocument.create({
        data: { userId: user.id, role: 'MOVER' as never, docType, fileUrl: `test/${marker}/${docType}-${nanoid(4)}`, status: 'APPROVED', expiresAt: new Date(Date.now() + 365 * DAY) } as never,
      });
    }
  }
  return { user, rider };
}

const read = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${adminToken}` } });
const list = async (status: string, extra = '') => {
  const res = await read(`/api/v1/admin/riders?status=${status}&search=${search}${extra}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { data: Array<{ id: string; documentsLive: { allowed: boolean } | null }>; meta: { total: number } };
};

let approved: Awaited<ReturnType<typeof makeRider>>;
let approvedTwo: Awaited<ReturnType<typeof makeRider>>;
let waiting: Awaited<ReturnType<typeof makeRider>>;

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await registerAuthRoutes(app);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  adminToken = (await loginWithOtp(app, '+5926001000')).json().data.tokens.accessToken;
  approved = await makeRider('Approved', { documents: true });
  approvedTwo = await makeRider('Second', { documents: true });
  waiting = await makeRider('Waiting', { documents: false });
}, 60_000);

afterAll(async () => {
  await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  await app.close();
});

describe('[F06] the list filters read the verdict GO uses', () => {
  it('an approved rider is in "verified", though the old flag is false', async () => {
    const found = await list('verified');
    expect(found.data.map((r) => r.id).sort()).toEqual([approved.rider.id, approvedTwo.rider.id].sort());
    expect(found.meta.total).toBe(2);
    expect(found.data.every((r) => r.documentsLive?.allowed === true)).toBe(true);
  });

  it('"unverified" is the rider who is really missing documents', async () => {
    const found = await list('unverified');
    expect(found.data.map((r) => r.id)).toEqual([waiting.rider.id]);
    expect(found.meta.total).toBe(1);
  });

  it('it pages like any list: the total is every match, a page is its limit', async () => {
    const first = await list('verified', '&limit=1&page=1');
    const second = await list('verified', '&limit=1&page=2');
    expect(first.meta.total).toBe(2);
    expect(first.data).toHaveLength(1);
    expect(second.data).toHaveLength(1);
    expect(second.data[0]!.id).not.toBe(first.data[0]!.id);
  });

  it('online and offline are untouched', async () => {
    expect((await list('offline')).meta.total).toBe(3);
    expect((await list('online')).meta.total).toBe(0);
  });
});

describe('[F06] one answer on every screen', () => {
  it('the person page carries the same verdict', async () => {
    const res = await read(`/api/v1/admin/users/${approved.user.id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.rider.documentsLive).toMatchObject({ allowed: true, reason: 'ok' });
    const none = await read(`/api/v1/admin/users/${waiting.user.id}`);
    expect(none.json().data.rider.documentsLive).toMatchObject({ allowed: false, reason: 'docs' });
  });

  it('a person with no rider or driver profile carries none', async () => {
    const res = await read(`/api/v1/admin/users/${userIds[0]}`);
    expect(res.json().data.driver).toBeNull();
  });

  it('nothing is left to verify for a rider the gate lets online: the checklist says so', async () => {
    const data = (await read(`/api/v1/admin/riders/${approved.rider.id}/activation-checklist`)).json().data;
    expect(data).toMatchObject({ next: 'VERIFIED', live: { allowed: true } });
  });

  it('a rider with documents missing is still told so', async () => {
    const data = (await read(`/api/v1/admin/riders/${waiting.rider.id}/activation-checklist`)).json().data;
    expect(data).toMatchObject({ next: 'NEEDS_DOCUMENTS', live: { allowed: false } });
  });
});
