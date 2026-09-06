/**
 * [DOC-1 §4.2] test_checklist_facade_unchanged — the registry EXPAND changes
 * nothing until legal facts do.
 *
 * The four registry tables exist with the spec's CHECK constraints; the seed
 * mirrors every country's checklist JSON exactly (as inactive, provisional
 * rows); the facade returns the JSON lists while rows are inactive, and the
 * registry's own lists — identical — once a set's rows are activated with
 * recorded legal facts. The constraints refuse a persisting class with no
 * retention, activation without legal facts, and a PERSONAL class marked for
 * external processing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithoutTenant } from '../plugins/tenant-context';
import { CountryConfigService } from '../modules/country/country-config.service';
import { seedDocRegistry, registryChecklist, registryCode, REGISTRY_TIER, REGISTRY_EFFECTIVE_FROM } from '../modules/verification/doc-registry';

let app: FastifyInstance;
let countries: Array<{ code: string; lists: Record<string, string[]> }> = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-registry-test');

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.ready();
  await system(() => seedDocRegistry(app.prisma));
  const rows = await app.prisma.countryConfig.findMany({ select: { code: true, documentChecklists: true } });
  countries = rows.map((r) => ({ code: r.code, lists: (r.documentChecklists ?? {}) as Record<string, string[]> }));
});

afterAll(async () => {
  await system(() => app.prisma.docType.updateMany({ where: { countryCode: 'GY', isActive: true }, data: { isActive: false, legalFactsVerifiedAt: null } }));
  await app.close();
});

describe('[DOC-1 §4.2] the registry', () => {
  it('the seed is not vacuous and is idempotent', async () => {
    expect(countries.length).toBeGreaterThan(0);
    const again = await system(() => seedDocRegistry(app.prisma));
    expect(again.docTypes).toBeGreaterThan(10);
    const total = await app.prisma.docType.count();
    expect(total).toBe(await app.prisma.docType.count()); // a second seed created nothing new
  });

  it('every checklist of every country is mirrored exactly, in order, by an inactive provisional requirement set', async () => {
    for (const c of countries) {
      for (const [role, codes] of Object.entries(c.lists)) {
        const set = await app.prisma.requirementSet.findUnique({
          where: { countryCode_actorRole_tier_effectiveFrom: { countryCode: c.code, actorRole: role, tier: REGISTRY_TIER, effectiveFrom: REGISTRY_EFFECTIVE_FROM } },
          include: { items: { include: { docType: true }, orderBy: { sortOrder: 'asc' } } },
        });
        expect(set, `${c.code}/${role}`).not.toBeNull();
        expect(set!.items.map((i) => i.docType.legacyCode)).toEqual(codes);
        for (const i of set!.items) {
          expect(i.docType.isActive).toBe(false);
          expect(i.docType.legalFactsVerifiedAt).toBeNull();
          expect(i.docType.externalProcessingAllowed).toBe(false);
          expect(i.isBlocking).toBe(true);
        }
      }
    }
  });

  it('test_checklist_facade_unchanged: while rows are inactive the facade returns the JSON list for every country and role', async () => {
    const svc = new CountryConfigService(app.prisma);
    for (const c of countries) {
      for (const [role, codes] of Object.entries(c.lists)) {
        expect(await registryChecklist(app.prisma, c.code, role)).toBeNull();
        expect(await svc.getDocumentChecklist(c.code, role), `${c.code}/${role}`).toEqual(codes);
      }
      expect(await svc.getDocumentChecklist(c.code, 'NO_SUCH_ROLE')).toEqual([]);
    }
  });

  it('once a set’s document types are activated with recorded legal facts, the registry answers — with the identical list', async () => {
    const gy = countries.find((c) => c.code === 'GY')!;
    const role = 'RESTAURANT';
    const codes = gy.lists[role]!;
    await system(() => app.prisma.docType.updateMany({
      where: { code: { in: codes.map((c) => registryCode('GY', c)) } },
      data: { isActive: true, legalFactsVerifiedAt: new Date('2026-09-01T00:00:00.000Z') },
    }));
    const set = await app.prisma.requirementSet.findUniqueOrThrow({ where: { countryCode_actorRole_tier_effectiveFrom: { countryCode: 'GY', actorRole: role, tier: REGISTRY_TIER, effectiveFrom: REGISTRY_EFFECTIVE_FROM } } });
    try {
      expect(await registryChecklist(app.prisma, 'GY', role)).toEqual(codes);
      expect(await new CountryConfigService(app.prisma).getDocumentChecklist('GY', role)).toEqual(codes);
      // The registry is now the truth: reorder it, and the facade follows the
      // registry, not the JSON — so a facade that ignores the registry is caught.
      for (const [i, c] of codes.entries()) {
        await system(() => app.prisma.requirementItem.update({ where: { requirementSetId_docTypeCode: { requirementSetId: set.id, docTypeCode: registryCode('GY', c) } }, data: { sortOrder: codes.length - i } }));
      }
      expect(await new CountryConfigService(app.prisma).getDocumentChecklist('GY', role)).toEqual([...codes].reverse());
      // A role whose set still has an inactive class keeps the JSON answer.
      expect(await registryChecklist(app.prisma, 'GY', 'MOVER_TAXI_EXTRA')).toBeNull();
    } finally {
      await system(() => seedDocRegistry(app.prisma)); // restores the published order
      await system(() => app.prisma.docType.updateMany({ where: { code: { in: codes.map((c) => registryCode('GY', c)) } }, data: { isActive: false, legalFactsVerifiedAt: null } }));
    }
  });

  it('has_expiry and default validity come from the code’s existing expiry truth, never from recall', async () => {
    const { AUTO_APPROVE_EXPIRY_DAYS } = await import('../modules/verification/verification.service');
    const rows = await app.prisma.docType.findMany({ where: { countryCode: 'GY' } });
    for (const r of rows) {
      const days = AUTO_APPROVE_EXPIRY_DAYS[r.legacyCode];
      expect(r.hasExpiry, r.code).toBe(days !== undefined);
      expect(r.defaultValidityDays, r.code).toBe(days ?? null);
    }
  });

  it('the spec’s CHECK constraints hold: persisting needs a retention, activation needs legal facts, PERSONAL is never external', async () => {
    const insert = (over: string) => app.prisma.$executeRaw(Prisma.sql`
      INSERT INTO doc_type (code, "countryCode", "legacyCode", "displayName", bucket, "subjectKind", issuer, "imagePolicy", "persistRetentionDays", "hasExpiry", "extractionProfile", "isActive", "legalFactsVerifiedAt", "externalProcessingAllowed")
      VALUES (${`XX.probe_${over}`}, 'XX', ${`probe_${over}`}, 'Probe', ${over === 'external' ? 'PERSONAL' : 'BUSINESS'}::"DocBucket", 'BUSINESS'::"DocSubjectKind", 'probe', 'PERSIST'::"DocImagePolicy",
              ${over === 'retention' ? null : 1}, false, 'UNPROFILED', ${over === 'active'}, NULL, ${over === 'external'})`);
    await expect(insert('retention')).rejects.toThrow(/persist_needs_retention/);
    await expect(insert('active')).rejects.toThrow(/active_needs_legal_facts/);
    await expect(insert('external')).rejects.toThrow(/personal_external_needs_decision/);
    expect(await app.prisma.docType.count({ where: { countryCode: 'XX' } })).toBe(0);
  });
});
