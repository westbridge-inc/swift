import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VehicleType, VerificationDocument } from '@prisma/client';
import { VerificationService } from '../modules/verification/verification.service';
import { anyChecklistEvidenceFor, approvedEvidenceFor } from '../modules/verification/evidence';

const userId = 'mover-document-unit';
const checklist = ['national_id', 'police_clearance'];
const now = new Date('2026-09-12T12:00:00Z');

function record(docType: string) {
  return {
    docType,
    expiresOn: new Date('2027-09-12T12:00:00Z'),
    submission: {
      retentionExpiresAt: null, reviewedAt: now, userId, subjectId: null,
      coverageClass: 'PRIVATE', hireClassConfirmed: false, plateCrossChecked: false,
    },
  };
}

/** No Prisma client is constructed: the service and country accessor use only this double. */
type Submission = Pick<VerificationDocument, 'docType' | 'userId' | 'subjectId' | 'status' | 'state' | 'expiresAt' | 'purgedAt'>;
type SubmissionWhere = { docType: { in: string[] }; OR: Array<{ userId?: string; subjectId?: { in: string[] } }> };

function fixture(opts: { current?: string[]; history?: string[]; submissions?: Submission[]; required?: string[] } = {}) {
  const db = {
    user: { findUnique: vi.fn().mockResolvedValue({ countryCode: 'GY' }) },
    countryConfig: { findUnique: vi.fn().mockResolvedValue({
      documentChecklists: { MOVER: opts.required ?? checklist },
    }) },
    subjectLink: { findMany: vi.fn().mockResolvedValue([]) },
    documentRecord: {
      findMany: vi.fn(async ({ where }: { where: { docType: { in: string[] } } }) =>
        (opts.current ?? []).filter((type) => where.docType.in.includes(type)).map(record)),
      count: vi.fn(async ({ where }: { where: { docType: { in: string[] } } }) =>
        (opts.history ?? []).filter((type) => where.docType.in.includes(type)).length),
    },
    verificationDocument: {
      // The real query must count submitted rows irrespective of their state,
      // status, expiry or purge fields; exact query assertions enforce that.
      count: vi.fn(async ({ where }: { where: SubmissionWhere }) =>
        (opts.submissions ?? []).filter((row) => where.docType.in.includes(row.docType)
          && where.OR.some((owner) => owner.userId === row.userId
            || (row.subjectId !== null && owner.subjectId?.in.includes(row.subjectId)))).length),
    },
  };
  // An empty constructor client makes accidental reads outside the supplied db fail.
  const service = new VerificationService({} as never, {} as never, {} as never);
  return { db, service, client: db as never };
}

afterEach(() => vi.useRealTimers());

