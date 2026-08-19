import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { isProviderVerified, providerChecklist, refreshProviderVerification } from '../modules/services/services.service';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getKycProvider } from '../providers/kyc/kyc-provider';

// ---------------------------------------------------------------------------
// Onboarding-spec gaps (task #15, PR B): the electrician GEI licence is a
// LEGAL GATE not a badge; rejections carry templated reason codes; and the
// review queue has an SLA watchdog.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let svc: VerificationService;
const marker = nanoid(6).toLowerCase();
const userIds: string[] = [];
let seq = 0;

async function makeProvider(trade: string, docs: string[]) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59266${marker.charCodeAt(0) % 9}${String(seq).padStart(4, '0')}`,
      firstName: 'Pro', lastName: `T${seq}`,
      roles: ['MOVER'] as never[], activeRole: 'MOVER' as never,
      isPhoneVerified: true, countryCode: 'GY',
    },
  });
  userIds.push(user.id);
  await app.prisma.serviceProvider.create({ data: { userId: user.id, trade, isVerified: false } });
  for (const docType of docs) {
    await app.prisma.verificationDocument.create({
      data: {
        userId: user.id, role: 'MOVER', docType, fileUrl: `test/${marker}/${docType}`,
        status: 'APPROVED', expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
      },
    });
  }
  return user;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();

  // The test DB may predate the seed's electrician entry — pin it here.
  const config = await app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' } });
  const lists = config.documentChecklists as Record<string, string[]>;
  if (!lists['SERVICE_PROVIDER_TRADE_ELECTRICIAN']) {
    await app.prisma.countryConfig.update({
      where: { code: 'GY' },
      data: {
        documentChecklists: {
          ...lists,
          SERVICE_PROVIDER_TRADE_ELECTRICIAN: ['gei_electrical_licence'],
          SERVICE_PROVIDER_TRADE_ELECTRICAL: ['gei_electrical_licence'],
        },
      },
    });
  }

  svc = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), getKycProvider());
});

afterAll(async () => {
  if (userIds.length > 0) {
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.serviceProvider.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

describe('electrician GEI gate (spec §3.5 — the one licensed trade)', () => {
  it('a plumber with ID + clearance is verified (ID-only trades)', async () => {
    const plumber = await makeProvider('plumber', ['national_id', 'police_clearance']);
    expect(await providerChecklist(app.prisma, plumber.id)).toEqual(['national_id', 'police_clearance']);
    expect(await isProviderVerified(app.prisma, plumber.id)).toBe(true);
  });

  it('an electrician with ID + clearance but NO GEI licence is NOT verified', async () => {
    const sparky = await makeProvider('electrician', ['national_id', 'police_clearance']);
    expect(await providerChecklist(app.prisma, sparky.id)).toContain('gei_electrical_licence');
    expect(await isProviderVerified(app.prisma, sparky.id)).toBe(false);
  });

  it('approving the GEI licence flips the electrician live via afterApproval', async () => {
    const sparky = await makeProvider('electrician', ['national_id', 'police_clearance']);
    // Submit the licence as PENDING, then approve through the real reviewer path.
    const doc = await app.prisma.verificationDocument.create({
      data: {
        userId: sparky.id, role: 'MOVER', docType: 'gei_electrical_licence',
        fileUrl: `test/${marker}/gei`, status: 'PENDING',
      },
    });
    await svc.approveDocument(doc.id, 'admin-test', new Date(Date.now() + 365 * 24 * 3600 * 1000));

    const provider = await app.prisma.serviceProvider.findUniqueOrThrow({ where: { userId: sparky.id } });
    expect(provider.isVerified).toBe(true);
  });

  it('an expired GEI licence pulls the electrician off the marketplace on the sweep', async () => {
    const sparky = await makeProvider('electrician', ['national_id', 'police_clearance']);
    await app.prisma.verificationDocument.create({
      data: {
        userId: sparky.id, role: 'MOVER', docType: 'gei_electrical_licence',
        fileUrl: `test/${marker}/gei2`, status: 'APPROVED',
        expiresAt: new Date(Date.now() - 60_000), // lapsed a minute ago
      },
    });
    await refreshProviderVerification(app.prisma, sparky.id); // was live before lapse detection
    await svc.expireLapsedDocuments();

    const provider = await app.prisma.serviceProvider.findUniqueOrThrow({ where: { userId: sparky.id } });
    expect(provider.isVerified).toBe(false);
  });

  it('projects approval before fallible side effects and repairs a terminal-review replay', async () => {
    const sparky = await makeProvider('electrician', ['national_id', 'police_clearance']);
    const doc = await app.prisma.verificationDocument.create({
      data: {
        userId: sparky.id, role: 'MOVER', docType: 'gei_electrical_licence',
        fileUrl: `test/${marker}/gei-replay`, status: 'PENDING',
      },
    });
    const notifications = new NotificationService(app.prisma, app.io);
    vi.spyOn(notifications, 'send').mockRejectedValueOnce(new Error('injected post-projection notification failure'));
    const failing = new VerificationService(app.prisma, notifications, getKycProvider());

    await expect(failing.approveDocument(doc.id, 'admin-test'))
      .rejects.toThrow('injected post-projection notification failure');
    expect((await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } })).status)
      .toBe('APPROVED');
    expect((await app.prisma.serviceProvider.findUniqueOrThrow({ where: { userId: sparky.id } })).isVerified)
      .toBe(true);

    // Simulate the exact stale projection left by the pre-fix crash window.
    await app.prisma.serviceProvider.update({ where: { userId: sparky.id }, data: { isVerified: false } });
    await expect(failing.approveDocument(doc.id, 'admin-test'))
      .rejects.toMatchObject({ code: 'NOT_PENDING' });
    expect((await app.prisma.serviceProvider.findUniqueOrThrow({ where: { userId: sparky.id } })).isVerified)
      .toBe(true);
  });

  it('uses an ALREADY_APPROVED submission retry to repair provider projection drift', async () => {
    const mason = await makeProvider('mason', ['national_id', 'police_clearance']);
    expect((await app.prisma.serviceProvider.findUniqueOrThrow({ where: { userId: mason.id } })).isVerified)
      .toBe(false);

    await expect(svc.submitDocument(
      mason.id,
      'SERVICE_PROVIDER',
      'national_id',
      `test/${marker}/duplicate-national-id`,
      'v1',
    )).rejects.toMatchObject({ code: 'ALREADY_APPROVED' });

    expect((await app.prisma.serviceProvider.findUniqueOrThrow({ where: { userId: mason.id } })).isVerified)
      .toBe(true);
  });

  it('reconciles an already-expired provider after an interrupted expiry sweep', async () => {
    const sparky = await makeProvider('electrician', ['national_id', 'police_clearance']);
    const lapsed = await app.prisma.verificationDocument.create({
      data: {
        userId: sparky.id, role: 'MOVER', docType: 'gei_electrical_licence',
        fileUrl: `test/${marker}/gei-expiry-replay`, status: 'APPROVED',
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    await app.prisma.serviceProvider.update({ where: { userId: sparky.id }, data: { isVerified: true } });
    await app.prisma.rider.create({
      data: {
        userId: sparky.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE',
        isOnline: true, isAvailable: true,
      },
    });

    const notifications = new NotificationService(app.prisma, app.io);
    const send = vi.spyOn(notifications, 'send').mockImplementation(async (payload) => {
      if (payload.userId === sparky.id) throw new Error('injected mover suspension failure');
      return '';
    });
    const failing = new VerificationService(app.prisma, notifications, getKycProvider());
    await expect(failing.expireLapsedDocuments())
      .rejects.toThrow('injected mover suspension failure');
    expect((await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: lapsed.id } })).status)
      .toBe('EXPIRED');
    expect((await app.prisma.serviceProvider.findUniqueOrThrow({ where: { userId: sparky.id } })).isVerified)
      .toBe(false);

    // An interrupted old deployment could leave this terminal row stale. The
    // next sweep must repair it even though EXPIRED rows are no longer selected.
    await app.prisma.serviceProvider.update({ where: { userId: sparky.id }, data: { isVerified: true } });
    send.mockRestore();
    await failing.expireLapsedDocuments();
    expect((await app.prisma.serviceProvider.findUniqueOrThrow({ where: { userId: sparky.id } })).isVerified)
      .toBe(false);
  });
});

describe('rejection reason codes (spec §9.3)', () => {
  it('templates the message and prefixes the review note with the code', async () => {
    const pro = await makeProvider('mason', []);
    const doc = await app.prisma.verificationDocument.create({
      data: { userId: pro.id, role: 'MOVER', docType: 'national_id', fileUrl: `test/${marker}/id`, status: 'PENDING' },
    });
    const rejected = await svc.rejectDocument(doc.id, 'admin-test', 'Top corner cut off.', 'INCOMPLETE');
    expect(rejected.reviewNote).toContain('[INCOMPLETE]');
    expect(rejected.reviewNote).toContain('capture the whole page');
    expect(rejected.reviewNote).toContain('Top corner cut off.');

    const note = await app.prisma.notification.findFirst({ where: { userId: pro.id }, orderBy: { createdAt: 'desc' } });
    expect(note?.body).toContain('capture the whole page');
  });
});

describe('review-SLA watchdog (spec §13)', () => {
  it('alerts admins when documents wait past the SLA, silent when fresh', async () => {
    const pro = await makeProvider('welder', []);
    const stale = await app.prisma.verificationDocument.create({
      data: { userId: pro.id, role: 'MOVER', docType: 'national_id', fileUrl: `test/${marker}/sla`, status: 'PENDING' },
    });
    await app.prisma.$executeRaw`UPDATE verification_documents SET "createdAt" = NOW() - INTERVAL '30 hours' WHERE id = ${stale.id}`;

    const breached = await svc.alertReviewSlaBreaches(24);
    expect(breached).toBeGreaterThanOrEqual(1);

    // Resolving the stale doc removes it from the breach count. (Other suites
    // may leave their own stale rows in the shared DB — assert strictly fewer,
    // not zero.)
    await app.prisma.verificationDocument.update({ where: { id: stale.id }, data: { status: 'REJECTED' } });
    const clean = await svc.alertReviewSlaBreaches(24);
    expect(clean).toBeLessThan(breached);
  });
});
