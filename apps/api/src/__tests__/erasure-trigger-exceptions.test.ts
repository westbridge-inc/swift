/**
 * [GUARDRAILS §2 · owner 19 Oct G1/G3 · COORD 19 Oct 03:46Z + 04:51Z] The erasure's one-way exceptions to three
 * immutability triggers (migration 20261019100000_erasure_trigger_exceptions), graded on the migrated database.
 * Each exception opens ONLY for a person whose users row carries the erasure's marker (phone = 'deleted:' || id),
 * ONLY for the exact erased values, and every other write stays refused, for an erased person too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { runWithoutTenant } from '../plugins/tenant-context';
import { ERASED_CARD, deidentifyCaseRecords, retireCardsAndSessions } from '../modules/user/erasure-coverage';
import { ACCOUNT_ERASURE_CUTOFF } from '../modules/user/account-closure';
import { normalizePhone, zPhone } from '../utils/phone';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { testPhone } from './helpers/fixture-ids';

let app: FastifyInstance;
let n = 0;
const userIds: string[] = [];
const subIds: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'erasure-trigger-exceptions-test');

/** What the erasure's cut-off commits (account.service): 'erased' = all three; the forged states are parts of it. */
type State = 'live' | 'erased' | 'forged-marker-live' | 'forged-marker-deactivated' | 'forged-cutoff-live';
async function payer(state: State | boolean) {
  const as: State = state === true ? 'erased' : state === false ? 'live' : state;
  n += 1;
  const user = await system(() => app.prisma.user.create({ data: { phone: testPhone(), firstName: 'Trig', lastName: `U${n}`, activeRole: 'RIDER' } }));
  userIds.push(user.id);
  const rider = await system(() => app.prisma.rider.create({ data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'BICYCLE' } }));
  const now = new Date();
  const sub = await system(() => app.prisma.subscription.create({ data: { riderId: rider.id, type: 'DELIVERY_RIDER', weeklyRate: 1000, currentPeriodStart: now, currentPeriodEnd: now, nextBillingDate: now } }));
  subIds.push(sub.id);
  if (as !== 'live') {
    await system(() => app.prisma.user.update({ where: { id: user.id }, data: { phone: `deleted:${user.id}`, status: as === 'forged-marker-live' || as === 'forged-cutoff-live' ? 'ACTIVE' : 'DEACTIVATED' } }));
  }
  if (as === 'erased' || as === 'forged-cutoff-live') await system(() => app.prisma.auditLog.create({ data: { userId: user.id, action: ACCOUNT_ERASURE_CUTOFF, entity: 'User', entityId: user.id } }));
  return { userId: user.id, subId: sub.id };
}
const card = (who: { userId: string; subId: string }, extra: Partial<Prisma.PaymentInstrumentUncheckedCreateInput> = {}) => system(() => app.prisma.paymentInstrument.create({ data: {
  subscriptionId: who.subId, userId: who.userId, provider: 'simulator', environment: 'sandbox', providerAccount: 'trigger-test',
  vaultTokenSealed: Uint8Array.from(randomBytes(48)), vaultTokenDek: Uint8Array.from(randomBytes(60)), brand: 'SIMULATED', last4: '4242', expMonth: 12, expYear: 2030,
  consentVersion: 'card-on-file-v1', consentAt: new Date(), status: 'REVOKED', revokedAt: new Date(), ...extra,
} }));
const wipe = (id: string, extra: Record<string, unknown> = {}) => system(() => app.prisma.paymentInstrument.update({ where: { id }, data: { ...ERASED_CARD, ...extra } }));
const drop = (id: string) => system(() => app.prisma.paymentInstrument.delete({ where: { id } }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } }); // cascades the cards (the one DELETE PT-1 allows)
    await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  });
  await app.close();
});

