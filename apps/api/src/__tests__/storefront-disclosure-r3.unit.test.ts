import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matches, type Query } from './helpers/dl7-predicate-double';
import { customerRoutes } from '../modules/user/customer.routes';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';
import { PUBLIC_BROWSE_CAPABILITY, runAsSystem, runWithTenant } from '../plugins/tenant-context';
import { hostRoutes, orderStore, prismaDouble, project, recordingIo, recordingRedis, type Row } from './helpers/service-vertical-doubles';
import { PUBLIC_DISCLOSURE_TTL_MS, resetPublicDisclosureCacheForTests } from '../modules/verification/storefront-disclosure';
// [GUARDRAILS §8 · #54] The store-level ban's reads are proven against a real database (prohibited-items.test.ts);
// this seam models none of the category tables, and no fixture store is filed under a banned category.
vi.mock('../modules/compliance/prohibited-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../modules/compliance/prohibited-gate')>()),
  prohibitedStoreIds: async () => [],
  prohibitedStoreCategory: async () => null,
  // [owner 14 Oct, store names] nor the store's own words (no fixture store's name holds it)
  storeHiddenFromCustomers: async () => false,
}));


const crypto = vi.hoisted(() => ({ unwrap: vi.fn(), decrypt: vi.fn() }));
vi.mock('../providers/storage/envelope', () => ({ getKeyProvider: () => ({ unwrapDek: crypto.unwrap }) }));
vi.mock('../modules/verification/extraction-ledger', async (original) => ({
  ...await original<typeof import('../modules/verification/extraction-ledger')>(),
  unpackAndDecrypt: crypto.decrypt,
}));

// Actual registered customer handler and compiler. The projecting/where-grading
// database stand-in does not certify SQL/RLS, auth middleware or lock behavior.

