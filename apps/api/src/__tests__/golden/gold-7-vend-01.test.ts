import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGolden, DAY, type Actor } from './gold-7-helpers';
import { documentHarness } from './gold-7-documents';

// ---------------------------------------------------------------------------
// GOLD-7 · VEND-01 — agreement refusal → join → encrypted documents → review
// → approval. The STORE is CREATED by /partner/become, never seeded in Prisma.
// A rejected document keeps a second applicant pending. Customer sessions
// cannot approve documents, and partial checklists cannot activate stores.
// Phone +5920975nnn: source/range-audited. Consent rows are append-only evidence.
// Device/staging-only: real camera capture and real provider notification.
// ---------------------------------------------------------------------------
const h = createGolden('+5920975', 'gold7-vend01');
const docs = documentHarness(h, 'vend01');
const REASON = { 'x-swift-reason': 'Golden vendor onboarding document review' };
// [VERIFY-DOCS · ruling 7] no TIN certificate on the store list
const CHECKLIST = ['owner_national_id', 'business_registration', 'storefront_photo'];
beforeAll(() => docs.start());
afterAll(() => docs.close());

const application = (actor: Actor) => ({ role: 'VENDOR', business: {
  name: 'Golden Applicant', vendorType: 'STORE', phone: actor.phone, addressLine1: '7 Golden Lane',
  city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
} });

async function submit(actor: Actor, docType: string) {
  const bytes = docs.bytes();
  const uploaded = await docs.upload(actor, bytes);
  expect(uploaded.statusCode, uploaded.json().error?.code).toBe(200);
  const submitted = await h.call('POST', '/api/v1/verification/documents', actor.token, {
    role: 'STORE', docType, fileUrl: uploaded.json().data.url, consent: true, privacyNoticeVersion: 'v1',
  });
  expect(submitted.statusCode, submitted.json().error?.code).toBe(201);
  return { id: submitted.json().data.id as string, bytes };
}

async function review(admin: Actor, document: { id: string; bytes: Buffer }, approve: boolean) {
  const link = await h.call('GET', `/api/v1/admin/verification/${document.id}/document-url`, admin.token, undefined, REASON);
  expect(link.statusCode).toBe(200);
  const rendered = await h.app.inject({ method: 'GET', url: link.json().data.url });
  expect(rendered.statusCode).toBe(200);
  expect(Buffer.from(rendered.rawPayload).equals(document.bytes)).toBe(true);
  const custody = await h.call('GET', `/api/v1/admin/verification/${document.id}/custody`, admin.token, undefined, REASON);
  expect(custody.statusCode, custody.json().error?.code).toBe(200);
  const open = custody.json().data.review.filter((c: { closedAt: string | null }) => c.closedAt === null);
  expect(open).toHaveLength(1);
  const claimed = await h.call('POST', `/api/v1/admin/verification/cases/${open[0].caseId}/claim`, admin.token, {}, REASON);
  expect(claimed.statusCode, claimed.json().error?.code).toBe(200);
  expect(claimed.json().data.assignedTo).toBe(admin.userId);
  const result = await h.call('PUT', `/api/v1/admin/verification/${document.id}/${approve ? 'approve' : 'reject'}`, admin.token,
    approve ? { expiresAt: new Date(Date.now() + 365 * DAY).toISOString() }
      : { reasonCode: 'UNREADABLE', reason: 'The registration number is unreadable' }, REASON);
  expect(result.statusCode, result.json().error?.code).toBe(200);
  const decided = await h.sys(() => h.app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: document.id } }));
  expect(decided).toMatchObject({ status: approve ? 'APPROVED' : 'REJECTED', reviewedBy: admin.userId });
  const record = await h.sys(() => h.app.prisma.reviewCase.findUniqueOrThrow({ where: { id: open[0].caseId }, include: { decisions: true } }));
  expect(record.closedAt).not.toBeNull();
  expect(record.decisions.map((d) => [d.reviewerId, d.outcome])).toEqual([[admin.userId, approve ? 'APPROVE' : 'REJECT']]);
}

