import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { PrismaClient } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { DEFAULT_DOCUMENT_CHECKLISTS } from '../modules/ops/platform-config';

// The trial preview, passed through unchanged, so the test can see which trial role each status asked about.
const trialRoles = vi.hoisted(() => [] as string[]);
vi.mock('../modules/integrity/enforcement', async (importOriginal) => {
  const real = await importOriginal<typeof import('../modules/integrity/enforcement')>();
  return {
    ...real,
    previewTrial: (...args: Parameters<typeof real.previewTrial>) => {
      trialRoles.push(args[2]);
      return real.previewTrial(...args);
    },
  };
});

// ---------------------------------------------------------------------------
// [PERF C2] A mover's app opens on a spinner until GET /verification/status
// answers (MoverRoot gates Home on it). getStatus used to make its database
// reads one after another: the account, the saved vehicle (three times), the
// checklist and the optional list (the market row, twice), the documents, the
// driver row, the trial preview and the police clearance, about ten database
// round trips in a row. Staging answered in p50 137 ms / p95 324 ms; locally
// each read is about 1 ms. The reads that do not depend on each other now run
// together. Same reads, same answer, fewer round trips in a row.
//
// Every database operation here waits for a WAVE: a read is held until every
// read of the previous wave has finished, then everything waiting goes at once.
// A read that needs another read's answer can only be asked after it, so it
// lands in a later wave; reads asked together share one. The number of waves is
// the longest chain of round trips in a row, however busy the machine is. The
// answer must equal the unheld service's.
//
// Fixture range: +5920489nnn (this file only).
// ---------------------------------------------------------------------------

const PREFIX = '+5920489';
const EXPECTED: Record<string, { vehicleType: string | null; trialRole: string; listsOf: string }> = {
  'rider/-': { vehicleType: 'MOTORCYCLE', trialRole: 'RIDER', listsOf: 'rider' },
  'driver/-': { vehicleType: 'CAR', trialRole: 'DRIVER', listsOf: 'driver' },
  'rider/CAR': { vehicleType: 'MOTORCYCLE', trialRole: 'RIDER', listsOf: 'driver' },
  'applicant/-': { vehicleType: null, trialRole: 'RIDER', listsOf: 'rider' },
};

let app: FastifyInstance;
let plain: VerificationService;
let timed: VerificationService;
let log: Array<{ wave: number; op: string }> = [];
const users: Record<string, string> = {};

// The wave gate: `queued` reads wait; when nothing is in flight, they all go as the next wave.
let waves = 0;
let inFlight = 0;
let queued: Array<() => void> = [];
let armed = false;
function releaseWhenIdle() {
  if (armed) return;
  armed = true;
  setTimeout(() => {
    armed = false;
    if (inFlight > 0 || queued.length === 0) return; // the wave's last read to finish calls again
    const wave = queued;
    queued = [];
    waves += 1;
    for (const go of wave) go();
  }, 2);
}

