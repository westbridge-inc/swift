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
import { ERASED_CARD } from '../modules/user/erasure-coverage';
import { testPhone } from './helpers/fixture-ids';

const PHONE = testPhone();
let app: FastifyInstance;
let n = 0;
const userIds: string[] = [];
const subIds: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'erasure-trigger-exceptions-test');

async function payer(erased: boolean) {
  n += 1;
  const user = await system(() => app.prisma.user.create({ data: { phone: `${PHONE}${n}`, firstName: 'Trig', lastName: `U${n}`, activeRole: 'RIDER' } }));
  userIds.push(user.id);
  const rider = await system(() => app.prisma.rider.create({ data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'BICYCLE' } }));
  const now = new Date();
  const sub = await system(() => app.prisma.subscription.create({ data: { riderId: rider.id, type: 'DELIVERY_RIDER', weeklyRate: 1000, currentPeriodStart: now, currentPeriodEnd: now, nextBillingDate: now } }));
  subIds.push(sub.id);
  if (erased) await system(() => app.prisma.user.update({ where: { id: user.id }, data: { phone: `deleted:${user.id}`, status: 'DEACTIVATED' } }));
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

describe('EvidenceItem: a sealed item may be deleted only when its bundle is about an erased person and not held', () => {
  async function sealedItem(subjectUserId: string, legalHold = false) {
    const bundle = await system(() => app.prisma.evidenceBundle.create({ data: { tenantId: 'swift-default', bundleNumber: `EB-${nanoid(8)}`, subjectUserId, legalHold } }));
    const item = await system(() => app.prisma.evidenceItem.create({ data: { bundleId: bundle.id, kind: 'NOTE', label: 'n', content: { t: 1 }, contentHash: 'c'.repeat(64), sealedAt: new Date() } }));
    return item.id;
  }
  const del = (id: string) => system(() => app.prisma.evidenceItem.delete({ where: { id } }));

  it('passes for an erased, unheld subject; refused for a held bundle or a person who is not erased; UPDATE stays refused', async () => {
    const gone = await payer(true);
    const kept = await payer(false);
    const ok = await sealedItem(gone.userId);
    const held = await sealedItem(gone.userId, true);
    const other = await sealedItem(kept.userId);
    await expect(system(() => app.prisma.evidenceItem.update({ where: { id: ok }, data: { label: 'x' } }))).rejects.toThrow(/sealed/);
    await expect(del(held)).rejects.toThrow(/sealed/);
    await expect(del(other)).rejects.toThrow(/sealed/);
    await del(ok);
    expect(await system(() => app.prisma.evidenceItem.count({ where: { id: ok } }))).toBe(0);
  });
});
