import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { servicesRoutes } from '../modules/services/services.routes';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { providerChecklist } from '../modules/services/services.service';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getKycProvider } from '../providers/kyc/kyc-provider';
import { guyanaWallClockParts, startOfGuyanaDay } from '../utils/guyana-day';
import { registerErrorHandler } from '../middleware/error-handler';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { ownedVerificationFixture } from './helpers/verification-object';

// ---------------------------------------------------------------------------
// [TRADES · owner 13 Oct 2026, decisions 23 + 40; R15 · owner 15 Oct 2026,
// research A9/D9] The service trades opened at launch, through the real routes:
// a profile is accepted, the verification checklist names the trade's own
// documents, base identity + police clearance alone never lists the provider,
// the full set does, an expired licence takes them off again. The UNSURE trades
// (gas fitter, barber group, accountant) stay held with the lawyer, drone work is
// refused, and a licence or food certificate is approved by its YEAR and lasts
// to the January re-check.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+59201313';
let app: FastifyInstance;
const createdUserIds: string[] = [];
let seq = 0;

const BASE = ['national_id', 'police_clearance'];
const TRADE_DOCS: Record<string, string[]> = {
  pest_control: ['pest_control_operator_licence', 'pesticide_applicator_certificate'],
  heavy_equipment_operator: ['drivers_licence'],
  chef: ['food_handler_cert'],
  caterer: ['food_handler_cert', 'eating_house_registration'],
  photographer: [],
  tutor: [],
};
/** [R15] research A9: UNSURE — held, with the lawyer. */
const HELD = ['lawyer', 'gas_fitter', 'barber', 'hairdresser', 'salon', 'nail_technician', 'makeup_artist', 'accountant'];

async function makeUser() {
  seq += 1;
  return runWithoutTenant(async () => {
    const user = await app.prisma.user.create({
      data: {
        phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`,
        firstName: 'Trade', lastName: `User${seq}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', tenantId: 'swift-default',
        isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: 'storage://test/provider-selfie.jpg',
        customer: { create: {} },
      },
    });
    createdUserIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
    await app.prisma.session.create({
      data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'trades', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
    });
    return { userId: user.id, token };
  });
}

async function approve(userId: string, docTypes: string[], expiresAt: Date | null = new Date(Date.now() + 200 * DAY)) {
  for (const docType of docTypes) {
    await app.prisma.verificationDocument.create({
      data: { userId, role: 'CUSTOMER', docType, fileUrl: `storage://t/${docType}.jpg`, status: 'APPROVED', consentAt: new Date(), privacyNoticeVersion: 'v1', expiresAt },
    });
  }
}

function inject(method: 'GET' | 'POST', url: string, payload?: unknown, token?: string) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

const save = (token: string, trade: string, bio?: string) => inject('POST', '/api/v1/services/providers', { trade, ...(bio !== undefined && { bio }) }, token);
const status = async (token: string) => (await inject('GET', '/api/v1/verification/status?role=SERVICE_PROVIDER', undefined, token)).json().data;
const listedIds = async (trade: string) => (await inject('GET', `/api/v1/services/providers?trade=${trade}&limit=50`)).json().data.providers.map((p: { id: string }) => p.id);

