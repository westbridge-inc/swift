import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type UserRole } from '@prisma/client';
import { runAsSystem, runWithTenant, getTenantId } from '../../../plugins/tenant-context';
import { assertTenantWall, attestationOf, readRlsFacts } from '../../../lib/rls-attestation';
import { generateOrderNumber } from '../../../utils/markup';
import { IdentityService, clusterMemberIds } from '../../integrity/identity.service';
import { normalizePhone } from '../../integrity/normalize';
import { releaseSan } from '../../billing/san.service';
import type { DrillTarget } from './guard';

/**
 * [STG-DRILLS D5/D6] The staging drill fixtures.
 *
 * Each fixture is the condition one skipped journey needs and staging cannot
 * produce by itself, built the way the app builds it — the app's own client
 * (tenant scoping, lineage and synthetic-derivation triggers all apply), the
 * real identity engine, and the tenant-wall assertion every tenant-creating
 * path must make:
 *
 *   D5     a partner applicant in the test admin's own identity cluster
 *          (a STRONG phone edge through IdentityService.capture), so ADMIN-01
 *          can prove the admin is recused and the second admin decides;
 *   D6     a second tenant `swift-drill` with a store, a customer, an order
 *          and a partner, for PLAT-01's cross-tenant denial matrix.
 *
 * [AX324 R2] There are no billing fixtures. D2/D3 made two stores whose trial
 * had ended 15 days ago for the billing jobs to bill — but those jobs are
 * platform-wide sweeps that cannot be scoped to DRILL accounts without a new
 * production parameter (jobs.ts), so no drill may run them and a backdated
 * store would serve nothing. VEND-04's billing path is automated-only on
 * staging (GOLD-7), and MONEY-03's agent-receipt case is the dormant
 * back-office rail check, which needs no bill (the journey runs it on its own
 * roster store).
 *
 * Recognisable: every account is named DRILL-<run id> and carries
 * users.syntheticRunId = DRILL-<run id>; every phone is in +592048…, a block
 * no subscriber can hold (+5920…) and nothing else in the repository uses.
 * Idempotent: a re-run with the same run id finds and returns what exists —
 * and adopts ONLY what this run provably made [AX324 R5]: a store must belong
 * to this run's own DRILL owner, and the drill tenant must be the drill's own
 * (kind, slug and name). Anything else in the way is a conflict, refused.
 * Collision-resistant: run ids that differ only in case or punctuation
 * (`a.b`, `a_b`, `A-B`) share no slug — slugs carry a hash of the exact run id.
 * [AX370 A2] The drill tenant records every run that made or adopted it
 * (tenants.config.stagingDrill.runs). The cleanup applies creation's own
 * provenance rule (foreignDrillTenant: kind, slug, name, not purge-protected)
 * AND requires the run to be on that record before it deletes or deactivates
 * the tenant: a foreign or protected tenant is refused with no mutation, and a
 * run that never used the tenant leaves it as it is.
 * Removable: cleanupDrillFixtures() deletes through the PARENT rows. The
 * append-only evidence (audit, consent, deletion receipts, order status logs,
 * the ledger, receipts, agent-payment observations) is never deleted — it
 * either cascades with its parent or stays as the record of what happened.
 *
 * `swift-drill` is kind CRAWLER: a synthetic tenant without the store-review
 * gate. Its users and stores are derived synthetic (never counted as real
 * people), guests never see it, and the public catalogue stays unambiguous
 * (search-scope.ts counts PRODUCTION tenants only). A second PRODUCTION
 * tenant would have made every guest catalogue request ambiguous.
 */

export const DRILL_TENANT_ID = 'swift-drill';
export const DRILL_TENANT_NAME = 'DRILL tenant (staging drills, synthetic)';
export const DRILL_PHONE_BLOCK = '+592048';
const DEFAULT_TENANT = 'swift-default';
const RUN_ID = /^[A-Za-z0-9._-]{1,64}$/;
const ADMIN_ROLES: readonly UserRole[] = ['ADMIN', 'SUPER_ADMIN'];
const CAPABILITY = 'staging-drills';

export class DrillFixtureError extends Error {
  override readonly name = 'DrillFixtureError';
  constructor(readonly code: string, message: string) {
    super(`[STG-DRILLS ${code}] ${message}`);
  }
}