describe('shared current mover-document authority', () => {
  it('refuses a true legacy flag when a previously filed checklist type is no longer current', async () => {
    // Status/expiry/purge filtering is asserted separately against the query
    // below; this decision test supplies the resulting current/history sets.
    const { service, client } = fixture({ current: ['national_id'], history: checklist });
    expect(await service.getMoverDocumentStatus(userId, { vehicleType: 'BICYCLE', legacyVerified: true }, client))
      .toEqual({ allowed: false, reason: 'docs' });
  });

  it('grandfathers genuine pre-checklist accounts, including only never-filed missing types', async () => {
    for (const current of [[], ['national_id']]) {
      const { service, db, client } = fixture({ current, history: current });
      expect(await service.getMoverDocumentStatus(userId, { vehicleType: 'BICYCLE', legacyVerified: true }, client))
        .toEqual({ allowed: true, reason: 'ok' });
      expect(db.documentRecord.count).toHaveBeenCalledWith({ where: {
        docType: { in: checklist.filter((type) => !current.includes(type)) },
        OR: [{ accountId: userId }],
      } });
    }
  });

  it('refuses never-filed missing types without the legacy flag', async () => {
    const { service, client } = fixture();
    expect(await service.getMoverDocumentStatus(userId, { vehicleType: 'BICYCLE' }, client))
      .toEqual({ allowed: false, reason: 'docs' });
  });

  it.each([
    { status: 'REJECTED', state: 'REJECTED', expiresAt: null, purgedAt: null },
    { status: 'PENDING', state: 'REVIEW_QUEUED', expiresAt: new Date('2020-01-01'), purgedAt: null },
    { status: 'REJECTED', state: 'PURGED', expiresAt: null, purgedAt: new Date('2020-01-01') },
  ] as const)('refuses never-approved submission history: $status / $state', async (fields) => {
    const submission = { ...fields, docType: 'police_clearance', userId, subjectId: null };
    const { service, db, client } = fixture({ current: ['national_id'], submissions: [submission] });
    expect(await service.getMoverDocumentStatus(userId, { vehicleType: 'BICYCLE', legacyVerified: true }, client))
      .toEqual({ allowed: false, reason: 'docs' });
    expect(await db.documentRecord.count.mock.results[0]?.value).toBe(0);
    expect(db.verificationDocument.count).toHaveBeenCalledExactlyOnceWith({ where: {
      docType: { in: ['police_clearance'] }, OR: [{ userId }],
    } });
  });

  it('accepts a complete current checklist without the flag and reads config through the supplied transaction', async () => {
    const { service, db, client } = fixture({ current: checklist, history: checklist });
    expect(await service.getMoverDocumentStatus(userId, { vehicleType: 'BICYCLE' }, client))
      .toEqual({ allowed: true, reason: 'ok' });
    expect(db.countryConfig.findUnique).toHaveBeenCalledWith({ where: { code: 'GY' } });
    expect(db.documentRecord.count).not.toHaveBeenCalled();
  });

  it('fails closed on an empty checklist even with the flag', async () => {
    const { service, client } = fixture({ required: [] });
    expect(await service.getMoverDocumentStatus(userId, { vehicleType: 'BICYCLE', legacyVerified: true }, client))
      .toEqual({ allowed: false, reason: 'docs' });
  });

  it('uses the delivery vehicle checklist without requiring taxi hire-class confirmation', async () => {
    const { service, db, client } = fixture({ current: [...checklist, 'vehicle_insurance'] });
    db.countryConfig.findUnique.mockResolvedValue({ documentChecklists: {
      MOVER: checklist, MOVER_MOTOR: ['vehicle_insurance'],
    } });
    expect(await service.getMoverDocumentStatus(userId, { vehicleType: 'CAR' }, client))
      .toEqual({ allowed: true, reason: 'ok' });
    expect(await service.getLiveOperationStatus(userId, { vehicleType: 'CAR' }, client))
      .toEqual({ allowed: false, reason: 'insurance' });
  });

  it('driver live status uses the same document authority and transaction', async () => {
    const { service, client } = fixture({ current: checklist });
    const shared = vi.spyOn(service, 'getMoverDocumentStatus');
    const opts = { vehicleType: 'BICYCLE' as const, legacyVerified: true };
    expect(await service.getLiveOperationStatus(userId, opts, client)).toEqual({ allowed: true, reason: 'ok' });
    expect(shared).toHaveBeenCalledExactlyOnceWith(userId, opts, client);
  });

  it('a positive preview is re-evaluated against changed evidence with a fresh clock', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const preview = fixture({ current: checklist });
    const locked = fixture({ current: ['national_id'], history: checklist });
    expect((await preview.service.getMoverDocumentStatus(userId, { vehicleType: 'BICYCLE', legacyVerified: true }, preview.client)).allowed).toBe(true);
    vi.setSystemTime(new Date(now.getTime() + 1_000));
    expect((await preview.service.getMoverDocumentStatus(userId, { vehicleType: 'BICYCLE', legacyVerified: true }, locked.client)).allowed).toBe(false);
    expect(locked.db.documentRecord.findMany.mock.calls[0]?.[0]).toMatchObject({ where: {
      AND: expect.arrayContaining([{ OR: [{ expiresOn: null }, { expiresOn: { gt: new Date(now.getTime() + 1_000) } }] }]),
    } });
  });
});