async function purgeFixtures() {
  await runWithoutTenant(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const userIds = [...new Set([...createdUserIds, ...users.map((user) => user.id)])];
    createdUserIds.length = 0;
    if (userIds.length === 0) return;
    await app.prisma.serviceProvider.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:service-trades');
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
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
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(servicesRoutes, { prefix: '/api/v1/services' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();
  await purgeFixtures();
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('[TRADES] each opened trade goes live only with its own documents', () => {
  it.each(Object.keys(TRADE_DOCS))('%s: profile accepted, checklist named, base alone hidden, full set listed', async (trade) => {
    const u = await makeUser();
    const created = await save(u.token, trade, 'Ten years of experience');
    expect(created.statusCode, trade).toBe(200);
    const providerId = created.json().data.id;

    const checklist = [...BASE, ...TRADE_DOCS[trade]!];
    const first = await status(u.token);
    expect(first.categoryUnavailable, trade).toBe(false);
    expect(first.checklist, trade).toEqual(checklist);

    // Identity + police clearance only: never live for a licensed trade.
    await approve(u.userId, BASE);
    const afterBase = await save(u.token, trade, 'Ten years of experience');
    if (TRADE_DOCS[trade]!.length > 0) {
      expect(afterBase.json().data.isVerified, trade).toBe(false);
      expect(await listedIds(trade), trade).not.toContain(providerId);
      await approve(u.userId, TRADE_DOCS[trade]!);
    }
    const live = await save(u.token, trade, 'Ten years of experience');
    expect(live.json().data.isVerified, trade).toBe(true);
    expect(await listedIds(trade), trade).toContain(providerId);
  });

  it('an expired licence takes the provider off the marketplace', async () => {
    const u = await makeUser();
    const providerId = (await save(u.token, 'pest_control')).json().data.id;
    await approve(u.userId, [...BASE, 'pest_control_operator_licence']);
    await approve(u.userId, ['pesticide_applicator_certificate'], new Date(Date.now() - DAY));
    expect((await save(u.token, 'pest_control')).json().data.isVerified).toBe(false);
    expect(await listedIds('pest_control')).not.toContain(providerId);
    expect((await status(u.token)).missing).toEqual(['pesticide_applicator_certificate']);
  });

  it('a tutor without a police clearance is not listed', async () => {
    const u = await makeUser();
    const providerId = (await save(u.token, 'tutor')).json().data.id;
    await approve(u.userId, ['national_id']);
    expect((await save(u.token, 'tutor')).json().data.isVerified).toBe(false);
    expect(await listedIds('tutor')).not.toContain(providerId);
    expect((await status(u.token)).missing).toEqual(['police_clearance']);
    await approve(u.userId, ['police_clearance']);
    expect((await save(u.token, 'tutor')).json().data.isVerified).toBe(true);
  });

  it('a stored config edit cannot open a trade on identity alone', async () => {
    const gy = await runWithoutTenant(() => app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' } }));
    const stored = gy.documentChecklists as Record<string, string[]>;
    await runWithoutTenant(() => app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { documentChecklists: {
      ...stored, SERVICE_PROVIDER: ['national_id'], SERVICE_PROVIDER_TRADE_PEST_CONTROL: [],
    } } }));
    try {
      const u = await makeUser();
      const providerId = (await save(u.token, 'pest_control')).json().data.id;
      await approve(u.userId, ['national_id']);
      expect((await save(u.token, 'pest_control')).json().data.isVerified).toBe(false);
      expect(await listedIds('pest_control')).not.toContain(providerId);
      expect(await providerChecklist(app.prisma, u.userId)).toEqual([...BASE, ...TRADE_DOCS['pest_control']!]);
    } finally {
      await runWithoutTenant(() => app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { documentChecklists: stored } }));
    }
  });
});

describe('[TRADES · R15] the held categories stay held', () => {
  it.each(HELD)('refuses a %s profile and browse; nothing is saved', async (trade) => {
    const u = await makeUser();
    const res = await save(u.token, trade, 'Ten years of experience');
    expect(res.statusCode, trade).toBe(409);
    expect(res.json().error.code, trade).toBe('SERVICE_CATEGORY_UNAVAILABLE');
    expect(await runWithoutTenant(() => app.prisma.serviceProvider.count({ where: { userId: u.userId } }))).toBe(0);
    const browse = await inject('GET', `/api/v1/services/providers?trade=${trade}`);
    expect(browse.statusCode, trade).toBe(409);
  });

  it('refuses a lawyer browse by its aliases too', async () => {
    for (const trade of ['lawyer', 'attorney']) {
      const browse = await inject('GET', `/api/v1/services/providers?trade=${trade}`);
      expect(browse.statusCode, trade).toBe(409);
      expect(browse.json().error.code, trade).toBe('SERVICE_CATEGORY_UNAVAILABLE');
    }
  });

  it('a stored lawyer profile is unavailable with an empty checklist, whatever is approved', async () => {
    const u = await makeUser();
    await runWithoutTenant(() => app.prisma.serviceProvider.create({ data: { userId: u.userId, trade: 'lawyer', portfolioPhotos: [], isVerified: true } }));
    await approve(u.userId, BASE);
    const mine = await inject('GET', '/api/v1/services/providers/me', undefined, u.token);
    expect(mine.json().data).toMatchObject({ trade: 'lawyer', isVerified: false, categoryUnavailable: true });
    const s = await status(u.token);
    expect(s.checklist).toEqual([]);
    expect(s.categoryUnavailable).toBe(true);
  });
});

describe('[TRADES] documents are submittable where the trade names them', () => {
  const submit = async (u: { userId: string; token: string }, docType: string) => inject('POST', '/api/v1/verification/documents', {
    role: 'SERVICE_PROVIDER', docType, fileUrl: await ownedVerificationFixture(app.prisma, u.userId, docType), consent: true, privacyNoticeVersion: 'v1',
  }, u.token);

  it('a pest-control provider can submit the PTCCB licence; a plumber cannot', async () => {
    const pest = await makeUser();
    await save(pest.token, 'pest_control');
    const accepted = await submit(pest, 'pest_control_operator_licence');
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().data.status).toBe('PENDING');

    const plumber = await makeUser();
    await save(plumber.token, 'plumber');
    const refused = await submit(plumber, 'pest_control_operator_licence');
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('INVALID_DOC_TYPE');
  });

  it('a photographer has nothing extra to add and cannot submit a drone authorisation (drone work is held)', async () => {
    const photographer = await makeUser();
    await save(photographer.token, 'photographer', 'Portraits and weddings');
    const s = await status(photographer.token);
    expect(s.checklist).toEqual(BASE);
    expect(s.optional).toEqual([]);
    const refused = await submit(photographer, 'drone_authorisation');
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('INVALID_DOC_TYPE');
  });
});