describe('GOLD-7 · VEND-01 — join, documents and approval', () => {
  it('requires the agreement, creates a pending store and approves it only after every uploaded document is reviewed', async () => {
    const applicant = await h.actor();
    const admin = await h.actor(['ADMIN']);
    const outsider = await h.actor();
    for (const acceptance of [{}, { acceptAgreement: false }]) {
      const refused = await h.call('POST', '/api/v1/partner/become', applicant.token, { ...application(applicant), ...acceptance });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.code).toBe('AGREEMENT_REQUIRED');
      expect(await h.sys(() => h.app.prisma.vendorOwner.count({ where: { userId: applicant.userId } }))).toBe(0);
      expect(await h.sys(() => h.app.prisma.consentRecord.count({ where: { subjectId: applicant.userId } }))).toBe(0);
      expect((await h.sys(() => h.app.prisma.user.findUniqueOrThrow({ where: { id: applicant.userId } }))).roles).toEqual(['CUSTOMER']);
    }
    const joined = await h.call('POST', '/api/v1/partner/become', applicant.token, { ...application(applicant), acceptAgreement: true });
    expect(joined.statusCode, joined.json().error?.code).toBe(201);
    expect(joined.json().data).toMatchObject({ kind: 'VENDOR', created: true, activeRole: 'VENDOR_OWNER' });
    const vendorId = joined.json().data.id as string;
    const vendorRow = () => h.sys(() => h.app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } }));
    expect(await vendorRow()).toMatchObject({ status: 'PENDING_APPROVAL', isVerified: false });
    const consents = await h.sys(() => h.app.prisma.consentRecord.findMany({ where: { subjectId: applicant.userId, documentType: 'vendor_agreement' } }));
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({ action: 'granted', evidence: { control: 'agreement_checkbox' } });
    expect((await docs.upload(applicant, docs.bytes(), '/api/v1/auth/selfie')).statusCode).toBe(200);
    const initial = await h.call('GET', '/api/v1/verification/status?role=STORE', applicant.token);
    expect(initial.statusCode).toBe(200);
    expect(initial.json().data.checklist).toEqual(CHECKLIST);
    expect(initial.json().data).toMatchObject({ missing: CHECKLIST, roleVerified: false });
    const early = await h.call('PUT', `/api/v1/admin/vendors/${vendorId}/approve`, admin.token, {}, REASON);
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('CHECKLIST_INCOMPLETE');
    for (const type of ['owner_national_id', 'storefront_photo', 'business_registration']) {
      const document = await submit(applicant, type);
      const before = await h.sys(() => h.app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: document.id } }));
      const wrongRole = await h.call('PUT', `/api/v1/admin/verification/${document.id}/approve`, outsider.token, {}, REASON);
      expect(wrongRole.statusCode).toBe(403);
      expect(await h.sys(() => h.app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: document.id } }))).toEqual(before);
      await review(admin, document, true);
      if (type !== 'business_registration') expect(await vendorRow()).toMatchObject({ status: 'PENDING_APPROVAL', isVerified: false });
    }
    expect(await vendorRow()).toMatchObject({ status: 'ACTIVE', isVerified: true, acceptingOrders: true });
    expect((await vendorRow()).activationValidUntil!.getTime()).toBeGreaterThan(Date.now());
    const complete = await h.call('GET', '/api/v1/verification/status?role=STORE', applicant.token);
    expect(complete.statusCode).toBe(200);
    expect(complete.json().data).toMatchObject({ missing: [], roleVerified: true });
    expect(await h.sys(() => h.app.prisma.subscription.count({ where: { vendorId } }))).toBe(1);
  });

  it('rejects an unreadable submitted document and leaves that applicant pending, with one durable decision', async () => {
    const applicant = await h.actor();
    const admin = await h.actor(['ADMIN']);
    const joined = await h.call('POST', '/api/v1/partner/become', applicant.token, { ...application(applicant), acceptAgreement: true });
    expect(joined.statusCode, joined.json().error?.code).toBe(201);
    const document = await submit(applicant, 'business_registration');
    await review(admin, document, false);
    const rejected = await h.sys(() => h.app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: document.id } }));
    expect(rejected.reviewNote).toContain('UNREADABLE');
    expect(rejected.reviewNote).toContain('The registration number is unreadable');
    expect(await h.sys(() => h.app.prisma.vendor.findUniqueOrThrow({ where: { id: joined.json().data.id } }))).toMatchObject({ status: 'PENDING_APPROVAL', isVerified: false });
    const status = await h.call('GET', '/api/v1/verification/status?role=STORE', applicant.token);
    expect(status.statusCode).toBe(200);
    expect(status.json().data.missing).toContain('business_registration');
    const repeated = await h.call('PUT', `/api/v1/admin/verification/${document.id}/reject`, admin.token,
      { reasonCode: 'UNREADABLE', reason: 'The registration number is unreadable' }, REASON);
    expect(repeated.statusCode).toBe(400);
    expect(repeated.json().error.code).toBe('NOT_PENDING');
  });
});