describe('durable history and current evidence query boundaries', () => {
  it('counts never-approved submissions for a currently linked vehicle, without counting unrelated owners or types', async () => {
    const row = { docType: 'police_clearance', userId: 'fleet-owner', subjectId: 'fleet-vehicle', status: 'REJECTED', state: 'PURGED', expiresAt: null, purgedAt: now } as const;
    const { db, client } = fixture({ submissions: [row] });
    db.subjectLink.findMany.mockResolvedValue([{ subjectId: 'fleet-vehicle' }]);
    expect(await anyChecklistEvidenceFor(client, userId, ['police_clearance'])).toBe(true);
    expect(db.verificationDocument.count).toHaveBeenCalledExactlyOnceWith({ where: {
      docType: { in: ['police_clearance'] },
      OR: [{ userId }, { subjectId: { in: ['fleet-vehicle'] } }],
    } });
    db.subjectLink.findMany.mockResolvedValue([]);
    expect(await anyChecklistEvidenceFor(client, userId, ['police_clearance'])).toBe(false);
    expect(await anyChecklistEvidenceFor(client, 'fleet-owner', ['national_id'])).toBe(false);
  });

  it('counts purged history for the account and its currently linked fleet vehicle', async () => {
    const { db, client } = fixture({ history: ['police_clearance'] });
    db.subjectLink.findMany.mockResolvedValue([{ subjectId: 'fleet-vehicle' }]);
    expect(await anyChecklistEvidenceFor(client, userId, ['police_clearance'])).toBe(true);
    // Exact shape deliberately excludes submission.purgedAt, status and expiry:
    // any such filter would incorrectly restore grandfathering after retirement.
    expect(db.documentRecord.count).toHaveBeenCalledWith({ where: {
      docType: { in: ['police_clearance'] },
      OR: [{ accountId: userId }, { subjectId: { in: ['fleet-vehicle'] } }],
    } });
  });

  it('current evidence still excludes expired, purged and retention-expired records', async () => {
    const { db, client } = fixture();
    await approvedEvidenceFor(client, userId, checklist, now);
    expect(db.documentRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      docType: { in: checklist }, status: 'VALID', AND: [
        { OR: [{ expiresOn: null }, { expiresOn: { gt: now } }] },
        { OR: [{ accountId: userId }] },
        { submission: { purgedAt: null, OR: [{ retentionExpiresAt: null }, { retentionExpiresAt: { gt: now } }] } },
      ],
    } }));
  });
});

