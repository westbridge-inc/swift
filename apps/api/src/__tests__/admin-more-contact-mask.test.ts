import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { runWithoutTenant } from '../plugins/tenant-context';
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../lib/audit-immutability';
import { luhnCheckDigit } from '../modules/billing/san';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [SEC-PII · REVIEW-G #2170 S3-2] The person lists mask phone numbers unless the admin's live grant holds the
// matching contact capability (#2170). Five more admin reads still sent full numbers:
//   GET /billing/collections        a store owner's / mover's number (and a wa.me link that spells it out)
//   GET /billing/san/:san           the rider's or driver's number behind a payment reference
//   GET /integrity/identity/:userId every identity-group member's number
//   GET /integrity/appeals          the number of each person with an open appeal
//   GET /verification/queue         the applicant's number
// Each now masks (and the wa.me link is withheld) unless the live grant holds vendor/mover/user .contact.read.
// ---------------------------------------------------------------------------

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
// A store name the catalogue checker reads: word-free letters only (checked-names.test.ts).
const STORE_TAG = wordFreeTag();
const DAY = 86_400_000;
const SAN_BODY = String(100000000 + Math.floor(Math.random() * 800000000)).slice(0, 9);
const SAN = `${SAN_BODY}${luhnCheckDigit(SAN_BODY)}`;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'admin-more-contact-mask-test');
const masked = (phone: string) => new RegExp(`•+${phone.slice(-4)}$`);

let app: FastifyInstance;
const userIds: string[] = [];
const tokens: Record<string, string> = {};
const phones = { owner: testPhone(), rider: testPhone(), applicant: testPhone(), member: testPhone(), appellant: testPhone() };
const ids = { owner: '', vendorOwner: '', vendor: '', vendorSub: '', riderUser: '', rider: '', riderSub: '', applicant: '', doc: '', member: '', appellant: '', enforcement: '', cluster: '' };

