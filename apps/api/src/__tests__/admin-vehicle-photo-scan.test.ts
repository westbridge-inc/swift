/**
 * [Row 312 · COORD ruling 23 Oct 01:03Z, REVIEW-G S4 + SCANNER flag] VEHICLE PHOTOS STORED UNDER THE
 * BYPASS DO NOT REACH ADMINS BEFORE A CLEAN RESCAN.
 *
 * Under MALWARE_SCAN_BYPASS=1 a mover's vehicle photo is stored without a scan and owed a rescan (the
 * debt row names its key). Ruling (a) for documents applies here too: every admin response withholds a
 * vehiclePhotoUrl whose scan is still owed (AWAITING) or that failed it (FAILED: never shown), and says
 * which in vehiclePhotoScan beside it. A photo with no debt, or one closed CLEAN, is shown as before.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
let app: FastifyInstance;
const users: string[] = [];
const keys: string[] = [];
let seq = 0;
let adminToken = '';
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'admin-vehicle-photo-scan-test');

async function session(userId: string, role: string) {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: {
    userId, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `vps-${RUN}-${userId}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
  } }));
  return token;
}

/** A driver whose vehicle photo has the given scan debt (none = scanned at upload). */
async function driverWithPhoto(debt: { result: string | null } | null): Promise<{ driverId: string; photo: string }> {
  seq += 1;
  const photo = `/uploads/vehicles/vps-${RUN}-${seq}/car.jpg`;
  keys.push(photo);
  const user = await system(() => app.prisma.user.create({ data: {
    phone: `+59277${NUM}${String(seq).padStart(2, '0')}`, firstName: `Vps${RUN}`, lastName: `D${seq}`,
    roles: ['DRIVER', 'CUSTOMER'] as never[], activeRole: 'DRIVER' as never, status: 'ACTIVE', isPhoneVerified: true,
    driver: { create: {
      vehicleMake: 'Toyota', vehicleModel: 'Fixture', vehicleYear: 2020, vehicleColor: 'White', licensePlate: `VPS-${RUN}-${seq}`,
      driverLicenseUrl: 'synthetic', vehicleInsuranceUrl: 'synthetic', vehiclePhotoUrl: photo, bodyType: 'UNKNOWN',
    } },
  }, include: { driver: true } }));
  users.push(user.id);
  if (debt) {
    await system(() => app.prisma.uploadScanDebt.create({ data: {
      surface: 'vehicle-photo', reason: 'bypass', fileKey: photo, sha256: `vps-${RUN}-${seq}`,
      ...(debt.result ? { result: debt.result, rescannedAt: new Date(), quarantinedAt: new Date() } : {}),
    } }));
  }
  return { driverId: user.driver!.id, photo };
}

const get = (url: string) => app.inject({ method: 'GET', url: `/api/v1/admin${url}`, headers: { authorization: `Bearer ${adminToken}` } });

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const admin = await system(() => app.prisma.user.create({ data: {
    phone: `+59277${NUM}99`, firstName: `Vps${RUN}`, lastName: 'Admin', roles: ['ADMIN', 'CUSTOMER'] as never[], activeRole: 'ADMIN' as never,
    status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } },
  } }));
  users.push(admin.id);
  adminToken = await session(admin.id, 'ADMIN');
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.uploadScanDebt.deleteMany({ where: { fileKey: { in: keys } } }).catch(() => {});
    await app.prisma.driver.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  });
  await app.close();
});

describe('[Row 312 · ruling (a) for vehicle photos] admins never get a vehicle photo before a clean scan', () => {
  it('owed a rescan: withheld (AWAITING); failed: withheld (FAILED); scanned or closed CLEAN: shown as before', async () => {
    const awaiting = await driverWithPhoto({ result: null });
    const failed = await driverWithPhoto({ result: 'FOUND' });
    const clean = await driverWithPhoto({ result: 'CLEAN' });
    const scanned = await driverWithPhoto(null);

    for (const [d, scan] of [[awaiting, 'AWAITING'], [failed, 'FAILED']] as const) {
      const detail = await get(`/drivers/${d.driverId}`);
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().data.vehiclePhotoUrl).toBeNull();
      expect(detail.json().data.vehiclePhotoScan).toBe(scan);
      expect(detail.body).not.toContain(d.photo);
    }
    for (const d of [clean, scanned]) {
      const detail = await get(`/drivers/${d.driverId}`);
      expect(detail.json().data.vehiclePhotoUrl).toBe(d.photo);
      expect(detail.json().data.vehiclePhotoScan).toBeUndefined();
    }

    // The list the reviewer classifies vehicles from: the same, row by row.
    const queue = await get('/rides/vehicle-identity-queue');
    expect(queue.statusCode, queue.body).toBe(200);
    const byId = new Map((queue.json().data as Array<{ id: string; vehiclePhotoUrl: string | null; vehiclePhotoScan?: string }>).map((r) => [r.id, r]));
    expect(byId.get(awaiting.driverId)).toMatchObject({ vehiclePhotoUrl: null, vehiclePhotoScan: 'AWAITING' });
    expect(byId.get(failed.driverId)).toMatchObject({ vehiclePhotoUrl: null, vehiclePhotoScan: 'FAILED' });
    expect(byId.get(scanned.driverId)?.vehiclePhotoUrl).toBe(scanned.photo);
    expect(queue.body).not.toContain(awaiting.photo);
    expect(queue.body).not.toContain(failed.photo);
  });
});