/** The run id every fixture of one drill run is keyed on. */
export function validateRunId(runId: string): string {
  if (!RUN_ID.test(runId)) throw new DrillFixtureError('RUN_ID_INVALID', 'the run id may use letters, digits, dot, dash and underscore only (1–64)');
  return runId;
}

export const drillMarker = (runId: string): string => `DRILL-${validateRunId(runId)}`;

/** A +592048xxxx number for one slot of one run: deterministic per attempt, so a clash moves to the next. */
export function drillPhone(runId: string, slot: string, attempt = 0): string {
  const h = createHash('sha256').update(`${runId}:${slot}:${attempt}`).digest();
  return `${DRILL_PHONE_BLOCK}${String(h.readUInt32BE(0) % 10_000).padStart(4, '0')}`;
}

/**
 * [AX324 R5] One slot's store slug: the EXACT run id, hashed (64 bits), so run
 * ids that differ only in case or punctuation never share a slug.
 */
export function drillSlug(runId: string, slot: string): string {
  return `drill-${createHash('sha256').update(validateRunId(runId)).digest('hex').slice(0, 16)}-${slot}`;
}

export interface DrillAccount { slot: string; userId: string; phone: string }
export interface DrillManifest {
  version: 2;
  runId: string;
  marker: string;
  createdAt: string;
  target: { deploymentId: string; environment: string; database: string };
  recusal: DrillAccount & { adminPhone: string; linkedBy: 'PHONE' };
  tenant: {
    tenantId: string;
    kind: 'CRAWLER';
    customer: DrillAccount;
    storeOwner: DrillAccount;
    partner: DrillAccount & { riderId: string };
    store: { vendorId: string; name: string; itemId: string; itemName: string };
    order: { orderId: string; orderNumber: string };
  };
}

export interface CreateDrillFixturesInput {
  runId: string;
  /** The test admin (seed-production SEED_ADMIN_PHONE): the reviewer the D5 applicant is linked to. */
  adminPhone: string;
  target: DrillTarget;
  now?: Date;
}

type Db = PrismaClient;

/** One connection owns the provenance lock and EVERY fixture mutation. Nested
 * identity/SAN helpers join this transaction instead of committing separately. */
export async function fixtureTransaction<T>(db: Db, work: (tx: Db) => Promise<T>, tenantId = DRILL_TENANT_ID): Promise<T> {
  return runAsSystem(CAPABILITY, () => db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('staging-drill-fixtures', 0))`;
    await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE`;
    const joined = new Proxy(tx, {
      get(target, key) {
        if (key === '$transaction') return async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx);
        return Reflect.get(target, key);
      },
    }) as Db;
    return work(joined);
  }, { timeout: 60_000, maxWait: 10_000 }));
}

interface AccountSpec { slot: string; roles: UserRole[]; activeRole: UserRole; vendorOwner?: boolean }

/** One DRILL account: found by its marker and slot, else created the way signup shapes it. */
export async function ensureAccount(db: Db, runId: string, spec: AccountSpec): Promise<DrillAccount> {
  const marker = drillMarker(runId);
  const existing = await db.user.findFirst({ where: { syntheticRunId: marker, lastName: spec.slot, tenantId: getTenantId() ?? DEFAULT_TENANT }, select: { id: true, phone: true } });
  if (existing) return { slot: spec.slot, userId: existing.id, phone: existing.phone };
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const phone = drillPhone(runId, spec.slot, attempt);
    const taken = await runAsSystem(CAPABILITY, () => db.user.findUnique({ where: { phone }, select: { id: true } }));
    if (taken) continue;
    // The shape POST /auth/register gives an account (auth.service.ts register):
    // roles, profile rows, GY, a verified phone. No consent row: a synthetic
    // account never consented to anything, and consent_records are evidence.
    const user = await db.user.create({
      data: {
        phone,
        tenantId: getTenantId() ?? DEFAULT_TENANT,
        firstName: marker,
        lastName: spec.slot,
        roles: spec.roles,
        activeRole: spec.activeRole,
        countryCode: 'GY',
        isPhoneVerified: true,
        syntheticRunId: marker,
        customer: { create: {} },
        ...(spec.vendorOwner ? { vendorOwner: { create: {} } } : {}),
      },
      select: { id: true, phone: true },
    });
    return { slot: spec.slot, userId: user.id, phone: user.phone };
  }
  throw new DrillFixtureError('PHONE_BLOCK_EXHAUSTED', `no free ${DRILL_PHONE_BLOCK}xxxx number for ${spec.slot} after 50 draws`);
}

