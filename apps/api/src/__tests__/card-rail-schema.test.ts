/**
 * [PT-1] The card rail v2 tables' database contract, graded on the database
 * itself — a MIGRATED one (CI's API job replays every migration, and this
 * suite installs nothing: what it finds is what 20260925000400 built).
 *
 * payment_instruments, card_sessions and card_observations are walled like
 * every tenant table (RLS enabled AND forced, the canonical policy, both
 * registries) and a row's tenant is its payer's (lineage). The money laws live
 * in the rows: one ACTIVE card per subscription and one live session per
 * purpose; an instrument's binding, sealed token and card facts are frozen,
 * and how it left service is written once; nothing deletes a card but its own
 * subscription's deletion; a session's binding, price and state are frozen and
 * its one-use markers move from empty to a value once; observations are
 * append-only. (DS285 F1, F2, F3, F5, F6, F7 are graded here.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { prismaPlugin, TENANT_MODEL_NAMES } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { TENANT_LINEAGE_TABLES, TENANT_TABLES, policyPredicateIsCanonical } from '../lib/tenant-rls';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const PHONE = `+59200742${String(Date.now()).slice(-5)}`;
const REVIEW = `pt1s-${RUN.toLowerCase()}`;
const PRODUCTION = 'swift-default';
const TABLES = ['payment_instruments', 'card_sessions', 'card_observations'] as const;
let app: FastifyInstance;
const people = { review: { userId: '', subId: '' }, prod: { userId: '', subId: '' } };
const subIds: string[] = [];
const userIds: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'pt1-card-schema-test');

const sealed = () => ({ vaultTokenSealed: Uint8Array.from(randomBytes(48)), vaultTokenDek: Uint8Array.from(randomBytes(60)) });
const instrumentData = (who: { userId: string; subId: string }, extra: Partial<Prisma.PaymentInstrumentUncheckedCreateInput> = {}): Prisma.PaymentInstrumentUncheckedCreateInput => ({
  subscriptionId: who.subId, userId: who.userId, provider: 'simulator', environment: 'sandbox', providerAccount: 'schema-test',
  ...sealed(), brand: 'SIMULATED', last4: '4242', expMonth: 12, expYear: 2030, consentVersion: 'card-on-file-v1', consentAt: new Date(),
  ...extra,
});
const sessionData = (who: { userId: string; subId: string }, extra: Partial<Prisma.CardSessionUncheckedCreateInput> = {}): Prisma.CardSessionUncheckedCreateInput => ({
  subscriptionId: who.subId, userId: who.userId, purpose: 'ENROLL', provider: 'simulator', environment: 'sandbox', providerAccount: 'schema-test',
  stateHash: 'ab'.repeat(32), expiresAt: new Date(Date.now() + 15 * 60 * 1000), consentVersion: 'card-on-file-v1', consentAt: new Date(),
  ...extra,
});
const observationData = (extra: Partial<Prisma.CardObservationUncheckedCreateInput>): Prisma.CardObservationUncheckedCreateInput => ({
  source: 'RETURN', provider: 'simulator', environment: 'sandbox', rawSha256: 'cd'.repeat(32), parsedStatus: 'SUCCEEDED', verdict: 'ACCEPTED',
  ...extra,
});

async function payer(tenantId: string, n: number) {
  const user = await system(() => app.prisma.user.create({
    data: { phone: `${PHONE}${n}`, firstName: 'Schema', lastName: tenantId, activeRole: 'RIDER', tenantId, isSynthetic: tenantId !== PRODUCTION },
  }));
  userIds.push(user.id);
  const rider = await system(() => app.prisma.rider.create({ data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'BICYCLE' } }));
  const now = new Date();
  const sub = await system(() => app.prisma.subscription.create({
    data: { riderId: rider.id, type: 'DELIVERY_RIDER', weeklyRate: 1000, currentPeriodStart: now, currentPeriodEnd: now, nextBillingDate: now },
  }));
  subIds.push(sub.id);
  return { userId: user.id, subId: sub.id };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.ready();
  await system(() => app.prisma.tenant.create({ data: { id: REVIEW, name: 'Card schema fiction', slug: REVIEW, kind: 'REVIEW', purgeProtected: true } }));
  people.review = await payer(REVIEW, 1);
  people.prod = await payer(PRODUCTION, 2);
});

afterAll(async () => {
  await system(async () => {
    // Deleting the subscriptions cascades their cards and sessions: the teardown is itself the cascade path.
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.prisma.tenant.updateMany({ where: { id: REVIEW }, data: { purgeProtected: false } });
    await app.prisma.tenant.deleteMany({ where: { id: REVIEW } });
  });
  await app.close();
});

describe('[PT-1] the three tables are walled like every tenant table', () => {
  it('are in both registries, and each has a lineage rule to its payer (DS285 F1)', () => {
    for (const t of TABLES) expect(TENANT_TABLES).toContain(t);
    for (const m of ['paymentInstrument', 'cardSession', 'cardObservation']) expect(TENANT_MODEL_NAMES).toContain(m);
    expect(TENANT_LINEAGE_TABLES.filter((r) => (TABLES as readonly string[]).includes(r.table)).map((r) => [r.table, r.trigger, r.parent, r.fk])).toEqual([
      ['payment_instruments', 'payment_instruments_tenant_matches_user', 'users', 'userId'],
      ['card_sessions', 'card_sessions_tenant_matches_user', 'users', 'userId'],
      ['card_observations', 'card_observations_tenant_matches_owner', 'card_sessions', 'sessionId'],
    ]);
  });

  it('RLS is ENABLED and FORCED under exactly one canonical policy on each', async () => {
    for (const t of TABLES) {
      const [cls] = await app.prisma.$queryRaw<{ enabled: boolean; forced: boolean }[]>(Prisma.sql`
        SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = ${t}`);
      expect(cls, t).toEqual({ enabled: true, forced: true });
      const policies = await app.prisma.$queryRaw<{ name: string; qual: string | null; withCheck: string | null }[]>(Prisma.sql`
        SELECT p.polname AS name, pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS "withCheck"
        FROM pg_policy p WHERE p.polrelid = ${`public.${t}`}::regclass`);
      expect(policies.map((p) => p.name), t).toEqual(['tenant_isolation']);
      expect(policyPredicateIsCanonical(policies[0]!.qual)).toBe(true);
      expect(policyPredicateIsCanonical(policies[0]!.withCheck)).toBe(true);
    }
  });

  it('carries its guards: the triggers and the row laws, by name', async () => {
    const triggers = await app.prisma.$queryRaw<{ rel: string; tgname: string }[]>(Prisma.sql`
      SELECT c.relname AS rel, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = ANY(${[...TABLES]}) AND NOT t.tgisinternal ORDER BY 1, 2`);
    expect(triggers.map((t) => `${t.rel}.${t.tgname}`)).toEqual([
      'card_observations.card_observations_no_mutation',
      'card_observations.card_observations_tenant_matches_owner',
      // [#1393] A Pay-now session held for payment confirmation keeps its source identity.
      'card_sessions.billing_confirmation_source_immutable',
      'card_sessions.card_sessions_frozen',
      // [PT-4] The provider's transaction reference, the one void / refund / booking claim and a finance
      // decision only move forward; a booking never stands beside a void or refund that may have worked.
      'card_sessions.card_sessions_provider_actions',
      'card_sessions.card_sessions_tenant_matches_user',
      'payment_instruments.payment_instruments_frozen',
      'payment_instruments.payment_instruments_no_delete',
      'payment_instruments.payment_instruments_tenant_matches_user',
    ]);
    const checks = await app.prisma.$queryRaw<{ conname: string }[]>(Prisma.sql`
      SELECT conname FROM pg_constraint WHERE contype = 'c'
        AND conrelid IN ('public.payment_instruments'::regclass, 'public.card_sessions'::regclass, 'public.card_observations'::regclass) ORDER BY 1`);
    expect(checks.map((c) => c.conname)).toEqual([
      'card_observations_digest_check', 'card_sessions_binding_check', 'card_sessions_currency_check',
      // [PT-4] the provider-action markers' shapes (see the migration card_session_provider_actions)
      'card_sessions_provider_ref_check',
      'card_sessions_purpose_shape_check',
      'card_sessions_refund_needs_ref_check', 'card_sessions_refund_state_check', 'card_sessions_resolution_check',
      'card_sessions_state_hash_check',
      'card_sessions_void_needs_ref_check', 'card_sessions_void_state_check',
      'payment_instruments_binding_check',
      'payment_instruments_display_check', 'payment_instruments_sealed_check', 'payment_instruments_status_time_check',
    ]);
    const partial = await app.prisma.$queryRaw<{ indexname: string }[]>(Prisma.sql`
      SELECT indexname FROM pg_indexes WHERE indexname IN ('payment_instruments_one_active_per_subscription', 'card_sessions_one_live_per_purpose') ORDER BY 1`);
    expect(partial.map((i) => i.indexname)).toEqual(['card_sessions_one_live_per_purpose', 'payment_instruments_one_active_per_subscription']);
  });
});

describe('[DS285 F1] a row’s tenant is its payer’s', () => {
  it('system mode (the default = unstamped) is DERIVED from the payer; a bound caller is stamped; a disagreement is refused', async () => {
    const card = await system(() => app.prisma.paymentInstrument.create({ data: instrumentData(people.review, { status: 'REVOKED', revokedAt: new Date() }) }));
    expect(card.tenantId).toBe(REVIEW);
    const session = await system(() => app.prisma.cardSession.create({ data: sessionData(people.review, { status: 'EXPIRED' }) }));
    expect(session.tenantId).toBe(REVIEW);
    const bound = await runWithTenant(REVIEW, () => app.prisma.cardSession.create({ data: sessionData(people.review, { status: 'CANCELLED' }) }));
    expect(bound.tenantId).toBe(REVIEW);
    // The default means "unstamped", never "production": written explicitly, it is still derived.
    const unstamped = await system(() => app.prisma.cardSession.create({ data: sessionData(people.review, { tenantId: PRODUCTION, status: 'CANCELLED' }) }));
    expect(unstamped.tenantId).toBe(REVIEW);
    // A real tenant that is not the payer's is refused, on either table.
    await expect(system(() => app.prisma.cardSession.create({ data: sessionData(people.prod, { tenantId: REVIEW, status: 'CANCELLED' }) })))
      .rejects.toThrow(/lineage/);
    await expect(system(() => app.prisma.paymentInstrument.create({ data: instrumentData(people.prod, { tenantId: REVIEW, status: 'REVOKED', revokedAt: new Date() }) })))
      .rejects.toThrow(/lineage/);
  });

  it('an observation inherits its session, or — with no session (an off-session charge) — its instrument; with neither it is refused', async () => {
    const session = await system(() => app.prisma.cardSession.create({ data: sessionData(people.review, { status: 'FAILED' }) }));
    const card = await system(() => app.prisma.paymentInstrument.create({ data: instrumentData(people.review, { status: 'EXPIRED', expiredAt: new Date() }) }));
    expect((await system(() => app.prisma.cardObservation.create({ data: observationData({ sessionId: session.id }) }))).tenantId).toBe(REVIEW);
    expect((await system(() => app.prisma.cardObservation.create({ data: observationData({ source: 'CHARGE', instrumentId: card.id }) }))).tenantId).toBe(REVIEW);
    await expect(system(() => app.prisma.cardObservation.create({ data: observationData({ source: 'CHARGE' }) }))).rejects.toThrow(/lineage/);
  });
});

describe('[C6] one ACTIVE card per subscription; one live session per purpose', () => {
  it('a second ACTIVE card is refused; a live (OPEN or UNKNOWN) session blocks a second of its purpose, not of the other', async () => {
    const who = await payer(PRODUCTION, 3);
    await system(() => app.prisma.paymentInstrument.create({ data: instrumentData(who) }));
    await expect(system(() => app.prisma.paymentInstrument.create({ data: instrumentData(who) }))).rejects.toThrow(/Unique constraint|payment_instruments_one_active_per_subscription/);
    await system(() => app.prisma.cardSession.create({ data: sessionData(who, { status: 'UNKNOWN' }) }));
    await expect(system(() => app.prisma.cardSession.create({ data: sessionData(who) }))).rejects.toThrow(/Unique constraint|card_sessions_one_live_per_purpose/);
    await expect(system(() => app.prisma.cardSession.create({
      data: sessionData(who, { purpose: 'PAY_NOW', amount: 1000, currencyCode: 'GYD', periodStart: new Date(), consentVersion: null, consentAt: null }),
    }))).resolves.toMatchObject({ purpose: 'PAY_NOW', status: 'OPEN' });
  });
});

describe('[C2 · DS285 F5 · F6] an instrument: frozen binding, write-once exits, no DELETE', () => {
  it('its binding, token and card facts never change once written', async () => {
    const who = await payer(PRODUCTION, 4);
    const card = await system(() => app.prisma.paymentInstrument.create({ data: instrumentData(who) }));
    for (const change of [
      { provider: 'another' }, { environment: 'live' }, { providerAccount: 'someone-else' },
      { vaultTokenSealed: Uint8Array.from(randomBytes(48)) }, { last4: '0000' }, { expYear: 2031 }, { userId: people.prod.userId },
    ]) {
      await expect(system(() => app.prisma.paymentInstrument.update({ where: { id: card.id }, data: change })), JSON.stringify(Object.keys(change))).rejects.toThrow(/frozen/);
    }
  });

  it('how it left service is written once: no backdating a revocation, no new revoker, no status back to ACTIVE', async () => {
    const who = await payer(PRODUCTION, 5);
    const card = await system(() => app.prisma.paymentInstrument.create({ data: instrumentData(who) }));
    await system(() => app.prisma.paymentInstrument.update({ where: { id: card.id }, data: { status: 'REVOKED', revokedAt: new Date(), revokedBy: who.userId } }));
    await expect(system(() => app.prisma.paymentInstrument.update({ where: { id: card.id }, data: { revokedAt: new Date(Date.now() - 86_400_000) } }))).rejects.toThrow(/written once/);
    await expect(system(() => app.prisma.paymentInstrument.update({ where: { id: card.id }, data: { revokedBy: 'someone-else' } }))).rejects.toThrow(/written once/);
    await expect(system(() => app.prisma.paymentInstrument.update({ where: { id: card.id }, data: { status: 'ACTIVE' } }))).rejects.toThrow(/terminal/);
    // A replacement names its successor once (empty -> value), then never again.
    const other = await system(() => app.prisma.paymentInstrument.create({ data: instrumentData(who, { status: 'REPLACED', replacedAt: new Date() }) }));
    await system(() => app.prisma.paymentInstrument.update({ where: { id: other.id }, data: { replacedById: card.id } }));
    await expect(system(() => app.prisma.paymentInstrument.update({ where: { id: other.id }, data: { replacedById: other.id } }))).rejects.toThrow(/written once/);
  });

  it('a card is never deleted directly; its subscription’s deletion takes it with the subscription’s payments', async () => {
    const who = await payer(PRODUCTION, 6);
    const card = await system(() => app.prisma.paymentInstrument.create({ data: instrumentData(who) }));
    await expect(system(() => app.prisma.paymentInstrument.delete({ where: { id: card.id } }))).rejects.toThrow(/REVOKED or EXPIRED/);
    await expect(system(() => app.prisma.$executeRaw`DELETE FROM payment_instruments WHERE id = ${card.id}`)).rejects.toThrow(/REVOKED or EXPIRED/);
    await system(() => app.prisma.subscription.delete({ where: { id: who.subId } }));
    expect(await system(() => app.prisma.paymentInstrument.findUnique({ where: { id: card.id } }))).toBeNull();
  });
});

describe('[C8 · DS285 F2] a session: bound for life, one-use markers written once', () => {
  it('its payer, purpose, binding, price, state and window never change', async () => {
    const who = await payer(PRODUCTION, 7);
    const s = await system(() => app.prisma.cardSession.create({ data: sessionData(who, { purpose: 'PAY_NOW', amount: 1000, currencyCode: 'GYD', periodStart: new Date(), consentVersion: null, consentAt: null }) }));
    for (const change of [
      { amount: 1 }, { currencyCode: 'USD' }, { provider: 'another' }, { providerAccount: 'x' }, { stateHash: 'ef'.repeat(32) },
      { expiresAt: new Date(Date.now() + 86_400_000) }, { userId: people.prod.userId }, { idempotencyKey: 'rewritten-key' },
    ]) {
      await expect(system(() => app.prisma.cardSession.update({ where: { id: s.id }, data: change })), JSON.stringify(Object.keys(change))).rejects.toThrow(/bound/);
    }
  });

  it('the accepted return, the confirmation, what it produced and the provider page move from empty to a value ONCE — never rewritten, never cleared', async () => {
    const who = await payer(PRODUCTION, 8);
    const s = await system(() => app.prisma.cardSession.create({ data: sessionData(who) }));
    await system(() => app.prisma.cardSession.update({
      where: { id: s.id },
      data: { returnedAt: new Date(), providerSessionRef: 'sim_one', hostedUrl: '/page/one', instrumentId: `inst-${RUN}`, paymentId: `pay-${RUN}` },
    }));
    for (const change of [
      { returnedAt: null }, { returnedAt: new Date(Date.now() - 60_000) }, { providerSessionRef: 'sim_two' }, { hostedUrl: null },
      { instrumentId: `other-${RUN}` }, { paymentId: null },
    ]) {
      await expect(system(() => app.prisma.cardSession.update({ where: { id: s.id }, data: change })), JSON.stringify(change)).rejects.toThrow(/one-use marker/);
    }
    await system(() => app.prisma.cardSession.update({ where: { id: s.id }, data: { status: 'SUCCEEDED', confirmedAt: new Date() } }));
    await expect(system(() => app.prisma.cardSession.update({ where: { id: s.id }, data: { confirmedAt: new Date(Date.now() + 1000) } }))).rejects.toThrow(/one-use marker/);
    await expect(system(() => app.prisma.cardSession.update({ where: { id: s.id }, data: { status: 'OPEN' } }))).rejects.toThrow(/terminal/);
  });

  it('HELD is not terminal: a person may resolve it', async () => {
    const who = await payer(PRODUCTION, 9);
    const s = await system(() => app.prisma.cardSession.create({ data: sessionData(who, { status: 'HELD', confirmedAt: new Date() }) }));
    await expect(system(() => app.prisma.cardSession.update({ where: { id: s.id }, data: { status: 'FAILED' } }))).resolves.toMatchObject({ status: 'FAILED' });
  });
});

describe('observations are evidence: append-only, and their status is a closed set (DS285 F3)', () => {
  it('UPDATE and DELETE are refused', async () => {
    const s = await system(() => app.prisma.cardSession.create({ data: sessionData(people.prod, { status: 'CANCELLED' }) }));
    const o = await system(() => app.prisma.cardObservation.create({ data: observationData({ sessionId: s.id }) }));
    await expect(system(() => app.prisma.cardObservation.update({ where: { id: o.id }, data: { verdict: 'REJECTED_STATE' } }))).rejects.toThrow(/append-only/);
    await expect(system(() => app.prisma.cardObservation.delete({ where: { id: o.id } }))).rejects.toThrow(/append-only/);
  });

  it('a status outside the closed set is refused by the database itself', async () => {
    const s = await system(() => app.prisma.cardSession.create({ data: sessionData(people.prod, { status: 'CANCELLED' }) }));
    await expect(system(() => app.prisma.$executeRaw`
      INSERT INTO card_observations (id, source, "sessionId", provider, environment, "rawSha256", "parsedStatus", verdict)
      VALUES (${`obs-${RUN}`}, 'RETURN', ${s.id}, 'simulator', 'sandbox', ${'cd'.repeat(32)}, 'requires-action', 'ACCEPTED')`))
      .rejects.toThrow(/invalid input value for enum/);
  });
});

describe('the row laws refuse malformed money and card facts (DS285 F7)', () => {
  it('display facts, binding, sealing, currency, price shape, consent and digests', async () => {
    const who = await payer(PRODUCTION, 10);
    const refused = async (label: string, fn: () => Promise<unknown>) => expect(system(fn), label).rejects.toThrow(/check constraint/i);
    await refused('last4 letters', () => app.prisma.paymentInstrument.create({ data: instrumentData(who, { last4: 'abcd' }) }));
    await refused('month 13', () => app.prisma.paymentInstrument.create({ data: instrumentData(who, { expMonth: 13 }) }));
    await refused('environment prod', () => app.prisma.paymentInstrument.create({ data: instrumentData(who, { environment: 'prod' }) }));
    await refused('provider name', () => app.prisma.paymentInstrument.create({ data: instrumentData(who, { provider: 'Bad Name' }) }));
    await refused('an UNWRAPPED 32-byte key', () => app.prisma.paymentInstrument.create({ data: instrumentData(who, { vaultTokenDek: Uint8Array.from(randomBytes(32)) }) }));
    await refused('REVOKED with no revokedAt', () => app.prisma.paymentInstrument.create({ data: instrumentData(who, { status: 'REVOKED' }) }));
    await refused('currency gyd', () => app.prisma.cardSession.create({ data: sessionData(who, { purpose: 'PAY_NOW', amount: 1000, currencyCode: 'gyd', periodStart: new Date(), consentVersion: null, consentAt: null }) }));
    await refused('PAY_NOW with no price', () => app.prisma.cardSession.create({ data: sessionData(who, { purpose: 'PAY_NOW', consentVersion: null, consentAt: null }) }));
    await refused('PAY_NOW of zero', () => app.prisma.cardSession.create({ data: sessionData(who, { purpose: 'PAY_NOW', amount: 0, currencyCode: 'GYD', periodStart: new Date(), consentVersion: null, consentAt: null }) }));
    await refused('ENROLL with no consent', () => app.prisma.cardSession.create({ data: sessionData(who, { consentVersion: null, consentAt: null }) }));
    await refused('ENROLL with a price', () => app.prisma.cardSession.create({ data: sessionData(who, { amount: 1000, currencyCode: 'GYD', periodStart: new Date() }) }));
    await refused('state hash not hex', () => app.prisma.cardSession.create({ data: sessionData(who, { stateHash: 'z'.repeat(64) }) }));
    const s = await system(() => app.prisma.cardSession.create({ data: sessionData(who, { status: 'CANCELLED' }) }));
    await refused('digest not hex', () => app.prisma.cardObservation.create({ data: observationData({ sessionId: s.id, rawSha256: 'Z'.repeat(64) }) }));
  });
});

describe('[AX297 F4] the index on the EXISTING subscription_payments table is built online', () => {
  const MIGRATIONS = join(process.cwd(), 'prisma/migrations');
  const FOUNDATION = '20260925000400_card_rail_v2';
  const ONLINE = '20260925000410_card_rail_v2_payment_instrument_index';
  /** What PostgreSQL executes: the file without its comment lines. */
  const executable = (dir: string) => readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8')
    .split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n').trim();

  it('its own migration is exactly ONE statement, CREATE INDEX CONCURRENTLY, with nothing that would wrap it in a transaction', () => {
    const sql = executable(ONLINE);
    // Prisma sends a multi-statement file as one implicit transaction, where CONCURRENTLY is forbidden.
    expect(sql.match(/;/g)).toHaveLength(1);
    expect(sql.match(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/g)).toHaveLength(1);
    expect(sql).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS "subscription_payments_instrumentId_idx"\s+ON "subscription_payments"\("instrumentId"\);$/);
    expect(sql).not.toMatch(/\b(?:BEGIN|COMMIT|SET|RESET)\b/);
  });

  it('the foundation migration builds indexes only on its three NEW (empty) tables, and runs before the online one', () => {
    const creates = executable(FOUNDATION).match(/CREATE (?:UNIQUE )?INDEX[^;]*;/g) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const create of creates) expect(create, create).toMatch(/ON "(?:payment_instruments|card_sessions|card_observations)"/);
    expect(executable(FOUNDATION)).not.toMatch(/INDEX[^;]*ON "subscription_payments"/);
    const order = readdirSync(MIGRATIONS).filter((d) => d.startsWith('2026')).sort();
    expect(order.indexOf(FOUNDATION)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(ONLINE)).toBeGreaterThan(order.indexOf(FOUNDATION));
  });

  it('on the migrated database the index exists and is VALID (a failed online build leaves an invalid one)', async () => {
    const rows = await system(() => app.prisma.$queryRaw<Array<{ valid: boolean; ready: boolean }>>`
      SELECT i."indisvalid" AS valid, i."indisready" AS ready
      FROM pg_index i JOIN pg_class c ON c.oid = i."indexrelid"
      WHERE c.relname = 'subscription_payments_instrumentId_idx'`);
    expect(rows).toEqual([{ valid: true, ready: true }]);
  });
});
