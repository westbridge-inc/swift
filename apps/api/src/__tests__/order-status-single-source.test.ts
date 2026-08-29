import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TERMINAL_ORDER_STATUSES,
  LIVE_ORDER_STATUSES,
  isTerminalOrderStatus,
} from '../modules/order/order-status';

// ---------------------------------------------------------------------------
// "Which order statuses are terminal" had THIRTEEN declarations across
// apps/api/src: the exported one, locals in mover-authority (custody), the
// dispatch service, the delivery watchdog (rescue), order-sla, account.service
// and trip-share, an inline literal in admin.routes — inside a file that was
// ALREADY importing the shared constant 1,500 lines above it — and FIVE raw
// SQL string literals in the mover-authority cutover preparation.
//
// All thirteen agreed, and nothing made them. `OrderStatus[]` is not
// exhaustive, so a new state produced no compile error anywhere and the copies
// would have split silently. The SQL strings could never be type-checked.
//
// This gate keeps the collapse permanent. It asserts two different things,
// because either alone is defeatable:
//   1. the LIST is derived from an exhaustive Record (a new state fails the
//      BUILD, not this test), and
//   2. no file re-declares the set as a literal, in TypeScript or in SQL.
//
// HAZARD-MATCHING RULE [run-state §SECOND BURST]: a banned-pattern assertion
// that reads a file's own explanatory COMMENT is satisfied by prose and stays
// green under mutation. Comments are stripped before scanning, and a companion
// assertion proves the stripper did not simply return an empty string.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src');
const OWNER = join('modules', 'order', 'order-status.ts');

/** The five statuses, in any order, as they appear in a literal list. */
const TERMINAL_NAMES = ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Remove line and block comments so prose can never satisfy the assertion. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('terminal order statuses have ONE definition', () => {
  const files = walk(SRC);

  it('the source files were actually found', () => {
    // Guards the walk: a changed layout that returns nothing would make every
    // scan below vacuously green.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith(OWNER))).toBe(true);
  });

  it('the exported set is exactly the five terminal statuses', () => {
    expect([...TERMINAL_ORDER_STATUSES].sort()).toEqual([...TERMINAL_NAMES].sort());
  });

  it('terminal and live partition the enum with no overlap', () => {
    const overlap = TERMINAL_ORDER_STATUSES.filter((s) => (LIVE_ORDER_STATUSES as string[]).includes(s));
    expect(overlap).toEqual([]);
    expect(TERMINAL_ORDER_STATUSES.length + LIVE_ORDER_STATUSES.length).toBeGreaterThan(15);
  });

  it('the predicate agrees with the list', () => {
    for (const s of TERMINAL_ORDER_STATUSES) expect(isTerminalOrderStatus(s)).toBe(true);
    for (const s of LIVE_ORDER_STATUSES) expect(isTerminalOrderStatus(s)).toBe(false);
  });

  it('no file re-declares the set as a TypeScript literal', () => {
    // A literal array containing all five names, in any order, on one line.
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith(OWNER)) continue;
      const code = stripComments(readFileSync(file, 'utf8'));
      // The stripper must not have eaten everything — otherwise this passes blind.
      expect(code.trim().length).toBeGreaterThan(0);
      for (const line of code.split('\n')) {
        const quoted = line.match(/'[A-Z_]+'/g)?.map((q) => q.slice(1, -1)) ?? [];
        if (TERMINAL_NAMES.every((n) => quoted.includes(n))) {
          offenders.push(`${file.replace(SRC, 'src')}: ${line.trim().slice(0, 90)}`);
        }
      }
    }
    expect(offenders, 'import TERMINAL_ORDER_STATUSES from modules/order/order-status instead').toEqual([]);
  });

  it('no raw SQL string re-declares the set', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith(OWNER)) continue;
      const code = stripComments(readFileSync(file, 'utf8'));
      // A SQL IN-list: the five names quoted inside a NOT IN (...) / IN (...).
      const sqlLists = code.match(/\bIN\s*\([^)]*\)/gi) ?? [];
      for (const list of sqlLists) {
        const quoted = list.match(/'[A-Z_]+'/g)?.map((q) => q.slice(1, -1)) ?? [];
        if (TERMINAL_NAMES.every((n) => quoted.includes(n))) {
          offenders.push(`${file.replace(SRC, 'src')}: ${list.slice(0, 90)}`);
        }
      }
    }
    expect(offenders, 'parameterise with ${Prisma.join(TERMINAL_ORDER_STATUSES)}').toEqual([]);
  });

  it('the owner derives the list rather than hand-writing it', () => {
    // The Record is the guarantee: it is what makes a NEW OrderStatus a build
    // error. If someone replaces it with a plain array, this file stops
    // protecting anything and the gate must say so.
    const owner = readFileSync(join(SRC, OWNER), 'utf8');
    expect(owner).toMatch(/Record<OrderStatus,\s*Terminality>/);
    expect(owner).toMatch(/\.filter\(/);
  });
});
