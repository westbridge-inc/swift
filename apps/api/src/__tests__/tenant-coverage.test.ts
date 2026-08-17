import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { TENANT_MODEL_NAMES } from '../plugins/prisma';

// ---------------------------------------------------------------------------
// [F-0009] The structural tenant-coverage gate (audit doc 3.2:
// "coverage that is generated, never maintained by hand").
//
// The tenant-scoping registration used to be a hand-written list. Nothing tied
// it to the schema, so it quietly fell behind: 47 models carried a tenantId
// column and 10 were enrolled. A developer adding a tenant-owned model got a
// green CI and an unscoped model, and the gap regrew after every fix.
//
// This test derives the truth from the Prisma DMMF at run time. Every model
// carrying a tenantId column must be either registered for scoping or on the
// reasoned exemption list below. There is no third option, and no way to add a
// model without this test having an opinion about it.
//
// It needs no database — it reads the generated client's datamodel.
// ---------------------------------------------------------------------------

/**
 * Models that carry a tenantId column and are deliberately NOT auto-scoped.
 * Each needs a reason a reviewer can check. Adding an entry here is a decision;
 * leaving a model out of both lists is a bug this test refuses to let ship.
 */
const DELIBERATELY_UNSCOPED: Record<string, string> = {
  identitykey:
    'Trial-abuse and duplicate-identity matching is platform-wide BY DESIGN — the one sanctioned ' +
    'cross-tenant system (schema: IdentityKey, "the one sanctioned cross-tenant system"). Scoping it ' +
    'would let the same person take a fresh trial on every operator, which is the abuse it exists to stop. ' +
    'Values are HMAC-hashed, never raw, so platform-wide matching leaks no PII across tenants.',
  santombstone:
    'Swift Account Numbers are globally unique payment addresses and can never be recycled. A tombstone ' +
    'from one tenant must remain visible to every allocator and resolver; tenant-scoping this registry can ' +
    'reissue a retired number to another tenant and misroute a late cash payment. tenantId is audit ' +
    'provenance only, not an authorization boundary for this platform-wide deny registry.',
};

const modelsWithTenantId = Prisma.dmmf.datamodel.models
  .filter((m) => m.fields.some((f) => f.name === 'tenantId'))
  .map((m) => m.name);

const registered = new Set(TENANT_MODEL_NAMES.map((n) => n.toLowerCase()));

describe('[F-0009] tenant scoping covers every tenant-owned model', () => {
  it('the schema actually has tenant-owned models to check (guards against a vacuous pass)', () => {
    // If the DMMF filter ever silently returns nothing, every assertion below
    // would pass while proving nothing. Pin the floor.
    expect(modelsWithTenantId.length).toBeGreaterThan(40);
  });

  it('every model carrying a tenantId column is scoped, or exempted with a reason', () => {
    const unaccounted = modelsWithTenantId.filter((name) => {
      const key = name.toLowerCase();
      return !registered.has(key) && !(key in DELIBERATELY_UNSCOPED);
    });

    expect(
      unaccounted,
      unaccounted.length === 0
        ? ''
        : `These models carry a tenantId column but are neither scoped nor exempted:\n` +
          unaccounted.map((n) => `  • ${n}`).join('\n') +
          `\n\nAdd each to TENANT_MODEL_NAMES in src/plugins/prisma.ts, or to ` +
          `DELIBERATELY_UNSCOPED in this file with a reason a reviewer can check. ` +
          `An unscoped tenant-owned model is a cross-tenant leak waiting for a second operator.`,
    ).toEqual([]);
  });

  it('the scoping list has no stale entries — every registered model still exists', () => {
    const allModels = new Set(Prisma.dmmf.datamodel.models.map((m) => m.name.toLowerCase()));
    const stale = TENANT_MODEL_NAMES.filter((n) => !allModels.has(n.toLowerCase()));

    expect(stale, `Registered for tenant scoping but no longer in the schema: ${stale.join(', ')}`).toEqual([]);
  });

  it('every registered model genuinely has a tenantId column to scope on', () => {
    // Registering a model with no tenantId would make the extension inject a
    // filter on a column that does not exist — a run-time error on first use,
    // in whichever route touched it first.
    const withTenantId = new Set(modelsWithTenantId.map((n) => n.toLowerCase()));
    const bogus = TENANT_MODEL_NAMES.filter((n) => !withTenantId.has(n.toLowerCase()));

    expect(bogus, `Registered for tenant scoping but carries no tenantId column: ${bogus.join(', ')}`).toEqual([]);
  });

  it('every exemption names a model that actually exists', () => {
    const allModels = new Set(Prisma.dmmf.datamodel.models.map((m) => m.name.toLowerCase()));
    const ghosts = Object.keys(DELIBERATELY_UNSCOPED).filter((k) => !allModels.has(k));

    expect(ghosts, `Exempted from tenant scoping but not in the schema: ${ghosts.join(', ')}`).toEqual([]);
  });

  it('no exemption is a bare assertion — each carries a real reason', () => {
    const thin = Object.entries(DELIBERATELY_UNSCOPED)
      .filter(([, reason]) => reason.trim().length < 60)
      .map(([model]) => model);

    expect(thin, `Exemptions needing a real justification: ${thin.join(', ')}`).toEqual([]);
  });
});
