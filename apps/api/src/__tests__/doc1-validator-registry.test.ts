/**
 * [DOC-1 §7.1 · P7-1] test_registry_completeness — the validator registry.
 *
 * The 24 validators of §7.2–7.5 are registry DATA (code, scope, blocking, the
 * §8.5 reason a FAIL carries, the type they apply to, the implementation they
 * resolve to). Only implemented validators judge; a declared-but-unimplemented
 * one writes nothing. DOC-INV-2: every ACTIVE document type has a profile, a
 * field list and an implemented validator on each required field, no blocking
 * validator it depends on is a phantom, and no row names an implementation
 * that does not exist — production refuses to boot otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prismaPlugin } from '../plugins/prisma';
import { runWithoutTenant } from '../plugins/tenant-context';
import { seedDocRegistry, registryCode, registryCompletenessGaps } from '../modules/verification/doc-registry';
import { VALIDATOR_IMPLEMENTATIONS, resolvesImpl } from '../modules/verification/validators';
import { planExtraction, type RegisteredValidator } from '../modules/verification/extraction-ledger';

/** §7.2–7.5, pinned FROM the spec as literals: [code, scope, blocking]. WARN and routing rows are non-blocking. */
const SPEC_VALIDATORS: ReadonlyArray<readonly [string, string, boolean]> = [
  ['V_MRZ_CHECKSUM', 'FIELD', true], ['V_DATE_ORDER', 'FIELD', true], ['V_NOT_EXPIRED', 'FIELD', true], ['V_EXPIRY_PLAUSIBLE', 'FIELD', false],
  ['V_DOB_ADULT', 'FIELD', true], ['V_TIN_FORMAT', 'FIELD', true], ['V_PLATE_FORMAT', 'FIELD', true], ['V_PLATE_CLASS', 'FIELD', true],
  ['V_VEHICLE_COLOUR', 'FIELD', true], ['V_LICENCE_CLASS', 'FIELD', true], ['V_INSURANCE_SCOPE', 'FIELD', true], ['V_FIELD_CONFIDENCE', 'FIELD', false],
  ['V_TYPE_MATCH', 'DOCUMENT', true], ['V_ALL_REQUIRED_PRESENT', 'DOCUMENT', true], ['V_PAGE_COMPLETE', 'DOCUMENT', true], ['V_TAMPER_HEURISTIC', 'DOCUMENT', false],
  ['V_NAME_CONSISTENCY', 'SUBJECT', false], ['V_PLATE_CROSS_MATCH', 'SUBJECT', true], ['V_SELF_REPORTED_MATCH', 'SUBJECT', false], ['V_REQUIREMENT_COMPLETE', 'SUBJECT', true],
  ['V_SHA_COLLISION', 'CROSS_SUBJECT', false], ['V_NUMBER_COLLISION', 'CROSS_SUBJECT', false], ['V_PHASH_NEAR', 'CROSS_SUBJECT', false], ['V_VELOCITY', 'CROSS_SUBJECT', false],
];
/** §7.2: the two Guyana-specific validators name their class. */
const SPEC_TYPE_SPECIFIC: Record<string, string> = { V_TIN_FORMAT: registryCode('GY', 'tin_certificate'), V_INSURANCE_SCOPE: registryCode('GY', 'vehicle_insurance'),
  V_LICENCE_CLASS: registryCode('GY', 'drivers_licence'), // [P3-3] the licence-class rule is the licence's — scoped by the registry (DOC-INV-2)
};
const PROBE = registryCode('GY', 'storefront_photo');

let app: FastifyInstance;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-validator-registry-test');
const resetProbe = () => system(async () => {
  await app.prisma.docField.deleteMany({ where: { docTypeCode: PROBE } });
  await app.prisma.docType.update({ where: { code: PROBE }, data: { isActive: false, legalFactsVerifiedAt: null, extractionProfile: 'UNPROFILED' } });
});

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
  await system(() => seedDocRegistry(app.prisma));
  await resetProbe();
});
afterAll(async () => { await resetProbe(); await app.close(); });