const OWNER: Omit<AccountSpec, 'slot'> = { roles: ['VENDOR_OWNER', 'CUSTOMER'], activeRole: 'VENDOR_OWNER', vendorOwner: true };
const GEORGETOWN = { city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8013, longitude: -58.1551 };

/** D5: an applicant who shares the admin's phone — one STRONG identity edge, through the real engine. */
async function ensureRecusalApplicant(db: Db, runId: string, adminPhone: string): Promise<DrillManifest['recusal']> {
  const admin = await runAsSystem(CAPABILITY, () => db.user.findUnique({ where: { phone: adminPhone }, select: { id: true, roles: true, tenantId: true } }));
  if (!admin || !admin.roles.some((r) => ADMIN_ROLES.includes(r))) {
    throw new DrillFixtureError('ADMIN_NOT_FOUND', 'no admin account holds the given admin phone on this database (seed-production SEED_ADMIN_PHONE)');
  }
  if (admin.tenantId !== DEFAULT_TENANT) throw new DrillFixtureError('ADMIN_NOT_FOUND', `the admin belongs to ${admin.tenantId}, not ${DEFAULT_TENANT}`);
  const account = await ensureAccount(db, runId, { slot: 'admin01-applicant', ...OWNER });
  const identity = new IdentityService(db);
  const value = normalizePhone(adminPhone);
  const source = drillMarker(runId);
  // The admin's own phone — the key signup capture records for every account,
  // a no-op when it is already there (its provenance names the drill when the
  // drill wrote it, so cleanup removes only that) — then the applicant's edge.
  await identity.capture({ accountId: admin.id, actorRole: 'ADMIN', type: 'PHONE', normalizedValue: value, source });
  await identity.capture({ accountId: account.userId, actorRole: 'VENDOR', type: 'PHONE', normalizedValue: value, source });
  const members = await clusterMemberIds(db, admin.id);
  if (!members.includes(account.userId)) {
    throw new DrillFixtureError('RECUSAL_LINK_FAILED', 'the identity engine did not place the applicant in the admin cluster; recusal cannot be staged');
  }
  return { ...account, adminPhone, linkedBy: 'PHONE' };
}

/**
 * [AX324 R5 · AX370 A2] Creation's and cleanup's ONE provenance rule for the
 * row at `swift-drill`: why it is NOT the drill's own tenant, or null.
 */
export function foreignDrillTenant(t: { kind: string; slug: string; name: string; purgeProtected: boolean }): string | null {
  if (t.kind !== 'CRAWLER') return `${DRILL_TENANT_ID} exists as a ${t.kind} tenant; a drill never changes a tenant's kind`;
  if (t.slug !== DRILL_TENANT_ID || t.name !== DRILL_TENANT_NAME) {
    return `${DRILL_TENANT_ID} exists but is not the drill's tenant (slug ${t.slug}, name ${JSON.stringify(t.name)})`;
  }
  if (t.purgeProtected) return `${DRILL_TENANT_ID} is purge-protected; a drill never adopts, deletes or deactivates a protected tenant`;
  return null;
}

/** [AX370 A2] The drill runs (markers) recorded on the drill tenant: tenants.config.stagingDrill.runs. */
export function drillTenantRuns(config: unknown): string[] {
  const runs = (config as { stagingDrill?: { runs?: unknown } } | null)?.stagingDrill?.runs;
  return Array.isArray(runs) ? runs.filter((r): r is string => typeof r === 'string') : [];
}

const TENANT_PROVENANCE = { kind: true, isActive: true, slug: true, name: true, purgeProtected: true, config: true } as const;