describe('[R15] drone and aerial work is held', () => {
  it('a profile that offers it is refused and nothing is saved, whatever the trade', async () => {
    for (const trade of ['photographer', 'carpenter']) {
      const u = await makeUser();
      const refused = await save(u.token, trade, 'Weddings, events and drone video');
      expect(refused.statusCode, trade).toBe(400);
      expect(refused.json().error.code, trade).toBe('DRONE_WORK_HELD');
      expect(await runWithoutTenant(() => app.prisma.serviceProvider.count({ where: { userId: u.userId } }))).toBe(0);
    }
  });

  it('a stored profile that offers it (written before the check) is never verified or listed', async () => {
    const u = await makeUser();
    await approve(u.userId, BASE);
    const providerId = (await save(u.token, 'photographer', 'Weddings and events')).json().data.id;
    expect(await listedIds('photographer')).toContain(providerId);
    await runWithoutTenant(() => app.prisma.serviceProvider.update({ where: { id: providerId }, data: { bio: 'Weddings and aerial video' } }));
    expect(await providerChecklist(app.prisma, u.userId)).toEqual([]);
    const mine = await inject('GET', '/api/v1/services/providers/me', undefined, u.token);
    expect(mine.json().data.isVerified).toBe(false);
    expect(await listedIds('photographer')).not.toContain(providerId);
  });
});

describe('[R15] a licence or food certificate is approved by its year and lasts to the January re-check', () => {
  let svc: VerificationService;
  beforeAll(() => { svc = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), getKycProvider()); });
  const submit = async (u: { userId: string; token: string }, docType: string) => (await inject('POST', '/api/v1/verification/documents', {
    role: 'SERVICE_PROVIDER', docType, fileUrl: await ownedVerificationFixture(app.prisma, u.userId, docType), consent: true, privacyNoticeVersion: 'v1',
  }, u.token)).json().data.id as string;

  it('the reviewer types the year; only this year’s (or, until 16 January, last year’s) is approved; it lapses on 16 January', async () => {
    const chef = await makeUser();
    await save(chef.token, 'chef', 'Private dinners');
    await approve(chef.userId, BASE);
    const docId = await submit(chef, 'food_handler_cert');
    const year = guyanaWallClockParts(new Date()).year;
    const code = async (typed: Record<string, unknown>, expiresAt?: Date) => {
      try { await svc.approveDocument(docId, 'admin-test', expiresAt, undefined, { required: true, ...typed }); return 'APPROVED'; } catch (err) { return (err as { code?: string }).code; }
    };
    expect(await code({})).toBe('CERTIFICATE_YEAR_REQUIRED');
    expect(await code({ certificateYear: year + 1 })).toBe('CERTIFICATE_YEAR_IN_FUTURE');
    expect(await code({ certificateYear: year - 2 })).toBe('CERTIFICATE_YEAR_LAPSED');
    expect(await runWithoutTenant(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: docId } }))).toMatchObject({ status: 'PENDING' });
    // A keyed date never overrides the year: the approval lasts to the January re-check.
    expect(await code({ certificateYear: year }, new Date(Date.now() + 700 * DAY))).toBe('APPROVED');
    const recheck = startOfGuyanaDay(`${year + 1}-01-16`);
    const doc = await runWithoutTenant(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: docId }, include: { renewalSchedule: true } }));
    expect(doc.status).toBe('APPROVED');
    expect(doc.expiresAt).toEqual(recheck);
    expect(doc.renewalSchedule?.expiresOn).toEqual(recheck);
    expect((await save(chef.token, 'chef', 'Private dinners')).json().data.isVerified).toBe(true);
  });
});