describe('[DOC-1 P7-1] the validator registry (test_registry_completeness)', () => {
  it('holds exactly the §7.2–7.5 validators, with the spec’s scope and blocking, the two Guyana-specific ones naming their class', async () => {
    const rows = await system(() => app.prisma.validator.findMany({ orderBy: { code: 'asc' } }));
    const got = rows.map((r) => [r.code, r.scope, r.isBlocking] as const).sort((a, b) => a[0].localeCompare(b[0]));
    expect(got).toEqual([...SPEC_VALIDATORS].sort((a, b) => a[0].localeCompare(b[0])));
    for (const r of rows) expect(r.docTypeCode).toBe(SPEC_TYPE_SPECIFIC[r.code] ?? null);
    for (const r of rows) expect(r.detailCode.length).toBeGreaterThan(0);
  });

  it('every implementation reference resolves, and every implementation is referenced by exactly one row — no phantom, no orphan', async () => {
    const rows = await system(() => app.prisma.validator.findMany({ where: { implRef: { not: null } } }));
    expect(rows.map((r) => r.code).sort()).toEqual(expect.arrayContaining(['V_ALL_REQUIRED_PRESENT', 'V_SHA_COLLISION']));
    for (const r of rows) expect(resolvesImpl(r.implRef)).toBe(true);
    const refs = rows.map((r) => r.implRef!).sort();
    expect(refs).toEqual(Object.keys(VALIDATOR_IMPLEMENTATIONS).sort());
    expect(resolvesImpl('validators#V_NOPE')).toBe(false);
    expect(resolvesImpl(null)).toBe(false);
  });

  it('the seed reconciles: a row the catalogue no longer declares is removed — unless a field still names it, and then it is reported as STALE_VALIDATOR', async () => {
    await system(() => app.prisma.validator.create({ data: { code: 'V_STRAY_UNREFERENCED', scope: 'FIELD', isBlocking: true, detailCode: 'X' } }));
    await system(() => app.prisma.validator.create({ data: { code: 'V_STRAY_REFERENCED', scope: 'FIELD', isBlocking: true, detailCode: 'X' } }));
    await system(() => app.prisma.docField.create({ data: { docTypeCode: PROBE, fieldCode: 'stray_field', dataType: 'text', isRequired: false, isPii: false, displayOrder: 9, validatorRef: 'V_STRAY_REFERENCED' } }));
    try {
      await system(() => seedDocRegistry(app.prisma));
      const codes = (await system(() => app.prisma.validator.findMany({ where: { code: { startsWith: 'V_STRAY_' } }, select: { code: true } }))).map((r) => r.code);
      expect(codes).toEqual(['V_STRAY_REFERENCED']);
      const gaps = await system(() => registryCompletenessGaps(app.prisma, resolvesImpl));
      expect(gaps.filter((g) => g.gap === 'STALE_VALIDATOR').map((g) => g.detail)).toEqual(['V_STRAY_REFERENCED']);
    } finally {
      await system(() => app.prisma.docField.deleteMany({ where: { docTypeCode: PROBE, fieldCode: 'stray_field' } }));
      await system(() => app.prisma.validator.deleteMany({ where: { code: { startsWith: 'V_STRAY_' } } }));
    }
  });

  it('a required field cannot name a validator that does not exist — the database holds the reference', async () => {
    await expect(system(() => app.prisma.docField.create({ data: {
      docTypeCode: PROBE, fieldCode: 'doc_number', dataType: 'text', isRequired: true, isPii: false, displayOrder: 1, validatorRef: 'V_NOPE',
    } }))).rejects.toThrow(/doc_field_validatorRef_fkey|Foreign key/);
  });

  it('completeness gaps: none for the registry as seeded; an activated type is named for every way it cannot be validated, and each fix removes exactly its gap', async () => {
    const kinds = (gaps: Awaited<ReturnType<typeof registryCompletenessGaps>>) => new Set(gaps.filter((g) => g.docTypeCode === PROBE).map((g) => g.gap));
    let gaps = await system(() => registryCompletenessGaps(app.prisma, resolvesImpl));
    expect(gaps.filter((g) => g.gap === 'IMPL_MISSING')).toEqual([]);
    expect(gaps.filter((g) => g.docTypeCode === PROBE)).toEqual([]);
    await system(() => app.prisma.docType.update({ where: { code: PROBE }, data: { isActive: true, legalFactsVerifiedAt: new Date() } }));
    gaps = await system(() => registryCompletenessGaps(app.prisma, resolvesImpl));
    expect(kinds(gaps)).toEqual(new Set(['UNPROFILED', 'NO_FIELDS', 'VALIDATOR_NOT_IMPLEMENTED']));
    // every blocking validator that applies and has no implementation is named — V_TYPE_MATCH is one; the non-blocking V_TAMPER_HEURISTIC is not
    const unimplemented = gaps.filter((g) => g.docTypeCode === PROBE && g.gap === 'VALIDATOR_NOT_IMPLEMENTED').map((g) => g.detail);
    expect(unimplemented).toContain('V_TYPE_MATCH');
    expect(unimplemented).not.toContain('V_TAMPER_HEURISTIC');
    expect(unimplemented).not.toContain('V_ALL_REQUIRED_PRESENT');
    await system(() => app.prisma.docType.update({ where: { code: PROBE }, data: { extractionProfile: 'PROBE_PROFILE' } }));
    await system(() => app.prisma.docField.create({ data: { docTypeCode: PROBE, fieldCode: 'doc_number', dataType: 'text', isRequired: true, isPii: false, displayOrder: 1 } }));
    gaps = await system(() => registryCompletenessGaps(app.prisma, resolvesImpl));
    expect(kinds(gaps)).toEqual(new Set(['REQUIRED_FIELD_WITHOUT_VALIDATOR', 'VALIDATOR_NOT_IMPLEMENTED']));
    await system(() => app.prisma.docField.update({ where: { docTypeCode_fieldCode: { docTypeCode: PROBE, fieldCode: 'doc_number' } }, data: { validatorRef: 'V_TYPE_MATCH' } }));
    gaps = await system(() => registryCompletenessGaps(app.prisma, resolvesImpl));
    expect(gaps.some((g) => g.docTypeCode === PROBE && g.gap === 'VALIDATOR_NOT_IMPLEMENTED' && g.detail === 'doc_number → V_TYPE_MATCH')).toBe(true);
    await system(() => app.prisma.docField.update({ where: { docTypeCode_fieldCode: { docTypeCode: PROBE, fieldCode: 'doc_number' } }, data: { validatorRef: 'V_ALL_REQUIRED_PRESENT' } }));
    gaps = await system(() => registryCompletenessGaps(app.prisma, resolvesImpl));
    expect(gaps.some((g) => g.docTypeCode === PROBE && g.gap === 'REQUIRED_FIELD_WITHOUT_VALIDATOR')).toBe(false);
    expect(gaps.some((g) => g.docTypeCode === PROBE && g.detail === 'doc_number → V_ALL_REQUIRED_PRESENT')).toBe(false);
    await resetProbe();
    gaps = await system(() => registryCompletenessGaps(app.prisma, resolvesImpl));
    expect(gaps.filter((g) => g.docTypeCode === PROBE)).toEqual([]);
  });

  it('the ledger judges FROM the registry: nothing registered → nothing judged; an unimplemented row writes no verdict; a FAIL carries the registry’s detail code', async () => {
    const base = { declared: [{ fieldCode: 'doc_number', isRequired: true, isBlindIndexed: false }], profileCode: 'P', engine: { name: 't', version: '1', external: false }, extracted: undefined, startedAt: new Date(), finishedAt: new Date(), collided: true };
    const none = await planExtraction({ ...base, validators: [] });
    expect(none.validations).toEqual([]);
    expect(none.blockingFail).toBe(false);
    const registry: RegisteredValidator[] = [
      { code: 'V_ALL_REQUIRED_PRESENT', isBlocking: true, detailCode: 'X_FROM_REGISTRY', implRef: 'validators#V_ALL_REQUIRED_PRESENT' },
      { code: 'V_SHA_COLLISION', isBlocking: false, detailCode: 'DUPLICATE_ACROSS_ACCOUNTS', implRef: 'validators#V_SHA_COLLISION' },
      { code: 'V_TYPE_MATCH', isBlocking: true, detailCode: 'WRONG_DOCUMENT_TYPE', implRef: null },
    ];
    const plan = await planExtraction({ ...base, validators: registry });
    expect(plan.validations).toEqual([
      { validatorCode: 'V_ALL_REQUIRED_PRESENT', status: 'FAIL', detailCode: 'X_FROM_REGISTRY', isBlocking: true },
      { validatorCode: 'V_SHA_COLLISION', status: 'WARN', detailCode: 'CROSS_SUBJECT_SHA', isBlocking: false },
    ]);
    expect(plan.blockingFail).toBe(true);
  });

  it('production refuses to boot past an incomplete registry for active types (the seed block names the gaps and throws only in production)', () => {
    const server = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
    const seedAt = server.indexOf('seedDocRegistry(app.prisma)');
    const block = server.slice(seedAt, server.indexOf('app.markBootContractsComplete();', seedAt));
    expect(block).toContain('registryCompletenessGaps(app.prisma, resolvesImpl)');
    expect(block).toMatch(/if \(isProduction\(\)\) \{\s*throw new Error/);
  });
});
