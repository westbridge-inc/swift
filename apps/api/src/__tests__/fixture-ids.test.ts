import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { TEST_PHONE_DIR_ENV, TEST_PHONE_PATTERN, fixtureTag, testPhone } from './helpers/fixture-ids';
import setupTestPhones from './setup/test-phones';

// [VERIFY row 302 · flake classes 2 + 3] The fixture-id helpers every suite
// leans on: phones unique across the whole run, tags valid for every pattern.

const db = new PrismaClient();
const made: string[] = [];
afterAll(async () => {
  if (made.length) await db.user.deleteMany({ where: { id: { in: made } } });
  await db.$disconnect();
});

describe('testPhone() — one run-wide count in a block nobody else mints', () => {
  it('the run’s global setup is in force (the claim directory exists), so the count is shared by every file', () => {
    const dir = process.env[TEST_PHONE_DIR_ENV];
    expect(dir).toBeTruthy();
    expect(Number.isInteger(Number(readFileSync(join(dir!, 'next'), 'utf8')))).toBe(true);
  });

  it('hands out distinct ten-digit fictional numbers (+59206nnnnn) only', () => {
    const phones = Array.from({ length: 2000 }, () => testPhone());
    expect(new Set(phones).size).toBe(phones.length);
    for (const p of phones) expect(p).toMatch(TEST_PHONE_PATTERN);
    for (const p of phones) expect(p).toMatch(/^\+5920\d{6}$/); // scripts/livetest/guard.ts FICTIONAL_GY
  });

  it('never re-issues a number another process already claimed', () => {
    const dir = process.env[TEST_PHONE_DIR_ENV]!;
    const next = Number(readFileSync(join(dir, 'next'), 'utf8'));
    mkdirSync(join(dir, String(next)));      // another file/worker took it first
    mkdirSync(join(dir, String(next + 1)));
    expect(testPhone()).toBe(`+59206${String(next + 2).padStart(5, '0')}`);
  });

  it('a run starts past the block numbers already in the database (a local DB keeps earlier runs’ users)', async () => {
    const leftover = await db.user.create({ data: { phone: '+5920699000', firstName: 'Leftover', lastName: 'Fixture', roles: ['CUSTOMER'], activeRole: 'CUSTOMER' } });
    made.push(leftover.id);
    const previous = process.env[TEST_PHONE_DIR_ENV];
    try {
      const teardown = await setupTestPhones();
      try {
        expect(testPhone()).toBe('+5920699001');
      } finally {
        teardown();
      }
    } finally {
      process.env[TEST_PHONE_DIR_ENV] = previous;
    }
  });
});

describe('fixtureTag() — valid in every id, slug and upper-cased reference pattern', () => {
  it('draws only 0-9a-z, so ^[A-Z0-9-]+$ (the fee-receipt param) accepts it every time', () => {
    for (let i = 0; i < 5000; i += 1) {
      const tag = fixtureTag(6);
      expect(tag).toMatch(/^[0-9a-z]{6}$/);
      expect(`TENANT-B-PRIVATE-${tag.toUpperCase()}`).toMatch(/^[A-Z0-9-]{1,64}$/);
    }
  });
});

describe('the census — nothing but testPhone() mints a number in its block', () => {
  const REPO = resolve(__dirname, '../../../..');
  const OWNERS = new Set(['apps/api/src/__tests__/helpers/fixture-ids.ts', 'apps/api/src/__tests__/fixture-ids.test.ts', 'apps/api/src/__tests__/setup/test-phones.ts']);
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.') || name === 'dist' || name === 'build') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx|js|mjs|cjs|py|sh|sql)$/.test(name)) out.push(full);
    }
    return out;
  };

  it('no other file writes a +59206nnnnn number (literal or template), so the run count can never meet one', () => {
    // a ten-digit +59206… literal, or a template that starts building one
    const MINT = /\+59206(\d{5}(?!\d)|\$\{)/;
    const offenders = ['apps/api/src', 'scripts', 'deploy']
      .flatMap((d) => walk(join(REPO, d)))
      .map((f) => relative(REPO, f))
      .filter((f) => !OWNERS.has(f) && MINT.test(readFileSync(join(REPO, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
