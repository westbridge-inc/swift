import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient, type TenantKind } from '@prisma/client';
import { nanoid } from 'nanoid';
import { qrPublicRoutes } from '../modules/qr/qr-public.routes';
import { qrResolverRoutes } from '../modules/qr/qr-resolver.routes';
import { attributionRoutes } from '../modules/qr/attribution.routes';
import { AttributionService } from '../modules/qr/attribution.service';
import { QrService } from '../modules/qr/qr.service';
import { registerErrorHandler } from '../middleware/error-handler';
import { flushScanLog } from '../modules/qr/scan-log';
import { scopedClientFor } from '../plugins/prisma';
import { runWithTenant } from '../plugins/tenant-context';

const prisma = new PrismaClient();
const run = `qr-wall-${nanoid(10)}`;
const ios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)';
const request = { ip: '198.51.100.249', ua: ios };
let app: FastifyInstance;
let ownerId: string;
let publicTenant: string;
const tenants: string[] = [], vendors: string[] = [];
const hidden: Array<{ label: string; code: string; id: string; tenantId: string; slug: string }> = [];
let live: typeof hidden[number];
const unknown = 'ZZZZZZZZZZ';

async function tenant(kind: TenantKind, isActive = true) {
  const id = `${run}-${tenants.length}`;
  await prisma.tenant.create({ data: { id, slug: id, name: id, kind, isActive } });
  tenants.push(id);
  return id;
}
async function store(tenantId: string, label: string, status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE', isVerified = true) {
  const slug = `${run}-${vendors.length}`;
  const v = await prisma.vendor.create({ data: {
    tenantId, ownerId, name: slug, slug, vendorType: 'RESTAURANT', status, isVerified,
    phone: `+592${Date.now()}${vendors.length}`, addressLine1: '1 Test Street', city: 'Georgetown',
    region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
  } });
  vendors.push(v.id);
  const q = await new QrService(prisma).getOrCreateForVendor(v.id, (await prisma.vendorOwner.findUniqueOrThrow({ where: { id: ownerId } })).userId);
  return { label, code: q.shortCode, id: q.id, tenantId, slug };
}
async function boot(client: PrismaClient) {
  const a = Fastify({ logger: false });
  a.decorate('prisma', client);
  registerErrorHandler(a);
  await a.register(qrPublicRoutes, { prefix: '/api/v1/public' });
  await a.register(qrResolverRoutes);
  await a.register(attributionRoutes, { prefix: '/api/v1/attribution' });
  await a.ready();
  return a;
}
beforeAll(async () => {
  publicTenant = await tenant('PRODUCTION');
  const u = await prisma.user.create({ data: { tenantId: publicTenant, phone: `+592${Date.now()}99`, firstName: 'Test', lastName: 'Owner', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER' } });
  ownerId = (await prisma.vendorOwner.create({ data: { userId: u.id } })).id;
  live = await store(publicTenant, 'public');
  hidden.push(await store(await tenant('REVIEW'), 'review'));
  hidden.push(await store(await tenant('CRAWLER'), 'crawler'));
  hidden.push(await store(await tenant('PRODUCTION', false), 'inactive operator'));
  hidden.push(await store(publicTenant, 'inactive store', 'SUSPENDED'));
  hidden.push(await store(publicTenant, 'unverified store', 'ACTIVE', false));
  const retiredHidden = await store(hidden[0]!.tenantId, 'review retired');
  await prisma.qrCode.update({ where: { id: retiredHidden.id }, data: { status: 'DEACTIVATED' } });
  hidden.push(retiredHidden);
  app = await boot(prisma);
});
afterAll(async () => {
  if (app) await app.close();
  await prisma.pendingAttribution.deleteMany({ where: { qrCodeId: { in: (await prisma.qrCode.findMany({ where: { entityId: { in: vendors } }, select: { id: true } })).map(q => q.id) } } });
  await prisma.attributionClaim.deleteMany({ where: { installId: { startsWith: run } } });
  await prisma.scanEvent.deleteMany({ where: { qrCode: { entityId: { in: vendors } } } });
  await prisma.qrCode.deleteMany({ where: { entityId: { in: vendors } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendors } } });
  const owner = ownerId ? await prisma.vendorOwner.findUnique({ where: { id: ownerId } }) : null;
  if (owner) {
    await prisma.vendorOwner.delete({ where: { id: ownerId } });
    await prisma.user.delete({ where: { id: owner.userId } });
  }
  await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
  await prisma.$disconnect();
});

// Byte equality covers the body, verdict, destination and tenant hint; only
// volatile transport headers (Date/request id) are outside this contract.
const shape = (r: { statusCode: number; payload: string; headers: Record<string, unknown> }) => ({
  status: r.statusCode, body: r.payload, location: r.headers['location'], cache: r.headers['cache-control'],
});
const surfaces = ['json', 'redirect', 'app-open', 'intent', 'claim'] as const;
async function hit(a: FastifyInstance, surface: typeof surfaces[number], code: string) {
  if (surface === 'json') return a.inject({ method: 'GET', url: `/api/v1/public/qr/${code}` });
  if (surface === 'redirect') return a.inject({ method: 'GET', url: `/s/${code}` });
  if (surface === 'app-open') return a.inject({ method: 'POST', url: `/api/v1/public/qr/${code}/app-open` });
  if (surface === 'intent') return a.inject({ method: 'POST', url: '/api/v1/attribution/intent', payload: { shortCode: code }, headers: { 'user-agent': ios } });
  return a.inject({ method: 'POST', url: '/api/v1/attribution/claim', payload: { installId: `${run}-${nanoid(8)}`, platform: 'android', referrer: `swift_qr=${code}` } });
}
describe('AX343/SX374: hidden codes and unknown codes have one public answer', () => {
  for (const surface of surfaces) it(`${surface}: REVIEW, CRAWLER, inactive and unverified stores are byte-identical to missing`, async () => {
    const absent = shape(await hit(app, surface, unknown));
    expect(absent.status).toBe(surface === 'redirect' ? 302 : surface === 'intent' ? 404 : 200);
    for (const q of hidden) expect(shape(await hit(app, surface, q.code)), q.label).toEqual(absent);
    await flushScanLog();
    expect(await prisma.scanEvent.count({ where: { qrCodeId: { in: hidden.map(q => q.id) } } })).toBe(0);
  });
  it('a public PRODUCTION code retains its store destination and lifecycle', async () => {
    const r = await hit(app, 'json', live.code);
    expect(r.json().data).toMatchObject({ verdict: 'WEB_RENDER', slug: live.slug });
    expect((await hit(app, 'redirect', live.code)).headers.location).toContain(`/store/${live.slug}?`);
    expect((await hit(app, 'app-open', live.code)).json().data.recorded).toBe(true);
    expect((await hit(app, 'claim', live.code)).json().data).toEqual({ destination: `/store/${live.slug}`, tenantHint: publicTenant });
  });
});
describe('attribution revalidates the current target, including receipts and race winners', () => {
  it('an iOS candidate for a now-hidden store yields no destination or tenant hint', async () => {
    const q = await store(publicTenant, 'ios-hide');
    const svc = new AttributionService(prisma);
    await svc.intent(q.code, { ...request, isIos: true });
    await prisma.vendor.update({ where: { id: vendors.at(-1)! }, data: { status: 'SUSPENDED' } });
    expect(await svc.claim(`${run}-ios-hide`, 'ios', undefined, request)).toEqual({ destination: null, tenantHint: null, outcome: 'none' });
    expect((await prisma.pendingAttribution.findFirstOrThrow({ where: { qrCodeId: q.id } })).claimedAt).toBeNull();
    expect((await prisma.attributionClaim.findUniqueOrThrow({ where: { installId: `${run}-ios-hide` } })).qrCodeId).toBeNull();
  });
  it('a cached Android receipt stops disclosing a store after it becomes hidden', async () => {
    const q = await store(publicTenant, 'receipt-hide');
    const svc = new AttributionService(prisma), id = `${run}-receipt-hide`;
    expect((await svc.claim(id, 'android', `swift_qr=${q.code}`, request)).destination).toBe(`/store/${q.slug}`);
    await prisma.vendor.update({ where: { id: vendors.at(-1)! }, data: { isVerified: false } });
    expect(await svc.claim(id, 'android', `swift_qr=${live.code}`, request)).toEqual({ destination: null, tenantHint: null, outcome: 'none' });
  });
  it('a receipt and an iOS candidate derive the CURRENT slug, never their stored path', async () => {
    const q = await store(publicTenant, 'rename');
    const svc = new AttributionService(prisma), id = `${run}-rename`;
    await svc.claim(id, 'android', `swift_qr=${q.code}`, request);
    await svc.intent(q.code, { ip: '198.51.100.247', ua: ios, isIos: true });
    const slug = `${q.slug}-new`;
    await prisma.vendor.update({ where: { id: vendors.at(-1)! }, data: { slug } });
    expect((await svc.claim(id, 'android', undefined, request)).destination).toBe(`/store/${slug}`);
    expect((await svc.claim(`${run}-ios-rename`, 'ios', undefined, { ip: '198.51.100.247', ua: ios })).destination).toBe(`/store/${slug}`);
  });
  it('the winner found under the per-install lock also revalidates a hidden receipt', async () => {
    const q = hidden[0]!, id = `${run}-race`;
    // Model the first SELECT missing a concurrent winner: the re-read under the
    // per-install lock finds the materialized receipt, writes nothing, and the
    // receipt is revalidated like any replay.
    await prisma.attributionClaim.create({ data: { tenantId: q.tenantId, qrCodeId: q.id, installId: id, platform: 'android', outcome: 'deterministic', destinationPath: `/store/${q.slug}` } });
    const firstRead = vi.spyOn(prisma.attributionClaim, 'findUnique').mockResolvedValueOnce(null);
    try {
      expect(await new AttributionService(prisma).claim(id, 'android', `swift_qr=${live.code}`, request)).toEqual({ destination: null, tenantHint: null, outcome: 'none' });
      expect(firstRead).toHaveBeenCalledOnce();
      expect(await prisma.attributionClaim.count({ where: { installId: id } })).toBe(1);
    } finally { firstRead.mockRestore(); }
  });
  it('the P2002 winner path (a writer outside the lock) also revalidates a hidden receipt', async () => {
    const q = hidden[0]!, id = `${run}-race-p2002`;
    await prisma.attributionClaim.create({ data: { tenantId: q.tenantId, qrCodeId: q.id, installId: id, platform: 'android', outcome: 'deterministic', destinationPath: `/store/${q.slug}` } });
    const firstRead = vi.spyOn(prisma.attributionClaim, 'findUnique').mockResolvedValueOnce(null);
    const { Prisma } = await import('@prisma/client');
    const tx = vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('synthetic unique collision', { code: 'P2002', clientVersion: '6' }));
    try {
      expect(await new AttributionService(prisma).claim(id, 'android', `swift_qr=${live.code}`, request)).toEqual({ destination: null, tenantHint: null, outcome: 'none' });
      expect(tx).toHaveBeenCalledOnce();
    } finally { tx.mockRestore(); firstRead.mockRestore(); }
  });
  it('a corrupt receipt tenant cannot borrow another code’s current destination', async () => {
    // Real storage rejects corruption; a historical receipt is simulated at
    // the delegate boundary so this separately grades read-side lineage.
    const spy = vi.spyOn(prisma.attributionClaim, 'findUnique').mockResolvedValueOnce({ id: 'old', installId: `${run}-corrupt`, tenantId: hidden[0]!.tenantId, qrCodeId: live.id, destinationPath: `/store/${live.slug}`, platform: 'android', outcome: 'matched', createdAt: new Date() });
    try {
      expect(await new AttributionService(prisma).claim(`${run}-corrupt`, 'android', undefined, request)).toEqual({ destination: null, tenantHint: null, outcome: 'none' });
    } finally { spy.mockRestore(); }
  });
});

it('real routes work with FORCE RLS, NOBYPASSRLS app role and unscoped access denied', async () => {
  const url = new URL(process.env['DATABASE_URL']!);
  url.searchParams.set('options', '-c role=swift_app');
  const client = new PrismaClient({ datasourceUrl: url.toString() });
  const oldBind = process.env['TENANT_RLS_BIND'], oldDeny = process.env['TENANT_UNSCOPED_ACCESS'];
  process.env['TENANT_RLS_BIND'] = '1'; process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  // The production client shape (#1444): request scoping on the swift_app
  // login, system transactions routed to the system connection at BEGIN.
  const a = await boot(scopedClientFor(client, prisma));
  try {
    const roles = await client.$queryRaw<Array<{ role: string; superuser: boolean; bypass: boolean }>>`SELECT current_user::text AS role, rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`;
    expect(roles).toEqual([{ role: 'swift_app', superuser: false, bypass: false }]);
    expect(await client.qrCode.count({ where: { id: live.id } })).toBe(0);
    expect(await runWithTenant(publicTenant, () => a.prisma.qrCode.count({ where: { id: live.id } }))).toBe(1);
    for (const surface of surfaces) {
      const absent = shape(await hit(a, surface, unknown));
      for (const q of hidden) expect(shape(await hit(a, surface, q.code)), `${surface}: ${q.label}`).toEqual(absent);
    }
    expect((await hit(a, 'json', live.code)).json().data.verdict).toBe('WEB_RENDER');
    expect((await hit(a, 'claim', live.code)).json().data.destination).toBe(`/store/${live.slug}`);
  } finally {
    await a.close(); await client.$disconnect();
    if (oldBind === undefined) delete process.env['TENANT_RLS_BIND']; else process.env['TENANT_RLS_BIND'] = oldBind;
    if (oldDeny === undefined) delete process.env['TENANT_UNSCOPED_ACCESS']; else process.env['TENANT_UNSCOPED_ACCESS'] = oldDeny;
  }
});