/** D6: the second tenant and its four objects. */
async function ensureDrillTenant(db: Db, runId: string, wallDb: Db): Promise<DrillManifest['tenant']> {
  const marker = drillMarker(runId);
  const existing = await db.tenant.findUnique({ where: { id: DRILL_TENANT_ID }, select: TENANT_PROVENANCE });
  // [AX324 R5] Provenance: only the drill's own tenant is adopted (or re-activated).
  const foreign = existing ? foreignDrillTenant(existing) : null;
  if (foreign) throw new DrillFixtureError('DRILL_TENANT_CONFLICT', `${foreign}; a drill adopts only its own`);
  if (!existing?.isActive) {
    // [TA-S0-003] Minting (or re-activating) a tenant at runtime is the path the
    // boot-only wall gate cannot see: assert the wall for the count this makes.
    const activeAfter = (await db.tenant.count({ where: { isActive: true, NOT: { id: DRILL_TENANT_ID } } })) + 1;
    { const db = wallDb; assertTenantWall(attestationOf(await readRlsFacts(db)), activeAfter); }
  }
  // [AX370 A2] The tenant records this run: the provenance its cleanup requires.
  const prior = existing?.config && typeof existing.config === 'object' && !Array.isArray(existing.config) ? existing.config as Prisma.JsonObject : {};
  const runs = drillTenantRuns(prior);
  const config = { ...prior, stagingDrill: { runs: runs.includes(marker) ? runs : [...runs, marker] } } as Prisma.InputJsonObject;
  await db.tenant.upsert({
    where: { id: DRILL_TENANT_ID },
    create: { id: DRILL_TENANT_ID, slug: DRILL_TENANT_ID, name: DRILL_TENANT_NAME, kind: 'CRAWLER', purgeProtected: false, isActive: true, config },
    update: { isActive: true, config },
  });

  return runWithTenant(DRILL_TENANT_ID, async () => {
    const customer = await ensureAccount(db, runId, { slot: 'plat01-customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER' });
    const storeOwner = await ensureAccount(db, runId, { slot: 'plat01-store-owner', ...OWNER });
    const partnerAccount = await ensureAccount(db, runId, { slot: 'plat01-partner', roles: ['MOVER', 'CUSTOMER'], activeRole: 'MOVER' });
    const rider = await db.rider.findUnique({ where: { userId: partnerAccount.userId }, select: { id: true } })
      ?? await db.rider.create({ data: { userId: partnerAccount.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' }, select: { id: true } });

    const owner = await db.vendorOwner.findUniqueOrThrow({ where: { userId: storeOwner.userId }, select: { id: true } });
    const name = `${marker} cross-tenant store`;
    const slug = drillSlug(runId, 'plat01-store');
    // [AX324 R5] Adopt only this run's own store: the slug's owner must be this
    // run's DRILL owner. Anything else under that slug is a conflict, refused.
    const found = await db.vendor.findUnique({ where: { slug }, select: { id: true, ownerId: true } });
    if (found && found.ownerId !== owner.id) {
      throw new DrillFixtureError('FIXTURE_CONFLICT', `the store slug ${slug} belongs to an owner that is not this run's DRILL owner; a drill adopts only what its own run made`);
    }
    const vendor = found ?? await db.vendor.create({
        data: {
          tenantId: DRILL_TENANT_ID, ownerId: owner.id, name, slug, vendorType: 'RESTAURANT', phone: storeOwner.phone,
          addressLine1: `2 ${marker} Street`, ...GEORGETOWN,
          status: 'ACTIVE', isVerified: true, isCurrentlyOpen: true, acceptingOrders: true,
        },
        select: { id: true },
      });
    const itemName = `${marker} plate`;
    let item = await db.item.findFirst({ where: { vendorId: vendor.id, name: itemName }, select: { id: true, basePrice: true } });
    if (!item) {
      const category = await db.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 }, select: { id: true } });
      item = await db.item.create({ data: { vendorId: vendor.id, categoryId: category.id, name: itemName, basePrice: 1500 }, select: { id: true, basePrice: true } });
    }

    // One PENDING counter-pickup cash order, with its first status log — the
    // object every foreign caller will be denied.
    let order = await db.order.findFirst({ where: { customerId: customer.userId, vendorId: vendor.id }, select: { id: true, orderNumber: true } });
    if (!order) {
      const price = new Prisma.Decimal(item.basePrice);
      order = await db.order.create({
        data: {
          tenantId: DRILL_TENANT_ID,
          orderNumber: generateOrderNumber(0),
          orderType: 'FOOD_DELIVERY',
          customerId: customer.userId,
          vendorId: vendor.id,
          fulfillment: 'PICKUP',
          deliveryAddress: `Counter pickup at ${name}`,
          deliveryLat: GEORGETOWN.latitude,
          deliveryLng: GEORGETOWN.longitude,
          subtotalBase: price,
          subtotalMarkup: 0,
          subtotalCustomer: price,
          deliveryFee: 0,
          totalAmount: price,
          paymentMethod: 'CASH',
          items: { create: [{ itemId: item.id, name: itemName, quantity: 1, basePrice: price, markedUpPrice: price, markupAmount: 0, totalBase: price, totalMarkup: 0, totalCustomer: price }] },
          statusHistory: { create: [{ status: 'PENDING', note: `${marker}: cross-tenant drill order` }] },
        },
        select: { id: true, orderNumber: true },
      });
    }
    return {
      tenantId: DRILL_TENANT_ID,
      kind: 'CRAWLER' as const,
      customer,
      storeOwner,
      partner: { ...partnerAccount, riderId: rider.id },
      store: { vendorId: vendor.id, name, itemId: item.id, itemName },
      order: { orderId: order.id, orderNumber: order.orderNumber },
    };
  });
}