describe('payment_instruments: an erased person\'s out-of-service card may be forgotten once, then deleted if nothing names it', () => {
  it('the erasure write and delete pass for an erased person', async () => {
    const who = await payer(true);
    const c = await card(who);
    const after = await wipe(c.id);
    expect([after.brand, after.last4, Buffer.from(after.vaultTokenSealed).equals(Buffer.alloc(29)), after.status]).toEqual(['ERASED', '0000', true, 'REVOKED']);
    await drop(c.id);
    expect(await system(() => app.prisma.paymentInstrument.count({ where: { id: c.id } }))).toBe(0);
  });

  it('a person who is not erased: the same write and delete are refused (the card stays frozen)', async () => {
    const who = await payer(false);
    const c = await card(who);
    await expect(wipe(c.id)).rejects.toThrow(/frozen/);
    await expect(drop(c.id)).rejects.toThrow(/cannot be deleted/);
  });

  it('an erased person: an ACTIVE card, a partial wipe, a binding change or a named card are still refused', async () => {
    const who = await payer(true);
    const active = await card(who, { status: 'ACTIVE', revokedAt: null });
    await expect(wipe(active.id)).rejects.toThrow(/frozen/);
    const c = await card(who, { status: 'EXPIRED', revokedAt: null, expiredAt: new Date() });
    await expect(system(() => app.prisma.paymentInstrument.update({ where: { id: c.id }, data: { brand: 'ERASED' } }))).rejects.toThrow(/frozen/);
    await expect(wipe(c.id, { providerAccount: 'someone-else' })).rejects.toThrow(/frozen/);
    await expect(drop(c.id)).rejects.toThrow(/cannot be deleted/); // not erased yet
    await wipe(c.id);
    const named = await card(who, { status: 'REPLACED', revokedAt: null, replacedAt: new Date(), replacedById: c.id });
    await expect(drop(c.id)).rejects.toThrow(/cannot be deleted/); // a replacement names it
    expect(named.replacedById).toBe(c.id);
  });
});

describe('mmg_payer_evidence: an erased person\'s payer hash and digest may be replaced, nothing else', () => {
  async function evidence(who: { userId: string }) {
    const id = nanoid(12);
    await system(() => app.prisma.$executeRaw`
      INSERT INTO "mmg_payer_evidence" ("id", "tenantId", "accountId", "actorRole", "payerHash", "tier", "source", "digest")
      VALUES (${id}, 'swift-default', ${who.userId}, 'RIDER', ${'h'.repeat(64)}, 'DECLARED', 'BILLING_DECLARATION', ${nanoid(32)})`);
    return id;
  }
  const erase = (id: string, extra = Prisma.empty) => system(() => app.prisma.$executeRaw`
    UPDATE "mmg_payer_evidence" SET "payerHash" = 'erased', "digest" = 'erased:' || "id" ${extra} WHERE "id" = ${id}`);

  it('passes for an erased person; refused for anyone else, for any other change and for DELETE', async () => {
    const gone = await payer(true);
    const kept = await payer(false);
    const a = await evidence(gone);
    const b = await evidence(kept);
    await expect(erase(b)).rejects.toThrow(/immutable/);
    await expect(erase(a, Prisma.sql`, "tier" = 'OBSERVED_UNVERIFIED'`)).rejects.toThrow(/immutable/);
    await expect(erase(a)).resolves.toBe(1);
    await expect(system(() => app.prisma.$executeRaw`DELETE FROM "mmg_payer_evidence" WHERE "id" = ${a}`)).rejects.toThrow(/immutable/);
  });
});

