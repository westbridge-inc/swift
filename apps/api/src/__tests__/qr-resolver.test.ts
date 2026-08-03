import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { qrResolverRoutes } from '../modules/qr/qr-resolver.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { QrService, QR_GRACE_CONFIG_KEY } from '../modules/qr/qr.service';
import { flushScanLog, resetScanLogForTests } from '../modules/qr/scan-log';

// ---------------------------------------------------------------------------
// QR growth engine, slice 1 — the /s/:code resolver against real rows (every
// decision-table row over HTTP), the vendor QrCode lifecycle endpoints, the
// no-oracle law, scan-event privacy, and the one-ACTIVE concurrency guard.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const WEB = 'https://web.swift.test';

let app: FastifyInstance;
let qrService: QrService;

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
let seq = 0;
const phoneBase = 592_870_000_000 + Math.floor(Math.random() * 9_000_000);

async function makeOwner() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Qr',
      lastName: `Owner${seq}`,
      roles: ['VENDOR_OWNER'] as UserRole[],
      activeRole: 'VENDOR_OWNER',
      isPhoneVerified: true,
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'qr-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

async function makeVendor(userId: string, over: { status?: 'ACTIVE' | 'SUSPENDED'; isVerified?: boolean } = {}) {
  const owner = await app.prisma.vendorOwner.upsert({ where: { userId }, create: { userId }, update: {} });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Qr Vendor ${seq}-${nanoid(4)}`,
      slug: `qr-vendor-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT',
      phone: `+${phoneBase + 500_000 + seq}`,
      addressLine1: '1 Scan Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
      status: over.status ?? 'ACTIVE',
      isVerified: over.isVerified ?? true,
      acceptingOrders: true,
    },
  });
  createdVendorIds.push(vendor.id);
  return vendor;
}

const scan = (code: string, opts: { query?: string; ip?: string; ua?: string } = {}) =>
  app.inject({
    method: 'GET',
    url: `/s/${code}${opts.query ?? ''}`,
    remoteAddress: opts.ip ?? '203.0.113.10',
    headers: { 'user-agent': opts.ua ?? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)' },
  });