describe('[R16] a business registration: a yearly business name is checked every January; a company’s never expires', () => {
  let svc: VerificationService;
  beforeAll(() => { svc = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), getKycProvider()); });
  const pendingRegistration = async () => {
    const owner = await makeUser();
    return runWithoutTenant(() => app.prisma.verificationDocument.create({ data: {
      userId: owner.userId, role: 'VENDOR_OWNER', docType: 'business_registration', fileUrl: `storage://t/registration-${nanoid(6)}.jpg`,
      status: 'PENDING', consentAt: new Date(), privacyNoticeVersion: 'v1',
    } }));
  };
  const code = async (docId: string, typed: Record<string, unknown>) => {
    try { await svc.approveDocument(docId, 'admin-test', undefined, undefined, { required: true, ...typed }); return 'APPROVED'; } catch (err) { return (err as { code?: string }).code; }
  };
  const year = () => guyanaWallClockParts(new Date()).year;

  it('the reviewer must say what it is; a business name needs its year and lasts to 16 January', async () => {
    const doc = await pendingRegistration();
    expect(await code(doc.id, {})).toBe('REGISTRATION_KIND_REQUIRED');
    expect(await code(doc.id, { registrationKind: 'BUSINESS_NAME' })).toBe('CERTIFICATE_YEAR_REQUIRED');
    expect(await code(doc.id, { registrationKind: 'BUSINESS_NAME', certificateYear: year() - 2 })).toBe('CERTIFICATE_YEAR_LAPSED');
    expect((await runWithoutTenant(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } }))).status).toBe('PENDING');
    expect(await code(doc.id, { registrationKind: 'BUSINESS_NAME', certificateYear: year() })).toBe('APPROVED');
    const recheck = startOfGuyanaDay(`${year() + 1}-01-16`);
    const approved = await runWithoutTenant(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id }, include: { renewalSchedule: true } }));
    expect(approved.status).toBe('APPROVED');
    expect(approved.expiresAt).toEqual(recheck);
    expect(approved.renewalSchedule?.expiresOn).toEqual(recheck);
  });

  it('a company’s certificate of incorporation never expires and has no renewal schedule', async () => {
    const doc = await pendingRegistration();
    expect(await code(doc.id, { registrationKind: 'COMPANY', certificateYear: year() })).toBe('APPROVED');
    const approved = await runWithoutTenant(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id }, include: { renewalSchedule: true } }));
    expect(approved.status).toBe('APPROVED');
    expect(approved.expiresAt).toBeNull();
    expect(approved.renewalSchedule).toBeNull();
  });
});

describe('[TRADES] profile wording', () => {
  it('a provider cannot offer to sell, refill or deliver cooking gas', async () => {
    const u = await makeUser();
    const refused = await save(u.token, 'plumber', 'LPG cylinder refills and delivery');
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('PROHIBITED_SERVICE_WORDING');
    expect(await runWithoutTenant(() => app.prisma.serviceProvider.count({ where: { userId: u.userId } }))).toBe(0);
    expect((await save(u.token, 'plumber', 'I install and repair water lines')).statusCode).toBe(200);
  });

  it('a protected title is refused where the trade cannot prove it', async () => {
    const u = await makeUser();
    const refused = await save(u.token, 'tutor', 'Chartered Accountant teaching maths');
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('PROTECTED_TITLE');
  });
});
