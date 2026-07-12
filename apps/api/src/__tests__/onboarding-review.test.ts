import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { VerificationService } from '../modules/verification/verification.service';
import { PartnerService } from '../modules/partner/partner.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getKycProvider } from '../providers/kyc/kyc-provider';

// ---------------------------------------------------------------------------
// The onboarding review LOOP (found live 2026-07-12): documents and new
// businesses landed in PENDING queues that no admin was ever told about — a
// pending owner_national_id sat unreviewed for 19 days, and freshly signed-up
// stores sat PENDING_APPROVAL indefinitely. "We review within 24 hours" needs
// a trigger: every queue insert now notifies the admin accounts.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
let seq = 0;
const phoneBase = 592_400_000_000 + Math.floor(Math.random() * 500_000_000);

async function makeUser(roles: UserRole[], extra: Record<string, unknown> = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Review',
      lastName: `Loop${seq}`,
      roles,
      activeRole: roles[0]!,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      avatar: 'https://example.com/selfie.jpg',
      ...extra,
    },
  });
  createdUserIds.push(user.id);
  return user;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();
});

afterAll(async () => {
  await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('onboarding review loop', () => {
  it('a PENDING document submission notifies admin accounts', async () => {
    const admin = await makeUser(['ADMIN']);
    const applicant = await makeUser(['CUSTOMER', 'MOVER']);
    const verification = new VerificationService(
      app.prisma,
      new NotificationService(app.prisma, app.io),
      getKycProvider(),
    );

    const doc = await verification.submitDocument(
      applicant.id, 'MOVER', 'police_clearance', 'storage://test/pc.jpg', 'v1',
    );
    expect(doc.status).toBe('PENDING');

    const note = await app.prisma.notification.findFirst({
      where: { userId: admin.id, title: 'Verification review needed' },
    });
    expect(note).not.toBeNull();
    expect((note!.data as { docId?: string })?.docId).toBe(doc.id);
  });

  it('a new business signup notifies admin accounts', async () => {
    const admin = await makeUser(['SUPER_ADMIN']);
    const founder = await makeUser(['CUSTOMER']);
    const partners = new PartnerService(app.prisma, new NotificationService(app.prisma, app.io));

    const result = await partners.becomePartner(founder.id, {
      role: 'VENDOR',
      business: {
        name: `Review Loop Deli ${nanoid(4)}`,
        vendorType: 'RESTAURANT',
        phone: '+5926667777',
        addressLine1: '9 Queue Street',
        city: 'Georgetown',
        latitude: 6.8,
        longitude: -58.15,
      },
    });
    expect(result.kind).toBe('VENDOR');
    expect(result.created).toBe(true);

    const note = await app.prisma.notification.findFirst({
      where: { userId: admin.id, title: 'New business awaiting approval' },
    });
    expect(note).not.toBeNull();
    expect((note!.data as { vendorId?: string })?.vendorId).toBe(result.id);

    // cleanup the vendor + owner so reruns stay clean
    await app.prisma.vendor.deleteMany({ where: { id: result.id } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: founder.id } });
  });
});