async function fixture(status = 'ACTIVE') {
  const vendor: Row = {
    id: 'store-fixture', tenantId: 'tenant-public', status, isVerified: true,
    tenant: { id: 'tenant-public', isActive: true, kind: 'PRODUCTION' }, subscription: null,
    name: 'Fixture Shop', slug: 'fixture-shop', addressLine1: 'Fixture business address', addressLine2: null,
    ownerId: 'owner-fixture', owner: { userId: 'account-fixture', user: {
      id: 'account-fixture', tenantId: 'tenant-public', status: 'ACTIVE', countryCode: 'GY',
      firstName: 'Fixture', lastName: 'Proprietor', phone: 'TEST_ACCOUNT_CONTACT', isPhoneVerified: true,
    } },
    categories: [], operatingHours: [], images: [], publicPhone: null, vendorType: 'RESTAURANT',
    latitude: 0, longitude: 0, minOrderAmount: 0,
    // [R3] the seller block's own facts: no MMG link, no refund rule on file
    mmgPayUrl: null, mmgNumber: null, refundRule: null,
  };
  const records: Row[] = [
    { id: 'private-identity-record', tenantId: 'tenant-public', accountId: 'account-fixture', subjectId: 'subject-fixture',
      docType: 'owner_national_id', submissionId: 'identity-submission', status: 'VALID', expiresOn: null, updatedAt: new Date('2026-10-01T00:00:00Z'),
      submission: { purgedAt: null, userId: 'account-fixture', docType: 'owner_national_id', subjectId: 'subject-fixture' } },
    { id: 'private-personal-record', tenantId: 'tenant-public', accountId: 'account-fixture', subjectId: 'subject-fixture',
      docType: 'food_handler_cert', submissionId: 'personal-submission', status: 'VALID', expiresOn: null, updatedAt: new Date('2026-10-01T00:00:00Z'),
      submission: { purgedAt: null, userId: 'account-fixture', docType: 'food_handler_cert', subjectId: 'subject-fixture' } },
  ];
  const audit = vi.fn(async () => ({ id: 'audit-fixture' }));
  const extracted = vi.fn(async () => [{ id: 'run-fixture', wrappedDek: Buffer.from('fixture-wrapped'), fields: [
    { id: 'field-fixture', fieldCode: 'permit_number', valueCt: Buffer.from('fixture-encrypted') },
  ] }]);
  let afterInitialRead: (() => void) | undefined;
  let initialRead = true;
  const readVendor = async (q: Query) => {
    const found = matches(vendor, q.where) ? project(vendor, q.select) : null;
    // A committed change between the route read and compiler read is represented
    // by separate snapshots; no claim is made about real database ordering.
    const snapshot = found ? structuredClone(found) : null;
    if (initialRead) { initialRead = false; afterInitialRead?.(); }
    return snapshot;
  };
  const prisma = prismaDouble(orderStore([]), {
    // This privacy fixture has no global pause, repair rows or held clocks.
    // Preserve the tripwire for every unmodelled database delegate.
    platformConfig: { findUnique: async () => null, findMany: async () => [] },
    // [#1541] The projection takes billing's payer -> subscriptions locks first. This double accepts exactly those two
    // statements and nothing else; the database activation suite proves their order against settlement.
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join('?').replace(/\s+/g, ' ').trim();
      if (sql === 'SELECT "id" FROM "users" WHERE "id" = ? FOR NO KEY UPDATE /* vendor-activation-fee-payer */'
        || sql === 'SELECT s."id" FROM "subscriptions" s JOIN "vendors" v ON v."id" = s."vendorId" JOIN "vendor_owners" o ON o."id" = v."ownerId" WHERE o."userId" = ? ORDER BY s."id" FOR UPDATE OF s /* vendor-activation-fee-subscriptions */') return [];
      throw new Error(`Unexpected projection query: ${sql}`);
    }),
    vendor: { findFirst: readVendor, findUnique: readVendor,
      update: vi.fn(async ({ data }: { data: Row }) => Object.assign(vendor, data)),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        if (!matches(vendor, where)) return { count: 0 };
        Object.assign(vendor, data); return { count: 1 };
      }),
    },
    vendorOwner: { findUnique: async () => ({ id: 'owner-fixture', userId: 'account-fixture', vendors: [vendor] }) },
    user: { findUnique: async (q: Query) => project((vendor['owner'] as Row)['user'] as Row, q.select) },
    docType: { count: async () => 1, findMany: async () => [] },
    documentRecord: { findFirst: async () => null, findMany: vi.fn(async (q: Query) => records.filter(r => matches(r, q.where)).map(r => project(r, q.select))) },
    extractionRun: { findMany: extracted }, auditLog: { create: audit },
    promoCode: { findMany: async () => [] }, actorRatingStat: { findMany: async () => [] },
    customer: { count: async () => 0 },
    // [FOOD-PERMIT · owner 24 Oct 2026] This fixture is a registered restaurant: its owner has given the food handlers
    // tick (the ledger row POST /vendor/onboarding/food-handlers writes), so the disclosure block alone decides here.
    consentRecord: { findMany: async () => [{ action: 'granted', documentVersion: 'v1', evidence: { vendorId: 'store-fixture' } }] },
  });
  const host = await hostRoutes(customerRoutes, { prisma, redis: recordingRedis(), io: recordingIo() });
  const read = async (tenant?: string) => {
    const run = () => host.call('get /vendors/:id', { params: { id: 'store-fixture' } }) as Promise<{ data: { disclosure: unknown } }>;
    return tenant ? runWithTenant(tenant, run) : runAsSystem(PUBLIC_BROWSE_CAPABILITY, run);
  };
  const activate = async () => {
    const service = new VerificationService(prisma, new NotificationService(prisma, recordingIo()), new SandboxKycProvider());
    vi.spyOn(service, 'isRoleVerified').mockResolvedValue(true);
    vi.spyOn(service, 'checklistEvidenceValidUntil').mockResolvedValue(null);
    vi.spyOn(SubscriptionService.prototype, 'priceForActivation').mockResolvedValue(null);
    // Main's activation edge starts the store's trial subscription in the same
    // transaction; its own suites cover it. This grades the disclosure gate.
    vi.spyOn(SubscriptionService.prototype, 'startTrialForVendor').mockResolvedValue(null as never);
    const projection = service as unknown as { projectVendorActivation: (db: typeof prisma, id: string) => Promise<void> };
    await runWithTenant('tenant-public', () => projection.projectVendorActivation(prisma, 'account-fixture'));
  };
  return { vendor, prisma, records, extracted, audit, read, activate, afterInitial: (fn: () => void) => { afterInitialRead = fn; } };
}