describe('EvidenceItem: a sealed item may be deleted only when its bundle is about an erased person, of a closed case or an SOS that is over, and nothing holds it', () => {
  const caseIds: string[] = [];
  const sosIds: string[] = [];
  const kase = async (subjectUserId: string, status: 'OPEN' | 'CLOSED', legalHold = false) => {
    const c = await system(() => app.prisma.incidentCase.create({ data: {
      tenantId: 'swift-default', caseNumber: `IC-TRG${nanoid(8)}`, status, ...(status === 'CLOSED' && { closedAt: new Date() }), severity: 'S3', category: 'other',
      intake: 'OPS_CREATED', subjectUserId, summary: 'trigger test', legalHold, slaAckBy: new Date(), slaDecideBy: new Date(), interimAction: 'NONE',
    } }));
    caseIds.push(c.id);
    return c.id;
  };
  const sos = async (actorUserId: string, status: 'ACTIVE' | 'RESOLVED') => {
    const a = await system(() => app.prisma.sosAlert.create({ data: { tenantId: 'swift-default', actorUserId, actorRole: 'CUSTOMER', status, ...(status === 'RESOLVED' && { resolvedAt: new Date() }) } }));
    sosIds.push(a.id);
    return a.id;
  };
  async function sealedItem(subjectUserId: string, link: { legalHold?: boolean; caseId?: string; sosAlertId?: string } = {}) {
    const bundle = await system(() => app.prisma.evidenceBundle.create({ data: { tenantId: 'swift-default', bundleNumber: `EB-${nanoid(8)}`, subjectUserId, ...link } }));
    const item = await system(() => app.prisma.evidenceItem.create({ data: { bundleId: bundle.id, kind: 'NOTE', label: 'n', content: { t: 1 }, contentHash: 'c'.repeat(64), sealedAt: new Date() } }));
    return item.id;
  }
  const del = (id: string) => system(() => app.prisma.evidenceItem.delete({ where: { id } }));

  afterAll(async () => {
    // Nothing held may outlive the suite (scanLegalHolds would freeze evidence retention for later suites).
    await system(async () => {
      await app.prisma.legalHold.deleteMany({ where: { caseId: { in: caseIds } } }).catch(() => undefined);
      await app.prisma.incidentCase.updateMany({ where: { id: { in: caseIds } }, data: { legalHold: false } });
      await app.prisma.safetyDeletionHold.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.docLegalHold.updateMany({ where: { subjectUserId: { in: userIds }, releasedAt: null }, data: { releasedAt: new Date(), releasedBy: 'admin-x', releaseReason: 'trigger test cleanup' } });
    });
  });

  it('passes for an erased, unheld subject; refused for a held bundle or a person who is not erased; UPDATE stays refused', async () => {
    const gone = await payer(true);
    const kept = await payer(false);
    const ok = await sealedItem(gone.userId);
    const held = await sealedItem(gone.userId, { legalHold: true });
    const other = await sealedItem(kept.userId);
    await expect(system(() => app.prisma.evidenceItem.update({ where: { id: ok }, data: { label: 'x' } }))).rejects.toThrow(/sealed/);
    await expect(del(held)).rejects.toThrow(/sealed/);
    await expect(del(other)).rejects.toThrow(/sealed/);
    await del(ok);
    expect(await system(() => app.prisma.evidenceItem.count({ where: { id: ok } }))).toBe(0);
  });

  it('a sealed item of a closed case and of an SOS that is over may go; of an open case or a live SOS it stays', async () => {
    const gone = await payer(true);
    const closedCase = await sealedItem(gone.userId, { caseId: await kase(gone.userId, 'CLOSED') });
    const overSos = await sealedItem(gone.userId, { sosAlertId: await sos(gone.userId, 'RESOLVED') });
    const openCase = await sealedItem(gone.userId, { caseId: await kase(gone.userId, 'OPEN') });
    const liveSos = await sealedItem(gone.userId, { sosAlertId: await sos(gone.userId, 'ACTIVE') });
    await expect(del(openCase)).rejects.toThrow(/sealed/);
    await expect(del(liveSos)).rejects.toThrow(/sealed/);
    await del(closedCase);
    await del(overSos);
  });

  it('a hold keeps a sealed item: a legal hold on its closed case, or a safety deletion hold or document legal hold on the person', async () => {
    const byHoldRow = await payer(true);
    const caseId = await kase(byHoldRow.userId, 'CLOSED');
    await system(() => app.prisma.legalHold.create({ data: { tenantId: 'swift-default', caseId, placedBy: 'ops-x', reason: 'trigger test' } }));
    await expect(del(await sealedItem(byHoldRow.userId, { caseId }))).rejects.toThrow(/sealed/);

    const bySafetyHold = await payer(true);
    await system(() => app.prisma.safetyDeletionHold.create({ data: { userId: bySafetyHold.userId, reasons: ['SOS_OPEN'], holdRefs: {}, purpose: 'test', fields: [], ownerRole: 'DRIVER', reviewBy: new Date(Date.now() + 86_400_000), purgeBy: new Date(Date.now() + 86_400_000) } }));
    await expect(del(await sealedItem(bySafetyHold.userId))).rejects.toThrow(/sealed/);

    const byDocHold = await payer(true);
    await system(() => app.prisma.docLegalHold.create({ data: { tenantId: 'swift-default', subjectUserId: byDocHold.userId, reason: 'trigger test', ownerId: 'admin-x', placedBy: 'admin-x', reviewBy: new Date(Date.now() + 86_400_000) } }));
    await expect(del(await sealedItem(byDocHold.userId))).rejects.toThrow(/sealed/);
  });

  // [REVIEW-M S3-1 parity] The database keeps a sealed item exactly where the app keeps the case whole
  // (erasure-coverage CASE_KEPT_WHOLE). One bundle per SOS, so the bundle's own legal hold is already checked.
  it('[REVIEW-M S3-1 parity] a document legal hold raised from its closed case keeps the item (the hold is about someone else)', async () => {
    const gone = await payer(true);
    const other = await payer(false);
    const docHeldCase = await kase(gone.userId, 'CLOSED');
    await system(() => app.prisma.docLegalHold.create({ data: { tenantId: 'swift-default', subjectUserId: other.userId, incidentCaseId: docHeldCase, reason: 'trigger test', ownerId: 'admin-x', placedBy: 'admin-x', reviewBy: new Date(Date.now() + 86_400_000) } }));
    await expect(del(await sealedItem(gone.userId, { caseId: docHeldCase }))).rejects.toThrow(/sealed/);
  });

  it('[REVIEW-M S3-1 parity] the SOS is over but a case on it is kept whole (open, or closed under its flag, a legal_holds row or a document hold): the item stays; closed and unheld: it may go', async () => {
    const gone = await payer(true);
    const other = await payer(false);
    const onSos = async (status: 'OPEN' | 'CLOSED', hold?: 'flag' | 'row' | 'doc') => {
      const sosAlertId = await sos(gone.userId, 'RESOLVED');
      const caseId = await kase(other.userId, status, hold === 'flag');
      await system(() => app.prisma.incidentCase.update({ where: { id: caseId }, data: { sosAlertId } }));
      if (hold === 'row') await system(() => app.prisma.legalHold.create({ data: { tenantId: 'swift-default', caseId, placedBy: 'ops-x', reason: 'trigger test' } }));
      if (hold === 'doc') await system(() => app.prisma.docLegalHold.create({ data: { tenantId: 'swift-default', subjectUserId: other.userId, incidentCaseId: caseId, reason: 'trigger test', ownerId: 'admin-x', placedBy: 'admin-x', reviewBy: new Date(Date.now() + 86_400_000) } }));
      return sealedItem(gone.userId, { sosAlertId });
    };
    await expect(del(await onSos('OPEN'))).rejects.toThrow(/sealed/);
    await expect(del(await onSos('CLOSED', 'flag'))).rejects.toThrow(/sealed/);
    await expect(del(await onSos('CLOSED', 'row'))).rejects.toThrow(/sealed/);
    await expect(del(await onSos('CLOSED', 'doc'))).rejects.toThrow(/sealed/);
    await del(await onSos('CLOSED'));
  });
});

