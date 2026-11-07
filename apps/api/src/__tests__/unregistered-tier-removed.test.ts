/**
 * [CHECKLIST-LEGAL · owner ruling 1 Nov 2026 17:31Z (a)] The self-declared UNREGISTERED tier is REMOVED: only a
 * registered business, or a trader under their own name (vendor/own-name.ts), joins Swift. This supersedes the DOC-1
 * §3.6 / P3-2 micro-vendor tier (the self-declaration, its caps and nudge, the automatic promotion, the
 * promoted-placement refusal and the three `*_UNREGISTERED` lists).
 *
 *  - No list asks for it: the three lists are gone (PLATFORM_CONFIG 2026-11-01.1), and a stored copy from an older
 *    seed (production holds 2026-10-24.1, then 2026-10-29.1) never brings them back: they are retired keys, and the
 *    registry seed drops their requirement sets.
 *  - The self-declaration route answers 410 and names the two ways in; it writes nothing.
 *  - A store row still marked UNREGISTERED (written before the migration ran) is a standard store: the standard
 *    checklist (its business registration is asked for), no caps, promoted placement open. The migration moves every
 *    such row to REGISTERED and touches no other store.
 *  - GET /vendor/tier (build 12's Seller status reads it) answers "no limits".
 *  - No code path is left: the tier modules are gone and no module writes or compares the tier.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { resetKeyProviderForTests } from '../providers/storage/envelope';
import { withSuiteCapability } from '../lib/test-target-lock';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { DEFAULT_DOCUMENT_CHECKLISTS, PLATFORM_CONFIG_VERSION, desiredPlatformConfig } from '../modules/ops/platform-config';
import { CountryConfigService, RETIRED_LIST_KEYS } from '../modules/country/country-config.service';
import {
  AUTO_APPROVE_EXPIRY_DAYS, BUCKET_OF, EXTRA_DOC_TYPES, FIELD_CATALOGUE, RETIRED_DOC_TYPES, RETIRED_REGISTRY_LIST_KEYS, seedDocRegistry,
} from '../modules/verification/doc-registry';
import { foodHandlerTickApplies } from '../modules/vendor/food-handlers';
import { signupSelfieFixture } from './helpers/verification-object';
import { wordFreeTag } from './helpers/fixture-ids';

const TIER_LISTS = ['RESTAURANT_UNREGISTERED', 'SUPERMARKET_UNREGISTERED', 'STORE_UNREGISTERED'] as const;
const DECLARATION = 'self_declaration_unregistered';
const MIGRATION = '20261101120000_unregistered_tier_removed';
const API = process.cwd();
const RUN = wordFreeTag(8);
const NUM = String(Date.now()).slice(-6);
const DAY = 86_400_000;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'unregistered-tier-removed-test');
let app: FastifyInstance;
const users: string[] = [];
let seq = 0;

beforeAll(async () => {
  vi.stubEnv('MASTER_KEK', Buffer.alloc(32, 7).toString('base64'));
  resetKeyProviderForTests();
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.ready();
  await system(() => seedDocRegistry(app.prisma));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  resetKeyProviderForTests();
  if (!app) return;
  await system(async () => {
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: users } } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

/** A store owner with one store whose row may still read UNREGISTERED (as a row written before the migration). */
async function owner(tier: 'REGISTERED' | 'UNREGISTERED', vendorType: 'RESTAURANT' | 'SUPERMARKET' | 'STORE' = 'RESTAURANT') {
  seq += 1;
  const user = await system(() => app.prisma.user.create({ data: {
    phone: `+5927${NUM}${String(seq).padStart(2, '0')}`, firstName: 'Tier', lastName: `Removed${seq}`, roles: ['VENDOR_OWNER', 'CUSTOMER'], activeRole: 'VENDOR_OWNER',
    countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true,
  } }));
  users.push(user.id);
  await signupSelfieFixture(app.prisma, user.id);
  const vendorOwner = await runWithTenant('swift-default', () => app.prisma.vendorOwner.create({ data: { userId: user.id, vendors: { create: {
    name: `Tier Store ${RUN} ${seq}`, slug: `tier-removed-${RUN.toLowerCase()}-${seq}`, vendorType, phone: `+5927${NUM}9${seq}`, addressLine1: '1 Stall Row', city: 'Georgetown',
    region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.16, status: 'PENDING_APPROVAL', publicPhone: '+5926001234',
    tier, ...(tier === 'UNREGISTERED' ? { tierNote: 'fixture: a row written before the tier was removed' } : {}),
  } } }, include: { vendors: true } }));
  const token = app.jwt.sign({ userId: user.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await runWithTenant('swift-default', () => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(24), deviceId: `tier-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { userId: user.id, vendorId: vendorOwner.vendors[0]!.id, token };
}
const call = (method: 'GET' | 'POST', url: string, o: { token: string; vendorId: string }, payload?: Record<string, unknown>) => app.inject({
  method, url, ...(payload ? { payload } : {}),
  headers: { authorization: `Bearer ${o.token}`, 'x-vendor-id': o.vendorId, ...(payload ? { 'content-type': 'application/json' } : {}) },
});

describe('[CHECKLIST-LEGAL (a)] no list asks for the self-declared tier', () => {
  it('no *_UNREGISTERED list and no self-declaration in any list; the change carries config 2026-11-01.1', () => {
    for (const [key, list] of Object.entries(DEFAULT_DOCUMENT_CHECKLISTS)) {
      expect(key, key).not.toMatch(/_UNREGISTERED$/);
      expect(list, key).not.toContain(DECLARATION);
    }
    // The ways in are unchanged: a registered business, or a trader under their own name.
    expect(DEFAULT_DOCUMENT_CHECKLISTS['RESTAURANT']).toEqual(['owner_national_id', 'business_registration', 'gra_restaurant_licence', 'storefront_photo']);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['SUPERMARKET']).toEqual(['owner_national_id', 'business_registration', 'storefront_photo']);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['STORE']).toEqual(['owner_national_id', 'business_registration', 'storefront_photo']);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['RESTAURANT_OWN_NAME']).toEqual(['owner_national_id', 'own_name_declaration', 'gra_restaurant_licence', 'storefront_photo']);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['SUPERMARKET_OWN_NAME']).toEqual(['owner_national_id', 'own_name_declaration', 'storefront_photo']);
    expect(DEFAULT_DOCUMENT_CHECKLISTS['STORE_OWN_NAME']).toEqual(['owner_national_id', 'own_name_declaration', 'storefront_photo']);
    // A checklist change is a platform-config change: production takes it with the next owner-signed seed.
    expect(PLATFORM_CONFIG_VERSION).toBe('2026-11-01.1');
    const desired = desiredPlatformConfig();
    expect(desired.version).toBe('2026-11-01.1');
    for (const c of desired.countries) {
      const lists = c.policy['documentChecklists'] as Record<string, string[]>;
      for (const key of TIER_LISTS) expect(lists[key], `${c.code} ${key}`).toBeUndefined();
    }
  });

  it('the three lists are retired keys in both readers, so a stored copy from an older seed declares nothing', () => {
    for (const key of TIER_LISTS) {
      expect(RETIRED_LIST_KEYS.has(key), key).toBe(true);
      expect(RETIRED_REGISTRY_LIST_KEYS.has(key), key).toBe(true);
    }
    expect([...RETIRED_LIST_KEYS].sort()).toEqual([...RETIRED_REGISTRY_LIST_KEYS].sort());
  });

  it('the self-declaration is a retired type: its stored copies keep their retention class, nothing seeds, dates or reads it', () => {
    expect(RETIRED_DOC_TYPES).toContain(DECLARATION);
    expect(BUCKET_OF[DECLARATION]).toBe('BUSINESS');
    expect(EXTRA_DOC_TYPES.map((t) => t.legacyCode)).not.toContain(DECLARATION);
    expect(AUTO_APPROVE_EXPIRY_DAYS[DECLARATION]).toBeUndefined();
    expect(FIELD_CATALOGUE[DECLARATION]).toBeUndefined();
  });

  it('a restaurant\'s food handler tick no longer depends on a tier', () => {
    expect(foodHandlerTickApplies({ vendorType: 'RESTAURANT' })).toBe(true);
    expect(foodHandlerTickApplies({ vendorType: 'SUPERMARKET' })).toBe(false);
  });
});

describe('[CHECKLIST-LEGAL (a)] a database seeded before the removal (its stored lists still name the tier)', () => {
  it('the checklist never answers an UNREGISTERED list, and the registry seed drops the tier\'s requirement sets', async () => {
    await system(async () => {
      const gy = await app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' } });
      const before = gy.documentChecklists;
      // What production's stored copy holds today (the 2026-10-24.1 seed, and 2026-10-29.1 after the pending re-seed).
      const old = {
        ...(before as Record<string, string[]>),
        RESTAURANT_UNREGISTERED: ['owner_national_id', DECLARATION, 'storefront_photo', 'food_handler_cert'],
        SUPERMARKET_UNREGISTERED: ['owner_national_id', DECLARATION, 'storefront_photo'],
        STORE_UNREGISTERED: ['owner_national_id', DECLARATION, 'storefront_photo'],
      };
      await app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { documentChecklists: old } });
      try {
        const lists = new CountryConfigService(app.prisma);
        for (const role of ['RESTAURANT', 'SUPERMARKET', 'STORE']) {
          // whatever tier a caller names, the role's standard list (with its business registration) is the answer
          expect(await lists.getDocumentChecklist('GY', role, 'UNREGISTERED'), role).toEqual(DEFAULT_DOCUMENT_CHECKLISTS[role]);
          expect(await lists.getDocumentChecklist('GY', role), role).toEqual(DEFAULT_DOCUMENT_CHECKLISTS[role]);
        }
        await seedDocRegistry(app.prisma);
        expect(await app.prisma.requirementSet.count({ where: { countryCode: 'GY', tier: 'UNREGISTERED' } })).toBe(0);
        expect(await app.prisma.requirementItem.count({ where: { docType: { legacyCode: DECLARATION } } })).toBe(0);
        // the retired type is still described (stored copies keep their bucket), never as a requirement
        const row = await app.prisma.docType.findUniqueOrThrow({ where: { code: `GY.${DECLARATION}` } });
        expect(row).toMatchObject({ bucket: 'BUSINESS', hasExpiry: false, defaultValidityDays: null, expirySource: 'NONE' });
      } finally {
        await app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { documentChecklists: before as never } });
        await seedDocRegistry(app.prisma);
      }
    });
  }, 180_000); // two full registry seeds
});

describe('[CHECKLIST-LEGAL (a)] the route, the seller status and a store row from before the removal', () => {
  it('POST /vendor/onboarding/declaration answers 410 with the two ways in, and writes nothing', async () => {
    const o = await owner('REGISTERED');
    const res = await call('POST', '/api/v1/vendor/onboarding/declaration', o, { tradingName: `Auntie ${RUN}`, activityClass: 'snackette', declaredAddress: '2 Stall Row, Georgetown', attestationVersion: 'v1' });
    expect(res.statusCode, res.body).toBe(410);
    const error = res.json().error;
    expect(error.code).toBe('UNREGISTERED_TIER_REMOVED');
    // polite, and it names both ways in: register the business name, or trade under your own name
    expect(error.message).toMatch(/register/i);
    expect(error.message).toMatch(/own name/i);
    // [REVIEW-F S4-1] it never says a registration is the only way in and then offers the own-name way
    expect(error.message).toMatch(/^Swift takes registered businesses, and traders who sell under their own name\./);
    expect(error.message).not.toMatch(/without a business registration/);
    // an empty or old-shaped body gets the same answer (no validation error first)
    expect((await call('POST', '/api/v1/vendor/onboarding/declaration', o, {})).statusCode).toBe(410);
    await system(async () => {
      expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: o.vendorId }, select: { tier: true } })).tier).toBe('REGISTERED');
      expect(await app.prisma.consentRecord.count({ where: { subjectId: o.userId, documentType: 'unregistered_trader_declaration' } })).toBe(0);
      expect(await app.prisma.verificationDocument.count({ where: { userId: o.userId, docType: DECLARATION } })).toBe(0);
      expect(await app.prisma.encryptedObject.count({ where: { createdBy: o.userId, mimeType: 'application/pdf' } })).toBe(0);
    });
  });

  it('GET /vendor/tier (build 12\'s Seller status) answers "no limits", even for a row still marked UNREGISTERED', async () => {
    for (const tier of ['UNREGISTERED', 'REGISTERED'] as const) {
      const o = await owner(tier);
      const res = await call('GET', '/api/v1/vendor/tier', o);
      expect(res.statusCode, res.body).toBe(200);
      const data = res.json().data;
      expect(data, tier).toMatchObject({ tier: 'REGISTERED', capped: false, nearCap: false, promotedPlacement: true, declaration: null, registration: { onFile: false } });
      // build 12 reads these shapes even when it shows no bars: they are present and zero
      expect(data.caps).toEqual({ ordersPerDay: 0, grossPerWeek: 0, nudgeAtFraction: 0 });
      expect(data.usage).toEqual({ ordersToday: 0, grossThisWeek: 0 });
    }
  });

  // [REVIEW-F S4-1] The kept Seller status screen must not tell an own-name trader a registration is still owed.
  it('GET /vendor/tier says whether the store trades under its owner\'s own name', async () => {
    const o = await owner('REGISTERED');
    expect((await call('GET', '/api/v1/vendor/tier', o)).json().data.tradesUnderOwnName).toBe(false);
    await system(() => app.prisma.vendor.update({ where: { id: o.vendorId }, data: { tradesUnderOwnName: true } }));
    const data = (await call('GET', '/api/v1/vendor/tier', o)).json().data;
    expect(data.tradesUnderOwnName).toBe(true);
    expect(data.registration).toEqual({ onFile: false, submission: null });
  });

  it('a store row still marked UNREGISTERED reads the standard checklist: its business registration is asked for', async () => {
    const o = await owner('UNREGISTERED');
    const res = await call('GET', '/api/v1/verification/status?role=RESTAURANT', o);
    expect(res.statusCode, res.body).toBe(200);
    const status = res.json().data;
    // the restaurant's standard list, and (like every restaurant now) its owner's food handlers tick
    expect(status.checklist).toEqual([...DEFAULT_DOCUMENT_CHECKLISTS['RESTAURANT']!, 'food_handler_attestation']);
    expect(status.checklist).toContain('business_registration');
    expect(status.checklist).not.toContain(DECLARATION);
  });
});

/** The migration's statements, in order (comments stripped; the file has no semicolons inside a statement). */
function statements(): string[] {
  const sql = readFileSync(join(API, 'prisma/migrations', MIGRATION, 'migration.sql'), 'utf8');
  return sql.split(/;\s*\n/).map((chunk) => chunk.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim()).filter(Boolean);
}

describe('[CHECKLIST-LEGAL (a)] the migration', () => {
  it('moves every store still on the tier to REGISTERED with a note, and touches no other store', async () => {
    const legacy = await owner('UNREGISTERED');
    const standard = await owner('REGISTERED', 'STORE');
    const before = await system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: standard.vendorId }, select: { tier: true, tierChangedAt: true, tierNote: true, updatedAt: true } }));
    const sql = statements();
    expect(sql.length).toBeGreaterThan(0);
    // The migration's one DDL statement (the business profile's defaults) is the migration's own: granted for this block only.
    const apply = () => withSuiteCapability('ddl', () => system(async () => { for (const s of sql) await app.prisma.$executeRawUnsafe(s); }));
    await apply();
    const moved = await system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: legacy.vendorId }, select: { tier: true, tierChangedAt: true, tierNote: true } }));
    expect(moved.tier).toBe('REGISTERED');
    expect(moved.tierChangedAt).not.toBeNull();
    expect(moved.tierNote).toMatch(/unregistered tier removed/i);
    expect(await system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: standard.vendorId }, select: { tier: true, tierChangedAt: true, tierNote: true, updatedAt: true } }))).toEqual(before);
    expect(await system(() => app.prisma.vendor.count({ where: { tier: 'UNREGISTERED', owner: { userId: { in: users } } } }))).toBe(0);
    // A replay changes nothing (Migration Replay runs it on a fresh database too).
    await apply();
    expect((await system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: legacy.vendorId }, select: { tierChangedAt: true } }))).tierChangedAt).toEqual(moved.tierChangedAt);
  });

  it('the business profile no longer defaults to the tier', () => {
    const schema = readFileSync(join(API, 'prisma/schema.prisma'), 'utf8');
    const model = schema.slice(schema.indexOf('model BusinessProfile {'), schema.indexOf('}', schema.indexOf('model BusinessProfile {')));
    expect(model).not.toMatch(/UNREGISTERED/);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

describe('[CHECKLIST-LEGAL (a)] no code path is left', () => {
  it('the tier\'s modules are gone', () => {
    expect(existsSync(join(API, 'src/modules/vendor/vendor-tier.ts'))).toBe(false);
    expect(existsSync(join(API, 'src/modules/vendor/unregistered-declaration.ts'))).toBe(false);
  });

  it('no module writes, reads or compares the tier, and nothing names the declaration outside the registry text', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(API, 'src'))) {
      const text = readFileSync(file, 'utf8');
      const rel = file.slice(API.length + 1);
      if (/'UNREGISTERED'/.test(text)) offenders.push(`${rel}: 'UNREGISTERED'`);
      if (/UNREGISTERED_(TIER|LIST_SUFFIX)\b/.test(text)) offenders.push(`${rel}: UNREGISTERED_TIER / _LIST_SUFFIX`);
      if (/\b(assertWithinTierCaps|assertPromotable|promoteIfRegistered|nudgeOwnerOnce|vendorTierCapsFor|VENDOR_TIER_CAP)\b/.test(text)) offenders.push(`${rel}: a tier helper`);
      // the registry describes the retired type (bucket, retired list) and the retired list keys; nothing else names it
      if (text.includes(DECLARATION) && rel !== 'src/modules/verification/doc-registry.ts') offenders.push(`${rel}: ${DECLARATION}`);
    }
    expect(offenders).toEqual([]);
  });
});