async function person(phone: string, roles: string[], extra: Record<string, unknown> = {}) {
  const u = await system(() => app.prisma.user.create({ data: {
    phone, firstName: 'Mask', lastName: `M${RUN}`, roles: roles as never, activeRole: roles[0] as never, status: 'ACTIVE', isPhoneVerified: true, ...extra,
  } as never }));
  userIds.push(u.id);
  return u.id;
}
async function adminWith(name: string, role: 'ADMIN' | 'SUPER_ADMIN', permissions: readonly string[]) {
  const id = await person(testPhone(), [role, 'CUSTOMER'], { admin: { create: { permissions: [...permissions] } } });
  const token = app.jwt.sign({ userId: id, role, jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: { userId: id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `mm-${RUN}-${name}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  tokens[name] = token;
}
const get = (url: string, token: string) => app.inject({ method: 'GET', url: `/api/v1/admin${url}`, headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const week = new Date(Date.now() + 7 * DAY);
  ids.owner = await person(phones.owner, ['VENDOR_OWNER', 'CUSTOMER']);
  ids.vendorOwner = (await system(() => app.prisma.vendorOwner.create({ data: { userId: ids.owner } }))).id;
  ids.vendor = (await system(() => app.prisma.vendor.create({ data: {
    ownerId: ids.vendorOwner, name: `Mask Counter ${STORE_TAG}`, slug: `mm-${RUN.toLowerCase()}`, vendorType: 'RESTAURANT', phone: testPhone(),
    addressLine1: '1 Mask St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.801, longitude: -58.156, status: 'ACTIVE',
  } as never }))).id;
  ids.vendorSub = (await system(() => app.prisma.subscription.create({ data: {
    vendorId: ids.vendor, type: 'RESTAURANT', status: 'PAST_DUE', weeklyRate: 20000, currentPeriodStart: new Date(), currentPeriodEnd: week, nextBillingDate: week,
  } as never }))).id;
  ids.riderUser = await person(phones.rider, ['RIDER']);
  ids.rider = (await system(() => app.prisma.rider.create({ data: { userId: ids.riderUser, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } as never }))).id;
  ids.riderSub = (await system(() => app.prisma.subscription.create({ data: {
    riderId: ids.rider, type: 'DELIVERY_RIDER', status: 'ACTIVE', weeklyRate: 1000, currentPeriodStart: new Date(), currentPeriodEnd: week, nextBillingDate: week, san: SAN, sanAssignedAt: new Date(),
  } as never }))).id;
  ids.applicant = await person(phones.applicant, ['RIDER']);
  ids.doc = (await system(() => app.prisma.verificationDocument.create({ data: { userId: ids.applicant, role: 'MOVER', docType: 'drivers_licence', fileUrl: '', status: 'PENDING' } as never }))).id;
  ids.member = await person(phones.member, ['CUSTOMER']);
  ids.cluster = `cl-${nanoid(8)}`;
  await system(async () => {
    await app.prisma.identityCluster.create({ data: { id: ids.cluster } });
    await app.prisma.identityClusterMember.create({ data: { accountId: ids.member, clusterId: ids.cluster, linkedVia: [] } });
  });
  ids.appellant = await person(phones.appellant, ['CUSTOMER']);
  ids.enforcement = (await system(() => app.prisma.enforcementAction.create({ data: { accountId: ids.appellant, level: 'DENY_TRIAL', reasonCode: 'SYNTHETIC', signalsFired: [], decidedBy: 'SYSTEM', appeal: 'OPEN' } as never }))).id;

  await adminWith('readers', 'SUPER_ADMIN', ['billing.read', 'billing.san.read', 'verification.read', 'integrity.read', 'integrity.identity.read']);
  await adminWith('contacts', 'SUPER_ADMIN', ['billing.read', 'billing.san.read', 'verification.read', 'integrity.read', 'integrity.identity.read', 'user.contact.read', 'mover.contact.read', 'vendor.contact.read']);
  await adminWith('all', 'SUPER_ADMIN', ['*']);
  await adminWith('moverOnly', 'SUPER_ADMIN', ['billing.read', 'billing.san.read', 'mover.contact.read']);
});

afterAll(async () => {
  await system(async () => {
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:admin-more-contact-mask').catch(() => 0);
    await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: userIds } }, 'test-cleanup:admin-more-contact-mask').catch(() => 0);
    await app.prisma.enforcementAction.deleteMany({ where: { id: ids.enforcement } });
    await app.prisma.identityClusterMember.deleteMany({ where: { clusterId: ids.cluster } });
    await app.prisma.identityCluster.deleteMany({ where: { id: ids.cluster } });
    await app.prisma.verificationDocument.deleteMany({ where: { id: ids.doc } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: [ids.vendorSub, ids.riderSub] } } });
    await app.prisma.rider.deleteMany({ where: { id: ids.rider } });
    await app.prisma.vendor.deleteMany({ where: { id: ids.vendor } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: ids.vendorOwner } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  await app.close();
});

const reads = () => ({
  collections: { url: '/billing/collections?tab=pastdue', phone: phones.owner },
  san: { url: `/billing/san/${SAN}`, phone: phones.rider },
  identity: { url: `/integrity/identity/${ids.member}`, phone: phones.member },
  appeals: { url: '/integrity/appeals', phone: phones.appellant },
  queue: { url: '/verification/queue?status=PENDING&limit=100', phone: phones.applicant },
});

describe('[SEC-PII #2170 S3-2] five more admin reads mask phone numbers without the contact capability', () => {
  it('a grant that may open each read but holds no contact capability sees no full number (and no wa.me link)', async () => {
    for (const [name, r] of Object.entries(reads())) {
      const res = await get(r.url, tokens['readers']!);
      expect(res.statusCode, `${name} ${res.payload.slice(0, 200)}`).toBe(200);
      expect(res.payload, name).not.toContain(r.phone);
      expect(res.payload, name).not.toContain(r.phone.replace(/\D/g, ''));
      expect(res.payload, name).toMatch(new RegExp(`•+${r.phone.slice(-4)}`));
    }
    const row = (await get(reads().collections.url, tokens['readers']!)).json().data.find((c: { subscriptionId: string }) => c.subscriptionId === ids.vendorSub);
    expect(row.phone).toMatch(masked(phones.owner));
    expect(row.waLink).toBeNull();
    expect((await get(reads().san.url, tokens['readers']!)).json().data.holder.phone).toMatch(masked(phones.rider));
  });

  it('the matching contact capability (or *) shows the full number, as before', async () => {
    for (const token of ['contacts', 'all']) {
      for (const [name, r] of Object.entries(reads())) {
        const res = await get(r.url, tokens[token]!);
        expect(res.statusCode, name).toBe(200);
        expect(res.payload, `${token} ${name}`).toContain(r.phone);
      }
      const row = (await get(reads().collections.url, tokens[token]!)).json().data.find((c: { subscriptionId: string }) => c.subscriptionId === ids.vendorSub);
      expect(row.waLink).toBe(`https://wa.me/${phones.owner.replace(/\D/g, '')}`);
    }
  });

  it('each capability opens only its own people: mover.contact.read shows the mover behind a payment reference, never a store owner', async () => {
    expect((await get(reads().san.url, tokens['moverOnly']!)).json().data.holder.phone).toBe(phones.rider);
    const row = (await get(reads().collections.url, tokens['moverOnly']!)).json().data.find((c: { subscriptionId: string }) => c.subscriptionId === ids.vendorSub);
    expect(row.phone).toMatch(masked(phones.owner));
    expect(row.waLink).toBeNull();
  });
});