describe('[COORD] a forged marker opens nothing: the database gate is the erasure\'s whole cut-off, not the phone', () => {
  for (const forged of ['forged-marker-live', 'forged-marker-deactivated', 'forged-cutoff-live'] as const) {
    it(`${forged}: the card, the payer evidence and a sealed item all stay immutable`, async () => {
      const who = await payer(forged);
      const c = await card(who);
      await expect(wipe(c.id)).rejects.toThrow(/frozen/);
      await expect(drop(c.id)).rejects.toThrow(/cannot be deleted/);
      const evidenceId = nanoid(12);
      await system(() => app.prisma.$executeRaw`
        INSERT INTO "mmg_payer_evidence" ("id", "tenantId", "accountId", "actorRole", "payerHash", "tier", "source", "digest")
        VALUES (${evidenceId}, 'swift-default', ${who.userId}, 'RIDER', ${'h'.repeat(64)}, 'DECLARED', 'BILLING_DECLARATION', ${nanoid(32)})`);
      await expect(system(() => app.prisma.$executeRaw`
        UPDATE "mmg_payer_evidence" SET "payerHash" = 'erased', "digest" = 'erased:' || "id" WHERE "id" = ${evidenceId}`)).rejects.toThrow(/immutable/);
      const bundle = await system(() => app.prisma.evidenceBundle.create({ data: { tenantId: 'swift-default', bundleNumber: `EB-${nanoid(8)}`, subjectUserId: who.userId } }));
      const item = await system(() => app.prisma.evidenceItem.create({ data: { bundleId: bundle.id, kind: 'NOTE', label: 'n', content: { t: 1 }, contentHash: 'c'.repeat(64), sealedAt: new Date() } }));
      await expect(system(() => app.prisma.evidenceItem.delete({ where: { id: item.id } }))).rejects.toThrow(/sealed/);
      // The app's gate is the same function: it says no too.
      expect(await system(() => app.prisma.$queryRaw<Array<{ open: boolean }>>`SELECT swift_erased_person(${who.userId}) AS "open"`)).toEqual([{ open: false }]);
    });
  }
});