async function purge() {
  await runWithoutTenant(async () => {
    const ids = (await app.prisma.user.findMany({ where: { phone: { startsWith: PREFIX } }, select: { id: true } })).map((u) => u.id);
    if (ids.length === 0) return;
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }, 'test-fixture:verification-status-round-trips');
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  await app.prisma.countryConfig.upsert({ where: { code: 'GY' }, update: {}, create: {
    code: 'GY', name: 'Guyana', currencyCode: 'GYD', currencySymbol: '$', usdExchangeRate: 208.5, isActive: true,
    subscriptionTiers: { mover: 6000, smallVendor: 6000, largeVendor: 12000 },
    documentChecklists: DEFAULT_DOCUMENT_CHECKLISTS,
  } });
  await purge();

  const slow = app.prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          await new Promise<void>((go) => {
            queued.push(() => { inFlight += 1; log.push({ wave: waves, op: `${model}.${operation}` }); go(); });
            releaseWhenIdle();
          });
          try {
            return await query(args);
          } finally {
            inFlight -= 1;
            if (inFlight === 0) releaseWhenIdle();
          }
        },
      },
    },
  }) as unknown as PrismaClient;
  plain = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
  timed = new VerificationService(slow, new NotificationService(slow, app.io), new SandboxKycProvider());

  let seq = 0;
  const person = async (key: string, roles: Array<'RIDER' | 'DRIVER' | 'CUSTOMER'>, activeRole: 'RIDER' | 'DRIVER' | 'CUSTOMER') => {
    seq += 1;
    const user = await app.prisma.user.create({ data: {
      phone: `${PREFIX}${String(seq).padStart(3, '0')}`, firstName: 'Status', lastName: key, roles, activeRole,
      isPhoneVerified: true, countryCode: 'GY',
    } });
    users[key] = user.id;
    return user.id;
  };
  const rider = await person('rider', ['RIDER'], 'RIDER');
  await app.prisma.rider.create({ data: { userId: rider, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
  const driver = await person('driver', ['DRIVER'], 'DRIVER');
  await app.prisma.driver.create({ data: {
    userId: driver, vehicleType: 'CAR', vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2015, vehicleColor: 'White',
    licensePlate: `RT${nanoid(5)}`, driverLicenseUrl: 'status/dl', vehicleInsuranceUrl: 'status/ins',
  } });
  await person('applicant', ['CUSTOMER'], 'CUSTOMER');
  for (const [userId, role] of [[rider, 'RIDER'], [driver, 'DRIVER']] as const) {
    for (const [i, docType] of ['national_id', 'drivers_license', 'selfie', 'vehicle_registration', 'insurance'].entries()) {
      await app.prisma.verificationDocument.create({ data: {
        userId, role, docType, fileUrl: `status/${docType}`, status: i === 2 ? 'PENDING' : 'APPROVED',
      } });
    }
  }
});

afterAll(async () => {
  await purge();
  await app.close();
});

describe('[PERF C2] a mover\'s verification status reads together what does not depend on each other', () => {
  for (const [who, hint] of [['rider', undefined], ['driver', undefined], ['rider', 'CAR'], ['applicant', undefined]] as const) {
    it(`${who}${hint ? ` previewing a ${hint}` : ''}: at most 4 database round trips in a row, and the same answer`, async () => {
      const userId = users[who]!;
      const expected = await plain.getStatus(userId, 'MOVER', hint);
      log = [];
      waves = 0;
      const answer = await timed.getStatus(userId, 'MOVER', hint);
      const depth = waves;
      expect(answer).toEqual(expected);
      // The answer itself: the saved vehicle (a preview never changes it), the lists for the
      // previewed or saved vehicle (a motorcycle when none is saved), and the trial of the
      // side the person holds (a driver's own trial; everyone else a rider's).
      const want = EXPECTED[`${who}/${hint ?? '-'}`]!;
      expect(answer.vehicleType).toBe(want.vehicleType);
      expect(trialRoles.slice(-1)).toEqual([want.trialRole]);
      expect(answer.checklist).toEqual((await plain.getStatus(users[want.listsOf]!, 'MOVER')).checklist);
      expect(depth, `${depth} waves: ${log.map((o) => `${o.wave}:${o.op}`).join(', ')}`).toBeLessThanOrEqual(4);
    });
  }

  it('the fixtures tell a motorcycle\'s lists from a car\'s (so the list checks above mean something)', async () => {
    const [rider, driver] = [await plain.getStatus(users['rider']!, 'MOVER'), await plain.getStatus(users['driver']!, 'MOVER')];
    expect(rider.checklist).not.toEqual(driver.checklist);
  });

  it('an unknown account is still refused first, before any other read is made', async () => {
    log = [];
    await expect(timed.getStatus(`missing-${nanoid(6)}`, 'MOVER')).rejects.toThrow(/not found/);
    expect(log.map((o) => o.op)).toEqual(['User.findUnique']);
  });
});
