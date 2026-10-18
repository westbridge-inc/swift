import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { customAlphabet } from 'nanoid';

/**
 * [VERIFY row 302 · flake classes 2 + 3] Fixture identifiers that are VALID and
 * UNIQUE BY CONSTRUCTION, so no suite fails at random on its own test data.
 *
 * CLASS 2 — `Unique constraint failed on the fields: (phone)`. Every API suite
 * shares ONE Postgres database per run (vitest.config.ts runs files one at a
 * time on it, and most files leave their users behind). Suites minted phones
 * from `Math.random()`, `Date.now()` slices or `nanoid`, each from its own
 * hand-picked range; the ranges overlap (a fixed `+59200711NN` block sits
 * inside the whole-block `+5920${random6}` draws, ninety-thousand-number
 * pools are shared by several files), so a draw sometimes lands on a number an
 * earlier file left in the table and that suite reds for nothing it tests.
 *
 * `testPhone()` hands out numbers from ONE block no other generator writes —
 * `+59206` followed by five digits (100,000 numbers) — inside the reserved
 * fictional range (`+5920…`, scripts/livetest/guard.ts FICTIONAL_GY: ten digits,
 * never a subscriber). The count is shared by every test file of a run: the
 * vitest global setup (setup/test-phones.ts) starts it just past the highest
 * number of the block already in the database (so rows a previous local run
 * left behind are never re-issued) and every number is CLAIMED atomically
 * (`mkdir` of the number in the run's claim directory fails if any process
 * already holds it), so two files — or two workers, if the config ever runs
 * files in parallel — can never be handed the same number.
 *
 * CLASS 3 — a random tag that fails a validator. `nanoid()` draws from
 * `A-Za-z0-9_-`; a fixture id or receipt number built from it fails any
 * stricter pattern (`^[A-Z0-9-]+$` rejects `_`, ~9% of six-character tags) and
 * the suite reds with a 400 it never meant to test. `fixtureTag()` draws only
 * from `0-9a-z`, which every id, slug and (upper-cased) reference pattern of
 * the API accepts.
 */

export const TEST_PHONE_BLOCK = '+59206';
export const TEST_PHONE_BLOCK_SIZE = 100_000;
/** The phones testPhone() can return — and nothing else in the suites may mint. */
export const TEST_PHONE_PATTERN = /^\+59206\d{5}$/;

/** Set by setup/test-phones.ts for the whole run: the claim directory and its next-number hint. */
export const TEST_PHONE_DIR_ENV = 'SWIFT_TEST_PHONE_DIR';

const format = (n: number) => `${TEST_PHONE_BLOCK}${String(n % TEST_PHONE_BLOCK_SIZE).padStart(5, '0')}`;

let fallbackNext: number | undefined;

/**
 * A fresh `+59206nnnnn` number no other call in this run has returned.
 * Throws when the block is exhausted rather than ever re-issuing a number.
 */
export function testPhone(): string {
  const dir = process.env[TEST_PHONE_DIR_ENV];
  if (!dir) {
    // Only reachable outside vitest.config.ts (a side config without its global
    // setup): unique within this process, from a random start in the block.
    fallbackNext ??= Math.floor(Math.random() * TEST_PHONE_BLOCK_SIZE);
    return format(fallbackNext++);
  }
  const hintFile = join(dir, 'next');
  const start = Number(readFileSync(hintFile, 'utf8'));
  for (let i = 0; i < TEST_PHONE_BLOCK_SIZE; i += 1) {
    const n = (start + i) % TEST_PHONE_BLOCK_SIZE;
    try {
      mkdirSync(join(dir, String(n)));
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') continue;
      throw error;
    }
    writeFileSync(hintFile, String(n + 1));
    return format(n);
  }
  throw new Error(`[test-phones] all ${TEST_PHONE_BLOCK_SIZE} numbers of ${TEST_PHONE_BLOCK}… are claimed this run`);
}

const tagAlphabet = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz');

/** A random tag of `0-9a-z` (default 8 characters): valid in every id, slug and upper-cased reference pattern. */
export function fixtureTag(length = 8): string {
  return tagAlphabet(length);
}
