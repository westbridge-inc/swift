import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { keptWhileAccountOpen, CUSTOMER_ID_DOC_TYPE } from '../modules/verification/retention-policy';
import { PRIVACY, TERMS, CHILD_SAFETY } from '../modules/legal/legal.routes';
import { ownedVerificationFixture } from './helpers/verification-object';

// ---------------------------------------------------------------------------
// [Owner ruling 8 Oct 2026 ~23:25 GYT — CUSTOMER ID] (3) A customer's ID picture is KEPT while
// the account is open and deleted when it closes; this supersedes "delete ID images within 30
// days of the decision" for customer IDs only. The Privacy Policy DRAFT says so.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const ids: string[] = [];
const runBase = 592_047_000_000 + Math.floor(Math.random() * 8_000_000);

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
});

afterAll(async () => {
  if (!app) return;
  await runWithoutTenant(async () => {
    const docs = (await app.prisma.verificationDocument.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((d) => d.id);
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.subject.deleteMany({ where: { createdById: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
  await app.close();
});

describe('the retention rule names the customer ID, and only it', () => {
  it('a customer ID is kept while the account is open; partner documents are not covered', () => {
    expect(CUSTOMER_ID_DOC_TYPE).toBe('identity_l2');
    expect(keptWhileAccountOpen({ docType: 'identity_l2', role: 'CUSTOMER' })).toBe(true);
    expect(keptWhileAccountOpen({ docType: 'national_id', role: 'MOVER' })).toBe(false);
    expect(keptWhileAccountOpen({ docType: 'owner_national_id', role: 'VENDOR_OWNER' })).toBe(false);
    expect(keptWhileAccountOpen({ docType: 'national_id', role: 'CUSTOMER' })).toBe(false);
  });
});

describe('no schedule purges a customer ID image while the account is open', () => {
  it('the image-policy purge refuses a committed customer ID and leaves its file in place', async () => {
    const service = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
    const user = await runWithoutTenant(() => app.prisma.user.create({ data: {
      phone: `+${runBase}`, firstName: 'Synthetic', lastName: 'Customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
      isPhoneVerified: true, countryCode: 'GY', trustLevel: 'L1',
    } }));
    ids.push(user.id);
    const doc = await runWithoutTenant(async () => service.submitIdentity(
      user.id, await ownedVerificationFixture(app.prisma, user.id, 'auto-approve'), await ownedVerificationFixture(app.prisma, user.id, 'selfie'), 'v1',
    ));
    expect(doc).toMatchObject({ status: 'APPROVED', state: 'COMMITTED', docType: 'identity_l2', role: 'CUSTOMER' });

    expect(await service.purgeImageAfterReview(doc.id, 'image-policy')).toBe('NOT_PURGED');
    const after = await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(after.fileUrl).toBe(doc.fileUrl);
    expect(after.imagePurgedAt).toBeNull();
    expect(after.purgedAt).toBeNull();
  });
});

describe('the Privacy Policy DRAFT and Terms say what the code does', () => {
  it('the customer ID: on file at once unless held, withdrawable, kept while open, deleted at closure, staff-only', () => {
    expect(PRIVACY).toMatch(/goes on your account straight away — no person reviews it first — unless automatic checks hold it for our verification team/);
    expect(PRIVACY).toMatch(/Our team can withdraw an ID at any time/);
    expect(PRIVACY).toMatch(/We keep it while your account is open[^.]*and we delete it when your account is closed/);
    expect(PRIVACY).toMatch(/Only our verification staff can open it, and every view is logged/);
    expect(PRIVACY).toMatch(/A customer's ID is kept while the account is open and deleted when the account is closed/);
  });

  it('the profile photo is for taxi rides and is never compared with a customer\'s ID; no customer is promised "verification"', () => {
    expect(PRIVACY).toMatch(/a customer adds one before their first taxi ride/);
    expect(PRIVACY).toMatch(/A customer's photo is never compared with their ID/);
    expect(PRIVACY).not.toMatch(/A registration selfie<\/b> to deter account fraud/);
    expect(TERMS).toMatch(/require a government-issued ID on file/);
    expect(TERMS).not.toMatch(/require identity verification with a government-issued ID/);
    expect(CHILD_SAFETY).toMatch(/need a government ID on file/);
    expect(CHILD_SAFETY).not.toMatch(/government-ID verification/);
  });

  it('nothing in the policy says a customer\'s ID or photo is face-matched (review S2): face-matching is a Partner check', () => {
    expect(PRIVACY).toMatch(/For Partners, to confirm a document and selfie match/);
    expect(PRIVACY).not.toMatch(/(?<!For Partners, )To confirm a document and selfie match/);
    expect(PRIVACY).toMatch(/face-matching checks on the verification documents and selfies that Partners submit \(a customer's ID is never face-matched\)/);
    expect(PRIVACY).not.toMatch(/face-matching checks on the verification document and selfie you submit/);
  });

  it('the public delivery policy says a restricted account adds its ID and a person checks it', () => {
    const delivery = readFileSync(join(__dirname, '../../../web/src/app/legal/delivery/page.tsx'), 'utf8');
    expect(delivery).not.toMatch(/verify your identity/);
    expect(delivery).toMatch(/you must add your ID — and a person on our team\s+checks it — before ordering again/);
  });
});
