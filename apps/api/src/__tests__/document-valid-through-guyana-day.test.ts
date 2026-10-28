import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { runWithoutTenant } from '../plugins/tenant-context';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getKycProvider } from '../providers/kyc/kyc-provider';
import { recordEvidenceFor } from '../modules/verification/evidence';
import { holdsValidDocument } from '../modules/verification/category-gate';
import { validRegistrationRecord } from '../modules/vendor/vendor-tier';
import { dueRenewalNotices } from '../modules/verification/renewal-schedule';
import { guyanaDayKey } from '../utils/guyana-day';
import { evaluateMoverDocuments } from '../modules/verification/mover-document-authority';
import { CountryConfigService } from '../modules/country/country-config.service';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [FOLLOWUPS · COORD ruling 28 Oct 2026, owner delegated; safety/fairness] A document is valid THROUGH THE END of
// its expiry calendar day in Guyana time, not at the stored UTC-midnight instant (8 pm the evening before in
// Guyana). Pinned on the real checks over a real database:
//   - the evidence rule (what lets a rider or driver go online and a store go live: evidence.ts);
//   - the authority bound a store's activation and a mover's dispatch eligibility carry (evidenceValidUntilForList);
//   - the store category gate (holdsValidDocument) and "registered" (validRegistrationRecord);
//   - the daily expiry sweep (expireLapsedDocuments) that marks documents EXPIRED and pulls movers offline;
//   - the renewal reminders: "expires tomorrow" goes out on the Guyana day BEFORE the expiry day.
// ---------------------------------------------------------------------------

const RUN = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
const DAY = 86_400_000;
let app: FastifyInstance;
let svc: VerificationService;
const userIds: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'document-valid-through-test');
const gy = (local: string) => new Date(`${local}-04:00`);

/** "28 Oct 2031" as the console stores a keyed expiry (far enough ahead that every real-time check sees it valid). */
const KEYED = new Date('2031-10-28T00:00:00.000Z');
const AT = { eveningBefore: gy('2031-10-27T22:00:00'), lastHalfHour: gy('2031-10-28T23:30:00'), nextDay: gy('2031-10-29T00:01:00') };

async function person(role: 'MOVER' | 'VENDOR_OWNER') {
  const user = await system(() => app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Valid', lastName: `Through${RUN}`, roles: [role, 'CUSTOMER'] as never, activeRole: role as never,
    status: 'ACTIVE', isPhoneVerified: true, countryCode: 'GY',
  } }));
  userIds.push(user.id);
  return user.id;
}
async function approved(userId: string, role: 'MOVER' | 'VENDOR_OWNER', docType: string, expiresAt: Date) {
  return system(() => app.prisma.verificationDocument.create({ data: {
    userId, role, docType, fileUrl: `storage://synthetic/valid-through/${RUN}/${nanoid(5)}`, status: 'APPROVED', state: 'COMMITTED', expiresAt,
  } as never }));
}
const statusOf = async (id: string) => (await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id } }))).status;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
  svc = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), getKycProvider());
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  await app.close();
});