describe('the app opens these writes through the same gate, so a closed gate never wedges the re-sweep', () => {
  it('an account erased before the cut-off row existed: the passes skip the wipes (the card and payer hash stay) and do not fail', async () => {
    const legacy = await payer('forged-marker-deactivated');
    const c = await card(legacy, { status: 'EXPIRED', revokedAt: null, expiredAt: new Date() });
    const evidenceId = nanoid(12);
    await system(() => app.prisma.$executeRaw`
      INSERT INTO "mmg_payer_evidence" ("id", "tenantId", "accountId", "actorRole", "payerHash", "tier", "source", "digest")
      VALUES (${evidenceId}, 'swift-default', ${legacy.userId}, 'RIDER', ${'h'.repeat(64)}, 'DECLARED', 'BILLING_DECLARATION', ${nanoid(32)})`);
    await expect(system(() => retireCardsAndSessions(app.prisma, legacy.userId))).resolves.toMatchObject({ wiped: 0, deleted: 0 });
    await expect(system(() => deidentifyCaseRecords(app.prisma, legacy.userId))).resolves.toBeUndefined();
    expect((await system(() => app.prisma.paymentInstrument.findUniqueOrThrow({ where: { id: c.id } }))).brand).toBe('SIMULATED');
    expect(await system(() => app.prisma.$queryRaw`SELECT "payerHash" FROM "mmg_payer_evidence" WHERE "id" = ${evidenceId}`)).toEqual([{ payerHash: 'h'.repeat(64) }]);
  });
});

describe('[COORD] no input path can write the erasure marker', () => {
  it('every phone a person or staff types is normalised to + and digits: "deleted:<id>" can never come out', () => {
    for (const raw of ['deleted:cm123abc', 'deleted:+5926001000', ' deleted:00000000 ', 'DELETED:x1', 'deleted:']) {
      expect(normalizePhone(raw)).toMatch(/^\+?[0-9]*$/);
      const parsed = zPhone.safeParse(raw);
      if (parsed.success) expect(parsed.data.startsWith('deleted:')).toBe(false);
    }
  });

  it('the only code that writes a deleted:<id> phone is the account erasure (account.service.ts)', () => {
    const root = join(process.cwd(), 'src');
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { if (name !== '__tests__') walk(path); continue; }
        if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
        const text = readFileSync(path, 'utf8');
        if (/phone:\s*`deleted:/.test(text) || /phone:\s*'deleted:/.test(text) || /"phone"\s*=\s*'deleted:/.test(text)) writers.push(path.slice(root.length + 1));
      }
    };
    walk(root);
    expect(writers).toEqual(['modules/user/account.service.ts']);
  });
});