beforeEach(() => {
  resetPublicDisclosureCacheForTests();
  crypto.unwrap.mockResolvedValue(Buffer.alloc(32));
  crypto.decrypt.mockReturnValue(Buffer.from('TEST_PERSONAL_LICENCE'));
  vi.stubEnv('PLATFORM_LEGAL_NAME', 'Fixture Operator');
  vi.stubEnv('PLATFORM_REGISTERED_ADDRESS', 'Fixture operator address');
  vi.stubEnv('SUPPORT_EMAIL', 'fixture@example.invalid');
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('R3 public storefront disclosure privacy — actual caller', () => {
  it.each(['PENDING_APPROVAL', 'SUSPENDED'])('%s has no private disclosure and never opens evidence', async status => {
    const h = await fixture(status);
    const response = await h.read();
    expect(response.data.disclosure).toBeNull();
    expect(h.extracted).not.toHaveBeenCalled();
    expect(crypto.unwrap).not.toHaveBeenCalled();
  });

  it.each(['disabled-tenant', 'reclassified-tenant'])('a %s after initial route admission cannot leak through compiler reread', async change => {
    const h = await fixture();
    h.afterInitial(() => { Object.assign(h.vendor['tenant'] as Row, change === 'disabled-tenant' ? { isActive: false } : { kind: 'REVIEW' }); });
    expect((await h.read()).data.disclosure).toBeNull();
    expect(h.extracted).not.toHaveBeenCalled();
  });

  it('the active public block has labelled lawful values without private record IDs, and never the private account contact', async () => {
    const h = await fixture();
    const block = (await h.read()).data.disclosure;
    // [row 107] The verified account contact satisfies the requirement, but it
    // is private: with nothing published the public block withholds it.
    expect(block).toMatchObject({ complete: true, contact: null });
    expect(JSON.stringify(block)).not.toContain('TEST_ACCOUNT_CONTACT');
    expect(JSON.stringify(block)).not.toContain('recordId');
    expect(JSON.stringify(block)).not.toContain('private-identity-record');
  });

  it('[row 107] the public block shows only the contact the store published', async () => {
    const h = await fixture();
    h.vendor['publicPhone'] = '+5926001234';
    const block = (await h.read()).data.disclosure;
    expect(block).toMatchObject({ complete: true, contact: { source: 'PUBLISHED', value: '+5926001234' } });
    expect(JSON.stringify(block)).not.toContain('TEST_ACCOUNT_CONTACT');
  });

  // [R3 · legal research D10] The public block never opens a licence NUMBER (see below), so the decrypt these
  // row-107 tests grade is a business record's public NAME field — the one the storefront does show.
  it('[row 107] each decrypt of a business record writes exactly one audit row, naming fields but never values', async () => {
    const h = await fixture();
    h.records.push({ id: 'business-licence-record', tenantId: 'tenant-public', accountId: 'account-fixture', subjectId: 'subject-business',
      docType: 'trade_licence', submissionId: 'licence-submission', status: 'VALID', expiresOn: null, updatedAt: new Date('2026-10-01T00:00:00Z'),
      submission: { purgedAt: null, userId: 'account-fixture', docType: 'trade_licence', subjectId: 'subject-business' } });
    (h.prisma as unknown as { docType: { findMany: unknown } }).docType.findMany = async () => [{ legacyCode: 'trade_licence', fields: [{ fieldCode: 'business_name' }] }];
    crypto.decrypt.mockReturnValue(Buffer.from('Fixture Trading Ltd'));
    h.extracted.mockResolvedValue([{ id: 'run-fixture', wrappedDek: Buffer.from('fixture-wrapped'), fields: [
      { id: 'field-fixture', runId: 'run-fixture', fieldCode: 'business_name', valueCt: Buffer.from('fixture-encrypted') },
    ] }] as never);
    const block = (await h.read()).data.disclosure as { legalName: unknown };
    expect(block.legalName).toEqual({ value: 'Fixture Trading Ltd', source: 'RECORD', docType: 'trade_licence' });
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith({ data: { userId: null, action: 'DISCLOSURE_FIELDS_DECRYPTED', entity: 'VerificationDocument', entityId: 'licence-submission',
      changes: { purpose: 'PUBLIC_STOREFRONT', docType: 'trade_licence', recordId: 'business-licence-record', fields: ['business_name'] } } });
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain('Fixture Trading Ltd');
  });

  it('[R3 · research D10] a business licence\'s NUMBER never reaches the public block: "on file" only, and it is never opened', async () => {
    const h = await fixture();
    h.records.push({ id: 'business-licence-record', tenantId: 'tenant-public', accountId: 'account-fixture', subjectId: 'subject-business',
      docType: 'trade_licence', submissionId: 'licence-submission', status: 'VALID', expiresOn: null, updatedAt: new Date('2026-10-01T00:00:00Z'),
      submission: { purgedAt: null, userId: 'account-fixture', docType: 'trade_licence', subjectId: 'subject-business' } });
    (h.prisma as unknown as { docType: { findMany: unknown } }).docType.findMany = async () => [{ legacyCode: 'trade_licence', fields: [{ fieldCode: 'permit_number' }] }];
    crypto.decrypt.mockReturnValue(Buffer.from('TL-0042'));
    h.extracted.mockResolvedValue([{ id: 'run-fixture', wrappedDek: Buffer.from('fixture-wrapped'), fields: [
      { id: 'field-fixture', runId: 'run-fixture', fieldCode: 'permit_number', valueCt: Buffer.from('fixture-encrypted') },
    ] }] as never);
    const block = (await h.read()).data.disclosure as { licences: unknown[] };
    expect(block.licences).toContainEqual({ value: 'on file', source: 'RECORD', docType: 'trade_licence' });
    expect(JSON.stringify(block)).not.toContain('TL-0042');
    expect(crypto.decrypt).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('[row 107] N public views within the cache TTL are ONE decrypt and ONE audit row; a changed record or an expired TTL compiles again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const h = await fixture();
      h.records.push({ id: 'business-licence-record', tenantId: 'tenant-public', accountId: 'account-fixture', subjectId: 'subject-business',
        docType: 'trade_licence', submissionId: 'licence-submission', status: 'VALID', expiresOn: null, updatedAt: new Date('2026-10-01T00:00:00Z'),
        submission: { purgedAt: null, userId: 'account-fixture', docType: 'trade_licence', subjectId: 'subject-business' } });
      (h.prisma as unknown as { docType: { findMany: unknown } }).docType.findMany = async () => [{ legacyCode: 'trade_licence', fields: [{ fieldCode: 'business_name' }] }];
      crypto.decrypt.mockReturnValue(Buffer.from('Fixture Trading Ltd'));
      h.extracted.mockResolvedValue([{ id: 'run-fixture', wrappedDek: Buffer.from('fixture-wrapped'), fields: [
        { id: 'field-fixture', runId: 'run-fixture', fieldCode: 'business_name', valueCt: Buffer.from('fixture-encrypted') },
      ] }] as never);
      for (let view = 0; view < 5; view += 1) {
        expect(((await h.read()).data.disclosure as { legalName: unknown }).legalName).toEqual({ value: 'Fixture Trading Ltd', source: 'RECORD', docType: 'trade_licence' });
      }
      expect(crypto.decrypt).toHaveBeenCalledTimes(1);
      expect(h.audit).toHaveBeenCalledTimes(1);
      // a change to what the block is compiled from is a miss at once
      (h.records[2] as Row)['updatedAt'] = new Date('2026-10-06T00:00:00Z');
      await h.read();
      expect(h.audit).toHaveBeenCalledTimes(2);
      // and so is an expired TTL
      vi.setSystemTime(Date.now() + PUBLIC_DISCLOSURE_TTL_MS + 1);
      await h.read();
      expect(h.audit).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });

  it('a PERSONAL licence discloses its on-file fact, not its decrypted private number', async () => {
    const h = await fixture();
    expect((await h.read()).data.disclosure).toMatchObject({ licences: [{ source: 'RECORD', docType: 'food_handler_cert', value: 'on file' }] });
    expect(crypto.decrypt).not.toHaveBeenCalled();
    expect(crypto.unwrap).not.toHaveBeenCalled();
  });

  it('foreign caller and pre-hidden guest stores remain unavailable before extraction', async () => {
    const foreign = await fixture();
    await expect(foreign.read('tenant-other')).rejects.toMatchObject({ statusCode: 404 });
    expect(foreign.extracted).not.toHaveBeenCalled();
    const hidden = await fixture();
    Object.assign(hidden.vendor['tenant'] as Row, { kind: 'REVIEW' });
    await expect(hidden.read()).rejects.toMatchObject({ statusCode: 404 });
    expect(hidden.extracted).not.toHaveBeenCalled();
  });

  it.each(['unverified', 'fee-suspended', 'fee-paused', 'fee-grace-expired', 'fee-period-ended'])('%s withholds disclosure before extraction', async restriction => {
    const h = await fixture();
    if (restriction === 'unverified') h.vendor['isVerified'] = false;
    else h.vendor['subscription'] = { id: 'disclosure-sub',
      status: restriction === 'fee-suspended' ? 'SUSPENDED' : restriction === 'fee-paused' ? 'PAUSED' : restriction === 'fee-grace-expired' ? 'PAST_DUE' : 'ACTIVE',
      gracePeriodEnd: restriction === 'fee-grace-expired' ? new Date(0) : null,
      autoRenew: restriction !== 'fee-period-ended', currentPeriodEnd: new Date(0),
      // Main's operability rule (billing confirmation clock): a PAST_DUE store is
      // inoperable once auto-suspension is due and not paused.
      autoSuspendEnabled: true, billingConfirmationPausedAt: null,
      billingEnforcementDueAt: restriction === 'fee-grace-expired' ? new Date(0) : null,
    };
    expect((await h.read()).data.disclosure).toBeNull();
    expect(h.extracted).not.toHaveBeenCalled();
    expect(crypto.unwrap).not.toHaveBeenCalled();
  });

  it.each(['legacy', 'paid', 'grace'])('an eligible CLOSED store retains the supplier block (%s)', async subscription => {
    const h = await fixture('CLOSED');
    if (subscription !== 'legacy') h.vendor['subscription'] = { id: 'disclosure-sub',
      status: subscription === 'paid' ? 'ACTIVE' : 'PAST_DUE', autoRenew: true,
      gracePeriodEnd: new Date(Date.now() + 60_000), currentPeriodEnd: new Date(Date.now() + 60_000),
      autoSuspendEnabled: true, billingConfirmationPausedAt: null, billingEnforcementDueAt: new Date(Date.now() + 60_000),
    };
    expect((await h.read()).data.disclosure).toMatchObject({ complete: true });
    expect(crypto.unwrap).not.toHaveBeenCalled();
  });

  it('bound REVIEW and CRAWLER callers retain their own eligible disclosure', async () => {
    for (const kind of ['REVIEW', 'CRAWLER']) {
      const h = await fixture();
      (h.vendor['tenant'] as Row)['kind'] = kind;
      expect((await h.read('tenant-public')).data.disclosure).toMatchObject({ complete: true });
    }
    expect(crypto.unwrap).not.toHaveBeenCalled();
  });
});

describe('R3 actual activation projection', () => {
  it('a pending store with a complete lawful block activates without PERSONAL extraction', async () => {
    const h = await fixture('PENDING_APPROVAL');
    h.vendor['isVerified'] = false;
    // [owner #51, 14 Oct] A first go-live also needs a published contact phone.
    h.vendor['publicPhone'] = '+5926001234';
    await h.activate();
    expect(h.vendor).toMatchObject({ status: 'ACTIVE', isVerified: true, acceptingOrders: true });
    expect(h.extracted).not.toHaveBeenCalled();
    expect(crypto.unwrap).not.toHaveBeenCalled();
  });

  it.each(['legalName', 'address', 'contact'])('missing required %s still blocks activation', async missing => {
    const h = await fixture('PENDING_APPROVAL');
    h.vendor['isVerified'] = false;
    if (missing === 'legalName') h.records.splice(0, 1);
    if (missing === 'address') h.vendor['addressLine1'] = null;
    if (missing === 'contact') ((h.vendor['owner'] as Row)['user'] as Row)['isPhoneVerified'] = false;
    await h.activate();
    expect(h.vendor).toMatchObject({ status: 'PENDING_APPROVAL', isVerified: false });
    expect(crypto.unwrap).not.toHaveBeenCalled();
  });

  // [R3 · owner 15 Oct 2026] The operator block is the ONE OPERATOR constant: blank configuration can no longer
  // make it the missing element (it used to hold every store back when SUPPORT_EMAIL was unset).
  it('the operator is never the missing element: with the configuration blank, a complete store still activates', async () => {
    const h = await fixture('PENDING_APPROVAL');
    h.vendor['isVerified'] = false;
    h.vendor['publicPhone'] = '+5926001234';
    vi.stubEnv('SUPPORT_EMAIL', '');
    vi.stubEnv('PLATFORM_LEGAL_NAME', '');
    vi.stubEnv('PLATFORM_REGISTERED_ADDRESS', '');
    await h.activate();
    expect(h.vendor).toMatchObject({ status: 'ACTIVE', isVerified: true });
  });
});