describe('[FOLLOWUPS] a document counts through the end of its expiry day in Guyana', () => {
  it('the evidence rule (go online, go live): valid at 22:00 the evening before and at 23:30 on the day, gone at 00:01 the next day', async () => {
    const mover = await person('MOVER');
    await approved(mover, 'MOVER', 'drivers_licence', KEYED);
    const counted = async (now: Date) => (await system(() => recordEvidenceFor(app.prisma, mover, ['drivers_licence'], now))).length;
    expect(await counted(AT.eveningBefore)).toBe(1);
    expect(await counted(AT.lastHalfHour)).toBe(1);
    expect(await counted(AT.nextDay)).toBe(0);
  });

  it('the authority bound a store\'s activation and a mover\'s dispatch carry is the end of that Guyana day', async () => {
    const owner = await person('VENDOR_OWNER');
    await approved(owner, 'VENDOR_OWNER', 'business_registration', KEYED);
    const bound = await system(() => svc.evidenceValidUntilForList(owner, ['business_registration']));
    expect(bound?.toISOString()).toBe('2031-10-29T04:00:00.000Z');
  });

  it('a rider\'s dispatch eligibility (the documents verdict\'s validUntil) runs to the end of that Guyana day', async () => {
    const mover = await person('MOVER');
    await system(() => app.prisma.rider.create({ data: { userId: mover, riderType: 'DELIVERY', vehicleType: 'BICYCLE' } as never }));
    const required = await system(() => new CountryConfigService(app.prisma as never).getMoverChecklist('GY', 'BICYCLE' as never));
    expect(required.length).toBeGreaterThan(0);
    for (const docType of required) await approved(mover, 'MOVER', docType, KEYED);
    const verdict = await system(() => evaluateMoverDocuments(app.prisma as never, mover, { kind: 'RIDER', vehicleType: 'BICYCLE' as never }));
    expect(verdict.allowed).toBe(true);
    expect(verdict.validUntil?.toISOString()).toBe('2031-10-29T04:00:00.000Z');
    await system(() => app.prisma.rider.deleteMany({ where: { userId: mover } }));
  });

  it('the store category gate and "registered" read the same rule', async () => {
    const owner = await person('VENDOR_OWNER');
    await approved(owner, 'VENDOR_OWNER', 'business_registration', KEYED);
    await approved(owner, 'VENDOR_OWNER', 'food_handlers_permit', KEYED);
    for (const [now, expected] of [[AT.eveningBefore, true], [AT.lastHalfHour, true], [AT.nextDay, false]] as const) {
      expect(await system(() => holdsValidDocument(app.prisma, owner, 'food_handlers_permit', now)), now.toISOString()).toBe(expected);
      expect(!!(await system(() => validRegistrationRecord(app.prisma, owner, now))), now.toISOString()).toBe(expected);
    }
  });

  it('the daily sweep leaves a document keyed for TODAY (Guyana) valid, at any hour, and expires yesterday\'s', async () => {
    const mover = await person('MOVER');
    const todayYmd = guyanaDayKey(new Date());
    const today = new Date(`${todayYmd}T00:00:00.000Z`);
    const yesterday = new Date(today.getTime() - DAY);
    const keptToday = await approved(mover, 'MOVER', 'drivers_licence', today);
    const lapsed = await approved(mover, 'MOVER', 'vehicle_insurance', yesterday);
    await system(() => svc.expireLapsedDocuments());
    expect(await statusOf(keptToday.id), `keyed ${todayYmd}: still valid today in Guyana`).toBe('APPROVED');
    expect(await statusOf(lapsed.id), 'keyed yesterday: expired').toBe('EXPIRED');
  });

  it('"expires tomorrow" goes out on the Guyana day before the expiry day, never at 8 pm two days before', async () => {
    const owner = await person('VENDOR_OWNER');
    const doc = await approved(owner, 'VENDOR_OWNER', 'food_handlers_permit', KEYED);
    const dueFor = async (now: Date) => (await system(() => dueRenewalNotices(app.prisma, now))).find((n) => n.documentId === doc.id);
    // 26 Oct, 21:00 in Guyana (= 27 Oct 01:00Z): the database's T-1 (27 Oct 00:00Z) has passed, but in Guyana it is
    // still the 26th, two days before the expiry day: the latest notice due is T-7, not "tomorrow".
    expect((await dueFor(gy('2031-10-26T21:00:00')))?.daysLeft).toBe(7);
    // 27 Oct, 00:30 in Guyana: the day before. Now it is "tomorrow".
    const tomorrow = await dueFor(gy('2031-10-27T00:30:00'));
    expect(tomorrow?.daysLeft).toBe(1);
    // ... and on the expiry day itself the schedule is still live (the document still counts until midnight).
    expect(await dueFor(gy('2031-10-28T23:30:00'))).toBeTruthy();
    // A T-1 already recorded as sent (at the schedule's own time) is never sent again.
    await system(() => app.prisma.renewalSchedule.update({ where: { documentId: doc.id }, data: { lastNotified: tomorrow!.noticeAt } }));
    expect(await dueFor(gy('2031-10-27T12:00:00'))).toBeUndefined();
  });
});
