import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { normalize, scoreCategory, suggestCategories, CAT_MATCH_MIN } from '../modules/discovery/matcher';
import { SEED_TAXONOMY, seedDiscoveryTaxonomy } from '../modules/discovery/taxonomy.seed';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fixtureFile = JSON.parse(
  readFileSync(resolve(__dirname, '../modules/discovery/fixtures/category-labels.json'), 'utf8'),
) as { fixtures: Array<{ text: string; expected: string }> };

// ---------------------------------------------------------------------------
// FIND-BY-CRAVING — Stage-A matcher accuracy (CAT-D, the merge gate) + the
// seed taxonomy (CAT-A slice). The 120 labeled Guyanese catalog lines are
// living documentation; the gate is precision ≥ 85% / recall ≥ 70%. Misses
// are fixed by EXTENDING aliases, never by lowering the gate.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({
  datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } },
});

const TENANT = `cat-test-${Math.floor(Math.random() * 1_000_000)}`;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.discoveryCategory.deleteMany({ where: { tenantId: TENANT } });
  await prisma.$disconnect();
});

describe('normalize', () => {
  it('lowercases, strips accents and punctuation, collapses whitespace', () => {
    expect(normalize('Cook-Up  Rice!')).toBe('cook up rice');
    expect(normalize('Pholourie — with sour')).toBe('pholourie with sour');
    expect(normalize('Café Créole')).toBe('cafe creole');
  });
});

describe('scoreCategory weights (spec Part 4 Stage A)', () => {
  const cat = { slug: 'chinese', name: 'Chinese', aliases: ['chowmein', 'chow mein', 'fried rice'] };

  it('phrase in name = 1.0; single word in name = 0.7', () => {
    expect(scoreCategory({ name: 'Chicken chow mein' }, cat)).toBeGreaterThanOrEqual(1);
    expect(scoreCategory({ name: 'Chicken chowmein' }, cat)).toBeCloseTo(0.7, 5);
  });

  it('phrase in description = 0.5; word in description = 0.3; capped at 1', () => {
    expect(scoreCategory({ name: 'Lunch special', description: 'our famous fried rice' }, cat)).toBeCloseTo(0.5, 5);
    expect(scoreCategory({ name: 'Lunch special', description: 'with chowmein on the side' }, cat)).toBeCloseTo(0.3, 5);
    expect(scoreCategory({ name: 'Chow mein chowmein fried rice chinese' }, cat)).toBe(1);
  });

  it('word boundaries hold — "rice" never hits "price"', () => {
    const rice = { slug: 'rice-grains', name: 'Rice & Grains', aliases: ['rice'] };
    expect(scoreCategory({ name: 'Best price electronics' }, rice)).toBe(0);
  });

  it('suggestions cap at 3, sorted best-first, floor at CAT_MATCH_MIN', () => {
    const out = suggestCategories({ name: 'Vegan chowmein with tofu and fried rice' }, SEED_TAXONOMY);
    expect(out.length).toBeLessThanOrEqual(3);
    expect(out[0]!.confidence).toBeGreaterThanOrEqual(out[out.length - 1]!.confidence);
    for (const s of out) expect(s.confidence).toBeGreaterThanOrEqual(CAT_MATCH_MIN);
  });
});

describe('CAT-D: the 120-line accuracy gate', () => {
  it('precision ≥ 85% and recall ≥ 70% against the seed taxonomy', () => {
    const fixtures = fixtureFile.fixtures as Array<{ text: string; expected: string }>;
    expect(fixtures.length).toBeGreaterThanOrEqual(120);

    // Every expected label must exist in the seed taxonomy (fixture hygiene).
    const slugs = new Set(SEED_TAXONOMY.map((c) => c.slug));
    for (const f of fixtures) expect(slugs.has(f.expected), `unknown slug ${f.expected}`).toBe(true);

    let predicted = 0;
    let correct = 0;
    const misses: string[] = [];
    for (const f of fixtures) {
      const top = suggestCategories({ name: f.text }, SEED_TAXONOMY)[0];
      if (!top) {
        misses.push(`NO-SUGGESTION: "${f.text}" (wanted ${f.expected})`);
        continue;
      }
      predicted += 1;
      if (top.slug === f.expected) correct += 1;
      else misses.push(`WRONG: "${f.text}" → ${top.slug} (wanted ${f.expected})`);
    }
    const precision = predicted === 0 ? 0 : correct / predicted;
    const recall = correct / fixtures.length;
    // The evidence line CI logs (CAT-D):
    // eslint-disable-next-line no-console
    console.log(`CAT-D matcher: precision=${(precision * 100).toFixed(1)}% recall=${(recall * 100).toFixed(1)}% (${correct}/${predicted} predicted, ${fixtures.length} fixtures)`);
    if (precision < 0.85 || recall < 0.7) {
      // eslint-disable-next-line no-console
      console.log(misses.slice(0, 25).join('\n'));
    }
    expect(precision).toBeGreaterThanOrEqual(0.85);
    expect(recall).toBeGreaterThanOrEqual(0.7);
  });
});

describe('the seed taxonomy (CAT-A slice)', () => {
  it('seeds 42 categories idempotently; founder edits survive; alias unions reach existing tenants', async () => {
    expect(SEED_TAXONOMY).toHaveLength(42);
    const first = await seedDiscoveryTaxonomy(prisma, TENANT);
    expect(first.created).toBe(42);

    const again = await seedDiscoveryTaxonomy(prisma, TENANT);
    expect(again.created).toBe(0);
    expect(again.aliasUpdated).toBe(0);

    // Founder renames + admin-added alias survive a re-seed; shipped alias
    // additions still union in.
    await prisma.discoveryCategory.update({
      where: { tenantId_slug: { tenantId: TENANT, slug: 'chinese' } },
      data: { name: 'Chinese & Wok', aliases: { push: 'dumplings' } },
    });
    const third = await seedDiscoveryTaxonomy(prisma, TENANT);
    expect(third.created).toBe(0);
    const chinese = await prisma.discoveryCategory.findUniqueOrThrow({
      where: { tenantId_slug: { tenantId: TENANT, slug: 'chinese' } },
    });
    expect(chinese.name).toBe('Chinese & Wok'); // rename untouched
    expect(chinese.aliases).toContain('dumplings'); // admin alias kept
    expect(chinese.aliases).toContain('chowmein'); // seeds still present
  });

  it('slugs are unique per tenant and kebab-case; every category has an emoji', () => {
    const seen = new Set<string>();
    for (const c of SEED_TAXONOMY) {
      expect(seen.has(c.slug)).toBe(false);
      seen.add(c.slug);
      expect(c.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(c.emoji.length).toBeGreaterThan(0);
      expect(c.aliases.every((a) => a === a.toLowerCase())).toBe(true);
    }
  });
});