/** Create (or find) every drill fixture of one run and return the manifest the runner reads. */
export async function createDrillFixtures(client: Db, input: CreateDrillFixturesInput, wallDb: Db = client): Promise<DrillManifest> {
  return fixtureTransaction(client, async (db) => {
    const now = input.now ?? new Date();
    const marker = drillMarker(input.runId);
    const tenant = await ensureDrillTenant(db, input.runId, wallDb);
    const recusal = await runWithTenant(DEFAULT_TENANT, () => ensureRecusalApplicant(db, input.runId, input.adminPhone));
    return {
      version: 2,
      runId: input.runId,
      marker,
      createdAt: now.toISOString(),
      target: { deploymentId: input.target.deploymentId, environment: input.target.environment, database: input.target.database },
      recusal,
      tenant,
    };
  });
}

export interface DrillCleanupReport {
  runId: string;
  marker: string;
  removed: Record<string, number>;
  /** What could not be removed, and why — never silently left behind. */
  kept: string[];
  /** [AX370 A2] 'refused': the row at swift-drill is not the drill's own (or is protected) — never mutated. */
  tenant: 'removed' | 'deactivated' | 'kept' | 'absent' | 'refused';
  /** Why the tenant was kept or refused. */
  tenantReason?: string;
}

/**
 * Remove one run's fixtures through their parents. Every root is deleted in
 * its own statement so one blocked row (a restrict the journeys created) is
 * reported in `kept` and never takes the rest with it. Evidence tables are
 * not touched: audit, consent, deletion receipts and the ledger refuse
 * DELETE by design, and order status logs go only with their order.
 */