const vendorGet = (token: string) =>
  app.inject({ method: 'GET', url: '/api/v1/vendor/qr', headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  process.env['APP_PUBLIC_URL'] = WEB;
  app = Fastify({ logger: false });
  await app.register(rateLimit, { max: 500, timeWindow: '1 minute' });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  registerErrorHandler(app);
  await app.register(qrResolverRoutes);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  // CI preps the DB with `prisma db push`, which cannot see raw DDL — the
  // one-ACTIVE race guard self-installs here, idempotently (the established
  // pattern; the migration remains prod's source of truth).
  await app.prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "one_active_qr_per_entity" ON "qr_codes"("tenantId", "entityType", "entityId") WHERE status = 'ACTIVE'`,
  );
  resetScanLogForTests();
  qrService = new QrService(app.prisma);
});

afterAll(async () => {
  await app.prisma.platformConfig.deleteMany({ where: { key: QR_GRACE_CONFIG_KEY } });
  await app.prisma.scanEvent.deleteMany({ where: { OR: [{ qrCode: { entityId: { in: createdVendorIds } } }, { qrCodeId: null }] } });
  await app.prisma.qrCode.deleteMany({ where: { entityId: { in: createdVendorIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('vendor get-or-create', () => {
  it('mints once, then returns the same code forever (idempotent), svg encodes the SHORT link', async () => {
    const owner = await makeOwner();
    await makeVendor(owner.userId);

    const first = await vendorGet(owner.token);
    expect(first.statusCode).toBe(200);
    const a = first.json().data;
    expect(a.shortCode).toMatch(/^[23456789BCDFGHJKMNPQRSTVWXYZ]{10}$/);
    expect(a.shortUrl).toBe(`${WEB}/s/${a.shortCode}`);
    expect(a.deepLink).toBe(a.shortUrl); // legacy alias the mobile card renders
    expect(a.version).toBe(1);
    expect(a.status).toBe('ACTIVE');
    expect(a.svg).toContain('<svg');

    const second = await vendorGet(owner.token);
    expect(second.json().data.shortCode).toBe(a.shortCode);
  });

  it('two owners can never see or affect each other’s codes', async () => {
    const ownerA = await makeOwner();
    const vendorA = await makeVendor(ownerA.userId);
    const codeA = (await vendorGet(ownerA.token)).json().data.shortCode;

    const ownerB = await makeOwner();
    await makeVendor(ownerB.userId);
    // Even naming A's vendor id explicitly, B's access resolves inside B's own
    // membership — never A's entity.
    const res = await app.inject({
      method: 'GET', url: '/api/v1/vendor/qr',
      headers: { authorization: `Bearer ${ownerB.token}`, 'x-vendor-id': vendorA.id },
    });
    if (res.statusCode === 200) {
      expect(res.json().data.shortCode).not.toBe(codeA);
    } else {
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('the resolver decision table over HTTP', () => {
  it('valid + live → 302 to the CURRENT slug with src/c, no-store, case-insensitive input', async () => {
    const owner = await makeOwner();
    const vendor = await makeVendor(owner.userId);
    const code = (await vendorGet(owner.token)).json().data.shortCode as string;

    const res = await scan(code.toLowerCase(), { query: '?t=Sticker&src=share' });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe(`${WEB}/store/${vendor.slug}?src=qr&c=${code}&t=sticker`);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('hostile t is dropped from the redirect entirely', async () => {
    const owner = await makeOwner();
    const vendor = await makeVendor(owner.userId);
    const code = (await vendorGet(owner.token)).json().data.shortCode as string;
    const res = await scan(code, { query: `?t=${encodeURIComponent('https://evil.example/../x')}` });
    expect(res.headers['location']).toBe(`${WEB}/store/${vendor.slug}?src=qr&c=${code}`);
  });

  it('no oracle: malformed and unknown-but-well-formed are indistinguishable', async () => {
    const malformed = await scan('NOT-A-CODE!!');
    const unknown = await scan('BCDFGHJKMN'); // valid shape, no row
    expect(malformed.statusCode).toBe(302);
    expect(unknown.statusCode).toBe(302);
    expect(malformed.headers['location']).toBe(`${WEB}/qr/not-found`);
    expect(unknown.headers['location']).toBe(malformed.headers['location']);
  });

  it('suspended vendor → the unavailable page, with zero reason leakage', async () => {
    const owner = await makeOwner();
    const vendor = await makeVendor(owner.userId);
    const code = (await vendorGet(owner.token)).json().data.shortCode as string;
    await app.prisma.vendor.update({ where: { id: vendor.id }, data: { status: 'SUSPENDED' } });

    const res = await scan(code);
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe(`${WEB}/qr/unavailable`);
  });

  it('unverified (doc-lapsed) vendor is equally just "unavailable"', async () => {
    const owner = await makeOwner();
    await makeVendor(owner.userId, { isVerified: false });
    const code = (await vendorGet(owner.token)).json().data.shortCode as string;
    const res = await scan(code);
    expect(res.headers['location']).toBe(`${WEB}/qr/unavailable`);
  });
});

describe('lifecycle: regenerate grace + deactivate kill switch', () => {
  it('regenerate supersedes with grace (old resolves; grace=0 config retires it) and deactivate kills immediately', async () => {
    const owner = await makeOwner();
    const vendor = await makeVendor(owner.userId);
    const oldCode = (await vendorGet(owner.token)).json().data.shortCode as string;

    const regen = await app.inject({
      method: 'POST', url: '/api/v1/vendor/qr/regenerate',
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(regen.statusCode).toBe(200);
    const next = regen.json().data;
    expect(next.version).toBe(2);
    expect(next.shortCode).not.toBe(oldCode);
    expect(next.previous.shortCode).toBe(oldCode);
    expect(next.previous.graceDays).toBe(30);

    // Row 9: within grace the old printed code still lands on the store.
    expect((await scan(oldCode)).headers['location']).toBe(`${WEB}/store/${vendor.slug}?src=qr&c=${oldCode}`);
    // The new code resolves too.
    expect((await scan(next.shortCode)).headers['location']).toBe(`${WEB}/store/${vendor.slug}?src=qr&c=${next.shortCode}`);

    // QR-P: grace is CONFIG, and changing it visibly changes behavior.
    await app.prisma.platformConfig.upsert({
      where: { key: QR_GRACE_CONFIG_KEY },
      create: { key: QR_GRACE_CONFIG_KEY, value: 0 },
      update: { value: 0 },
    });
    expect((await scan(oldCode)).headers['location']).toBe(`${WEB}/qr/retired?store=${vendor.slug}`);
    await app.prisma.platformConfig.deleteMany({ where: { key: QR_GRACE_CONFIG_KEY } });

    // Deactivate needs an explicit confirm, is owner-gated, and kills NOW.
    const noConfirm = await app.inject({
      method: 'POST', url: '/api/v1/vendor/qr/deactivate',
      headers: { authorization: `Bearer ${owner.token}` }, payload: {},
    });
    expect(noConfirm.statusCode).toBe(400);

    const kill = await app.inject({
      method: 'POST', url: '/api/v1/vendor/qr/deactivate',
      headers: { authorization: `Bearer ${owner.token}` }, payload: { confirm: true },
    });
    expect(kill.statusCode).toBe(200);
    expect(kill.json().data.deactivated).toBe(true);
    expect((await scan(next.shortCode)).headers['location']).toBe(`${WEB}/qr/retired?store=${vendor.slug}`);

    // Idempotent: a second kill is a calm no-op.
    const again = await app.inject({
      method: 'POST', url: '/api/v1/vendor/qr/deactivate',
      headers: { authorization: `Bearer ${owner.token}` }, payload: { confirm: true },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().data.deactivated).toBe(false);

    // Life after the kill switch: the next dashboard read mints a fresh code
    // and the version SEQUENCE continues (…v2 dead → v3), never regresses.
    const reborn = (await vendorGet(owner.token)).json().data;
    expect(reborn.version).toBe(3);
    expect(reborn.shortCode).not.toBe(next.shortCode);
    expect((await scan(reborn.shortCode)).headers['location']).toBe(`${WEB}/store/${vendor.slug}?src=qr&c=${reborn.shortCode}`);
  });
});

describe('scan events — the analytics spine, PII-free', () => {
  it('logs decisions with hashed ip/ua and coarse fields; NOT_FOUND rows carry no qrCodeId', async () => {
    const owner = await makeOwner();
    await makeVendor(owner.userId);
    const code = (await vendorGet(owner.token)).json().data.shortCode as string;
    const ip = '198.51.100.77';
    const ua = 'Mozilla/5.0 (Linux; Android 14; SM-A155F) Mobile Safari';

    await scan(code, { ip, ua, query: '?t=flyer' });
    await scan('BCDFGHJKMN', { ip, ua });
    await flushScanLog();

    const qr = await app.prisma.qrCode.findUniqueOrThrow({ where: { shortCode: code } });
    const hit = await app.prisma.scanEvent.findFirstOrThrow({ where: { qrCodeId: qr.id } });
    expect(hit.decision).toBe('WEB_RENDER');
    expect(hit.template).toBe('flyer');
    expect(hit.src).toBe('qr');
    expect(hit.osFamily).toBe('android');
    expect(hit.deviceClass).toBe('phone');
    expect(hit.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hit.ipHash?.includes(ip)).toBe(false);
    expect(hit.uaHash).not.toBe(ua);
    expect(hit.tenantId).toBe('swift-default');

    const miss = await app.prisma.scanEvent.findFirst({
      where: { qrCodeId: null, decision: 'NOT_FOUND' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(miss).not.toBeNull();
  });
});

describe('resolver rate limit (spec RATE_RESOLVER_PER_IP)', () => {
  it('one IP gets 30/min on /s/:code, then 429', async () => {
    const ip = '192.0.2.222';
    let lastOk = 0;
    let limited = false;
    for (let i = 0; i < 31; i += 1) {
      const res = await scan('BCDFGHJKMN', { ip });
      if (res.statusCode === 302) lastOk += 1;
      if (res.statusCode === 429) { limited = true; break; }
    }
    expect(lastOk).toBe(30);
    expect(limited).toBe(true);
  });
});

describe('one-ACTIVE concurrency guard', () => {
  it('parallel get-or-create yields exactly one ACTIVE row and one code', async () => {
    const owner = await makeOwner();
    const vendor = await makeVendor(owner.userId);

    const results = await Promise.all(
      Array.from({ length: 6 }, () => qrService.getOrCreateForVendor(vendor.id, owner.userId)),
    );
    const codes = new Set(results.map((r) => r.shortCode));
    expect(codes.size).toBe(1);
    const active = await app.prisma.qrCode.count({ where: { entityId: vendor.id, status: 'ACTIVE' } });
    expect(active).toBe(1);
  });

  it('parallel regenerate settles to exactly one ACTIVE row', async () => {
    const owner = await makeOwner();
    const vendor = await makeVendor(owner.userId);
    await qrService.getOrCreateForVendor(vendor.id, owner.userId);

    await Promise.all([
      qrService.regenerateForVendor(vendor.id, owner.userId),
      qrService.regenerateForVendor(vendor.id, owner.userId),
    ]);
    const active = await app.prisma.qrCode.count({ where: { entityId: vendor.id, status: 'ACTIVE' } });
    expect(active).toBe(1);
  });
});
