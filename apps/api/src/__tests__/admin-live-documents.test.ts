import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { runWithoutTenant } from '../plugins/tenant-context';
import { withLiveDocuments } from '../modules/admin/live-documents';
import { evaluateMoverDocuments } from '../modules/verification/mover-document-authority';

// [Owner report 8 Oct 2026] The admin lists show the live per-document verdict GO uses, not the legacy flag alone.
let app: FastifyInstance;
const users: string[] = [];
const phoneBase = 592_079_000_000 + Math.floor(Math.random() * 900_000);
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'admin-live-documents-test');

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin); await app.register(redisPlugin);
  await app.ready();
});
afterAll(async () => {
  if (!app) return;
  await system(() => app.prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {}));
  await app.close();
});

describe('admin mover lists: the live document verdict', () => {
  it('a driver with no documents reads "documents missing" even with the legacy flag false or true, exactly as GO decides', async () => {
    for (const documentsVerified of [false, true]) {
      const row = await system(async () => {
        const user = await app.prisma.user.create({ data: { phone: `+${phoneBase + users.length}`, firstName: 'Synthetic', lastName: 'Driver', roles: ['MOVER', 'DRIVER'], activeRole: 'DRIVER', countryCode: 'GY', isPhoneVerified: true } });
        users.push(user.id);
        return app.prisma.driver.create({ data: { userId: user.id, vehicleType: 'CAR', vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2018, vehicleColor: 'Silver', licensePlate: `HC ${users.length}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x', documentsVerified } });
      });
      const [listed] = await system(() => withLiveDocuments(app.prisma, [row], 'DRIVER'));
      const gate = await system(() => evaluateMoverDocuments(app.prisma, row.userId, { kind: 'DRIVER', vehicleType: 'CAR', legacyVerified: documentsVerified }));
      expect(listed!.documentsLive).toEqual({ allowed: gate.allowed, reason: gate.reason, validUntil: gate.validUntil });
      expect(listed!.documentsLive!.allowed).toBe(false);
    }
  });
});