describe('expiry sweep evaluates each owned supply profile independently', () => {
  type Profile = { vehicleType: VehicleType; documentsVerified: boolean };
  function sweepFixture(driver: Profile | null, rider: Profile | null, evidence: Parameters<typeof fixture>[0] = {}) {
    const { db } = fixture(evidence);
    const profiles = {
      ...db,
      driver: { findUnique: vi.fn().mockResolvedValue(driver), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      rider: { findUnique: vi.fn().mockResolvedValue(rider), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const notifications = { send: vi.fn().mockResolvedValue(undefined) };
    const service = new VerificationService(profiles as never, notifications as never, {} as never);
    return { db: profiles, service, notifications };
  }

  it('a failed taxi hire policy only offlines the driver; a delivery CAR remains allowed', async () => {
    const profile = { vehicleType: 'CAR' as const, documentsVerified: false };
    const { db, service, notifications } = sweepFixture(profile, profile, { current: [...checklist, 'vehicle_insurance'] });
    db.countryConfig.findUnique.mockResolvedValue({ documentChecklists: {
      MOVER: checklist, MOVER_MOTOR: ['vehicle_insurance'],
    } });
    expect(await service.forceMoverOfflineIfNotLive(userId)).toBe(true);
    expect(db.driver.updateMany).toHaveBeenCalledExactlyOnceWith({ where: { userId, isOnline: true }, data: { isOnline: false } });
    expect(db.rider.updateMany).not.toHaveBeenCalled();
    expect(notifications.send).toHaveBeenCalledTimes(1);
  });

  it.each(['driver', 'rider'] as const)('the %s legacy flag cannot grandfather the other profile', async (grandfathered) => {
    const { db, service } = sweepFixture(
      { vehicleType: 'BICYCLE', documentsVerified: grandfathered === 'driver' },
      { vehicleType: 'MOTORCYCLE', documentsVerified: grandfathered === 'rider' },
    );
    db.countryConfig.findUnique.mockResolvedValue({ documentChecklists: {
      MOVER: checklist, MOVER_MOTOR: ['drivers_licence'],
    } });
    expect(await service.forceMoverOfflineIfNotLive(userId)).toBe(true);
    expect(db[grandfathered].updateMany).not.toHaveBeenCalled();
    expect(db[grandfathered === 'driver' ? 'rider' : 'driver'].updateMany).toHaveBeenCalledTimes(1);
  });

  it('an expired motorcycle licence offlines the rider even when the sibling bicycle checklist is current', async () => {
    const { db, service } = sweepFixture(
      { vehicleType: 'BICYCLE', documentsVerified: true },
      { vehicleType: 'MOTORCYCLE', documentsVerified: true },
      { current: checklist, history: [...checklist, 'drivers_licence'] },
    );
    db.countryConfig.findUnique.mockResolvedValue({ documentChecklists: {
      MOVER: checklist, MOVER_MOTOR: ['drivers_licence'],
    } });
    expect(await service.forceMoverOfflineIfNotLive(userId)).toBe(true);
    expect(db.driver.updateMany).not.toHaveBeenCalled();
    expect(db.rider.updateMany).toHaveBeenCalledExactlyOnceWith({ where: { userId, isOnline: true }, data: { isOnline: false } });
  });

  it('a rider-only delivery car is not judged by passenger hire insurance', async () => {
    const { db, service, notifications } = sweepFixture(null, { vehicleType: 'CAR', documentsVerified: false }, { current: checklist });
    expect(await service.forceMoverOfflineIfNotLive(userId)).toBe(false);
    expect(db.driver.updateMany).not.toHaveBeenCalled();
    expect(db.rider.updateMany).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('offlines both failing profiles with one notification and does not notify again when already offline', async () => {
    const profile = { vehicleType: 'BICYCLE' as const, documentsVerified: true };
    const { db, service, notifications } = sweepFixture(profile, profile, { history: checklist });
    expect(await service.forceMoverOfflineIfNotLive(userId)).toBe(true);
    expect(db.driver.updateMany).toHaveBeenCalledTimes(1);
    expect(db.rider.updateMany).toHaveBeenCalledTimes(1);
    expect(notifications.send).toHaveBeenCalledTimes(1);
    db.driver.updateMany.mockResolvedValue({ count: 0 });
    db.rider.updateMany.mockResolvedValue({ count: 0 });
    expect(await service.forceMoverOfflineIfNotLive(userId)).toBe(false);
    expect(notifications.send).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an account with neither profile', async () => {
    const { db, service, notifications } = sweepFixture(null, null);
    expect(await service.forceMoverOfflineIfNotLive(userId)).toBe(false);
    expect(db.countryConfig.findUnique).not.toHaveBeenCalled();
    expect(db.driver.updateMany).not.toHaveBeenCalled();
    expect(db.rider.updateMany).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
  });
});

describe('rider GO document authority wiring', () => {
  const source = readFileSync(join(__dirname, '../modules/rider/rider.routes.ts'), 'utf8');
  const go = source.slice(source.indexOf("app.post('/go-online'"), source.indexOf("app.post('/go-offline'"));

  it('calls the base authority before the transaction with the rider vehicle and flag', () => {
    const preview = go.slice(0, go.indexOf('app.prisma.$transaction'));
    expect(preview).toMatch(/await verification\.getMoverDocumentStatus\(request\.user\.userId,\s*\{\s*vehicleType: rider\.vehicleType,\s*legacyVerified: rider\.documentsVerified,\s*\}\)/);
    expect(preview).toContain('if (!documents.allowed)');
    expect(go).not.toContain('verification.isRoleVerified');
    expect(go).not.toContain('verification.getLiveOperationStatus');
  });

  it('rechecks the locked vehicle and flag with tx before changing supply', () => {
    const lock = go.indexOf('await lockUserRoleAuthority');
    const snapshot = go.indexOf('const snapshot = snapshots[0]');
    const recheck = go.indexOf('const liveDocuments = await verification.getMoverDocumentStatus');
    const refusal = go.indexOf('if (!liveDocuments.allowed)');
    const retire = go.indexOf('await lockAndRetireDriverSupply');
    const activation = go.indexOf('await tx.rider.update');
    expect(lock).toBeGreaterThan(-1);
    expect(snapshot).toBeGreaterThan(lock);
    expect(recheck).toBeGreaterThan(snapshot);
    expect(refusal).toBeGreaterThan(recheck);
    expect(retire).toBeGreaterThan(refusal);
    expect(activation).toBeGreaterThan(retire);
    expect(go.slice(recheck, refusal)).toMatch(/vehicleType: snapshot\.vehicleType,\s*legacyVerified: snapshot\.documentsVerified,\s*\}, tx\)/);
    expect(go).toContain('SELECT "currentOrderId", "documentsVerified", "vehicleType", "updatedAt"');
  });
});