export async function cleanupDrillFixtures(client: Db, input: { runId: string }): Promise<DrillCleanupReport> {
  const marker = drillMarker(input.runId);
  const removed: Record<string, number> = {};
  const kept: string[] = [];
  const count = (what: string, n: number) => { if (n > 0) removed[what] = (removed[what] ?? 0) + n; };
  let transaction: Db;
  const attempt = async (what: string, fn: () => Promise<number>): Promise<void> => {
    await transaction.$executeRawUnsafe('SAVEPOINT drill_cleanup_row');
    try {
      count(what, await fn());
      await transaction.$executeRawUnsafe('RELEASE SAVEPOINT drill_cleanup_row');
    } catch (err) {
      await transaction.$executeRawUnsafe('ROLLBACK TO SAVEPOINT drill_cleanup_row');
      const e = err as { code?: string; meta?: { field_name?: string; constraint?: string }; message?: string };
      kept.push(`${what}: ${e.code ?? 'error'} ${e.meta?.field_name ?? e.meta?.constraint ?? (e.message ?? '').split('\n')[0]?.slice(0, 160)}`);
    }
  };

  return fixtureTransaction(client, async (db) => {
    transaction = db;
    const drillTenant = await db.tenant.findUnique({ where: { id: DRILL_TENANT_ID }, select: TENANT_PROVENANCE });
    const foreign = drillTenant ? foreignDrillTenant(drillTenant) : null;
    if (foreign) return { runId: input.runId, marker, removed, kept: [foreign], tenant: 'refused', tenantReason: foreign };
    if (drillTenant && !drillTenantRuns(drillTenant.config).includes(marker)) {
      return { runId: input.runId, marker, removed, kept, tenant: 'kept', tenantReason: `${marker} is not on the tenant's record of drill runs` };
    }
    // Row locks protect root ownership and block new FK references until every
    // child and root has been handled. Tenant replacement/protection/run edits
    // also wait for the transaction's tenant row lock.
    await db.$queryRaw`SELECT id FROM users WHERE "syntheticRunId" = ${marker} ORDER BY id FOR UPDATE`;
    const users = await db.user.findMany({ where: { syntheticRunId: marker }, select: { id: true, tenantId: true } });
    const userIds = users.map((u) => u.id);
    if (users.some((u) => ![DEFAULT_TENANT, DRILL_TENANT_ID].includes(u.tenantId))) {
      return { runId: input.runId, marker, removed, kept: ['fixture account is outside the authorized tenants'], tenant: 'refused' };
    }
    await db.$queryRaw`SELECT v.id FROM vendors v JOIN vendor_owners o ON o.id = v."ownerId" WHERE o."userId" = ANY(${userIds}) ORDER BY v.id FOR UPDATE OF v, o`;
    await db.$queryRaw`SELECT id FROM riders WHERE "userId" = ANY(${userIds}) ORDER BY id FOR UPDATE`;

    const owners = await db.vendorOwner.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    const vendors = await db.vendor.findMany({ where: { ownerId: { in: owners.map((o) => o.id) } }, select: { id: true } });
    const vendorIds = vendors.map((v) => v.id);
    const riders = await db.rider.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    const riderIds = riders.map((r) => r.id);
    const subs = await db.subscription.findMany({ where: { OR: [{ vendorId: { in: vendorIds } }, { riderId: { in: riderIds } }] }, select: { id: true, san: true } });
    const docs = await db.verificationDocument.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    const memberships = await db.identityClusterMember.findMany({ where: { accountId: { in: userIds } }, select: { clusterId: true } });
    const touchedClusters = [...new Set(memberships.map((m) => m.clusterId))];

    await db.$queryRaw`SELECT id FROM orders WHERE "customerId" = ANY(${userIds}) OR "vendorId" = ANY(${vendorIds}) ORDER BY id FOR UPDATE`;
    // 1. The order graph: carts that point at a drill store or belong to a drill
    //    account, then the orders (items and status logs cascade with them).
    await attempt('carts', async () => (await db.cart.deleteMany({ where: { OR: [{ vendorId: { in: vendorIds } }, { customerId: { in: userIds } }] } })).count);
    const orders = await db.order.findMany({ where: { OR: [{ customerId: { in: userIds } }, { vendorId: { in: vendorIds } }] }, select: { id: true } });
    for (const o of orders) await attempt('orders', async () => (await db.order.deleteMany({ where: { id: o.id } })).count);

    // 2. Money that belongs to the fixtures' own stores: digests, then each
    //    subscription — its SAN retired to the tombstone registry first, the
    //    way account closure retires one (never re-issued).
    await attempt('settlements', async () => (await db.settlement.deleteMany({ where: { vendorId: { in: vendorIds } } })).count);
    for (const s of subs) {
      await attempt('subscriptions', async () => {
        if (s.san) await releaseSan(db, s.id, `${marker}: staging drill fixture removed`);
        return (await db.subscription.deleteMany({ where: { id: s.id } })).count;
      });
    }

    // 3. Review evidence about the fixtures' own documents (decisions before cases).
    const docIds = docs.map((d) => d.id);
    const cases = await db.reviewCase.findMany({ where: { submissionId: { in: docIds } }, select: { id: true } });
    await attempt('review decisions', async () => (await db.reviewDecision.deleteMany({ where: { caseId: { in: cases.map((c) => c.id) } } })).count);
    await attempt('review cases', async () => (await db.reviewCase.deleteMany({ where: { id: { in: cases.map((c) => c.id) } } })).count);

    // 4. The stores (menus, hours and images cascade), then the identity graph
    //    rows the fixtures made: grants, enforcement, membership, keys.
    for (const v of vendorIds) await attempt('vendors', async () => (await db.vendor.deleteMany({ where: { id: v } })).count);
    await attempt('trial grants', async () => (await db.trialGrant.deleteMany({ where: { accountId: { in: userIds } } })).count);
    await attempt('enforcement actions', async () => (await db.enforcementAction.deleteMany({ where: { accountId: { in: userIds } } })).count);
    await attempt('identity memberships', async () => (await db.identityClusterMember.deleteMany({ where: { accountId: { in: userIds } } })).count);
    await attempt('identity keys', async () => (await db.identityKey.deleteMany({ where: { OR: [{ accountId: { in: userIds } }, { source: marker }] } })).count);
    for (const clusterId of touchedClusters) {
      await attempt('identity clusters', async () => {
        const [members, grants, children] = await Promise.all([
          db.identityClusterMember.count({ where: { clusterId } }),
          db.trialGrant.count({ where: { clusterId } }),
          db.identityCluster.count({ where: { mergedIntoId: clusterId } }),
        ]);
        // Still someone's cluster (the admin's, once the applicant has left), or
        // the root other clusters were merged into: union history stays.
        if (members + grants + children > 0) return 0;
        return (await db.identityCluster.deleteMany({ where: { id: clusterId } })).count;
      });
    }

    // 5. The accounts (sessions, profiles, riders, notifications and documents cascade).
    for (const u of userIds) await attempt('users', async () => (await db.user.deleteMany({ where: { id: u } })).count);

    // 6. The drill tenant, once nothing of any run lives in it — and only when
    //    it is provably the drill's own and this run is on its record [AX370 A2].
    let tenant: DrillCleanupReport['tenant'] = 'absent';
    let tenantReason: string | undefined;
    if (drillTenant && foreign) {
      tenant = 'refused';
      tenantReason = foreign;
      kept.push(`tenant ${DRILL_TENANT_ID}: refused, untouched — ${foreign}`);
    } else if (drillTenant && !drillTenantRuns(drillTenant.config).includes(marker)) {
      tenant = 'kept';
      tenantReason = `${marker} is not on the tenant's record of drill runs; only a run that used it removes it`;
    } else if (drillTenant) {
      const [u, v, o] = await Promise.all([
        db.user.count({ where: { tenantId: DRILL_TENANT_ID } }),
        db.vendor.count({ where: { tenantId: DRILL_TENANT_ID } }),
        db.order.count({ where: { tenantId: DRILL_TENANT_ID } }),
      ]);
      // Each mutation re-states the provenance, so a row changed since the read is never touched.
      const own = { id: DRILL_TENANT_ID, kind: 'CRAWLER' as const, slug: DRILL_TENANT_ID, name: DRILL_TENANT_NAME, purgeProtected: false, config: { path: ['stagingDrill', 'runs'], array_contains: [marker] } };
      if (u + v + o > 0) {
        tenant = 'kept';
        tenantReason = `${u} user(s), ${v} store(s), ${o} order(s) still live in it`;
      } else {
        await db.$executeRawUnsafe('SAVEPOINT drill_cleanup_tenant');
        try {
          const gone = (await db.tenant.deleteMany({ where: own })).count;
          tenant = gone === 1 ? 'removed' : 'refused';
          if (gone === 1) count('tenants', 1);
          else kept.push(`tenant ${DRILL_TENANT_ID}: refused, untouched — it changed before the delete`);
        } catch (err) {
          await db.$executeRawUnsafe('ROLLBACK TO SAVEPOINT drill_cleanup_tenant');
          // Evidence that refuses deletion (a deletion receipt) keeps the row;
          // the tenant is switched off so staging is back to one live operator.
          const off = (await db.tenant.updateMany({ where: own, data: { isActive: false } })).count;
          tenant = off === 1 ? 'deactivated' : 'refused';
          kept.push(`tenant ${DRILL_TENANT_ID}: ${(err as { code?: string }).code ?? 'error'} (${off === 1 ? 'deactivated instead' : 'refused, untouched — it changed before the deactivation'})`);
        }
      }
    }
    return { runId: input.runId, marker, removed, kept, tenant, ...(tenantReason ? { tenantReason } : {}) };
  });
}
