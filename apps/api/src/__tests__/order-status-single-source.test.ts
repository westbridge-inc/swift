import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Prisma, TaxiStopStatus } from '@prisma/client';
import {
  TERMINAL_ORDER_STATUSES,
  LIVE_ORDER_STATUSES,
  isTerminalOrderStatus,
  TAXI_STOP_LAW,
  TAXI_STOP_OPEN_STATUSES,
  TAXI_STOP_TRANSITIONS,
  isTaxiStopOpen,
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

/** The six statuses, in any order, as they appear in a literal list. */
const TERMINAL_NAMES = ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED', 'RETURNED'];

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

  it('the exported set is exactly the six terminal statuses', () => {
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
    // A literal array containing all six names, in any order, on one line.
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
      // A SQL IN-list: the six names quoted inside a NOT IN (...) / IN (...).
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
    // The Record keyed by OrderStatus is the guarantee: it is what makes a NEW
    // OrderStatus a build error. If someone replaces it with a plain array,
    // this file stops protecting anything and the gate must say so.
    //
    // [ORD-1] It grades the SHAPE, not the value type's name. Terminality is
    // no longer a Record of its own — it is derived from the custody
    // classification, because a status is terminal exactly when nobody holds
    // the order, and two independent Records would have been the same drift
    // this file exists to prevent. What must hold is that ONE exhaustive
    // Record exists and the lists come off it.
    const owner = readFileSync(join(SRC, OWNER), 'utf8');
    expect(owner).toMatch(/Record<OrderStatus,/);
    expect(owner).toMatch(/\.filter\(/);
    // And the terminal list must stay DERIVED — never a second hand-written
    // array smuggled back into the owner itself.
    expect(stripComments(owner)).not.toMatch(/TERMINAL_ORDER_STATUSES[^=\n]*=\s*\[\s*'/);
  });
});

// ---------------------------------------------------------------------------
// [TAXI multi-stop] A taxi stop's states are the TENTH member of this family,
// and they get the same two guarantees. The law is a Record keyed by the
// Prisma enum (a new stop state fails the BUILD until it is classified), and
// no other file may re-declare a stop list or a stop edge, in TypeScript or
// in SQL. Three of the four names (PENDING, ARRIVED, SKIPPED) also belong to
// other enums, so the scan is precise rather than loud: a list is a stop list
// when it carries a name no other enum uses (DEPARTED), or when it sits in a
// file that handles taxi stops and holds nothing but stop states.
// ---------------------------------------------------------------------------

describe('[TAXI multi-stop] the stop law has ONE definition', () => {
  const files = walk(SRC);
  const rel = (f: string) => f.replace(SRC, 'src');
  const STOP_STATES = Object.values(TaxiStopStatus) as string[];
  const OTHER_ENUM_VALUES = new Set(Prisma.dmmf.datamodel.enums
    .filter((e) => e.name !== 'TaxiStopStatus')
    .flatMap((e) => e.values.map((v) => v.name)));
  /** Names only the stop enum uses: a list holding one can only be a stop list. */
  const STOP_ONLY = STOP_STATES.filter((s) => !OTHER_ENUM_VALUES.has(s));
  const STOP_FILE = /TaxiStopStatus|TaxiTripStop|taxiTripStop|taxi_trip_stops|taxiStops/;
  const STOP_ALT = STOP_STATES.join('|');
  const STOP_EDGE = new RegExp(`\\b(${STOP_ALT})\\s*:\\s*\\[\\s*'(${STOP_ALT})'`);
  // Guarded: were no name unique to stops, an empty alternation would match every `: [`.
  const STOP_ONLY_EDGE = STOP_ONLY.length > 0 ? new RegExp(`\\b(${STOP_ONLY.join('|')})\\s*:\\s*\\[`) : null;
  const TYPED_STOP_LITERAL = /TaxiStopStatus\[\]\s*=\s*\[|Set<TaxiStopStatus>\(\s*\[|satisfies\s+(readonly\s+)?TaxiStopStatus\[\]/;

  it('classifies every TaxiStopStatus the database defines, in both tables — none unclassified, no stray key', () => {
    expect([...STOP_STATES].sort()).toEqual(['ARRIVED', 'DEPARTED', 'PENDING', 'SKIPPED']);
    expect(Object.keys(TAXI_STOP_LAW).sort()).toEqual([...STOP_STATES].sort());
    expect(Object.keys(TAXI_STOP_TRANSITIONS).sort()).toEqual([...STOP_STATES].sort());
    for (const s of STOP_STATES as TaxiStopStatus[]) expect(['OPEN', 'RESOLVED']).toContain(TAXI_STOP_LAW[s]);
  });

  it('the open set is exactly a stop not yet reached, or reached and not yet left', () => {
    expect([...TAXI_STOP_OPEN_STATUSES].sort()).toEqual(['ARRIVED', 'PENDING']);
    for (const s of STOP_STATES as TaxiStopStatus[]) {
      expect(isTaxiStopOpen(s)).toBe(TAXI_STOP_LAW[s] === 'OPEN');
      expect(isTaxiStopOpen(s)).toBe(TAXI_STOP_OPEN_STATUSES.includes(s));
    }
  });

  it('the owner derives the open list from an exhaustive Record rather than hand-writing it', () => {
    const owner = readFileSync(join(SRC, OWNER), 'utf8');
    expect(owner).toMatch(/Record<TaxiStopStatus,/);
    expect(stripComments(owner)).toMatch(/TAXI_STOP_OPEN_STATUSES[^=\n]*=[^;]*\.filter\(/);
    expect(stripComments(owner)).not.toMatch(/TAXI_STOP_OPEN_STATUSES[^=\n]*=\s*\[\s*'/);
  });

  it('the scan has something to recognise: DEPARTED belongs to no other enum', () => {
    expect(STOP_ONLY).toEqual(['DEPARTED']);
  });

  it('no file re-declares a stop-status list or a stop edge, in TypeScript or in SQL', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith(OWNER)) continue;
      const code = stripComments(readFileSync(file, 'utf8'));
      const stopFile = STOP_FILE.test(code);
      const lists = [...(code.match(/\[[^[\]]*\]/g) ?? []), ...(code.match(/\bIN\s*\([^)]*\)/gi) ?? [])];
      for (const list of lists) {
        const names = list.match(/'[A-Z_]+'/g)?.map((q) => q.slice(1, -1)) ?? [];
        const stops = names.filter((n) => STOP_STATES.includes(n));
        const unmistakable = stops.length >= 2 && stops.some((n) => STOP_ONLY.includes(n));
        const inAStopFile = stopFile && stops.length >= 2 && stops.length === names.length;
        if (unmistakable || inAStopFile) offenders.push(`${rel(file)}: ${list.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
      if ((stopFile && STOP_EDGE.test(code)) || STOP_ONLY_EDGE?.test(code)) offenders.push(`${rel(file)}: a stop transition table`);
      if (TYPED_STOP_LITERAL.test(code)) offenders.push(`${rel(file)}: a literal typed as TaxiStopStatus`);
    }
    expect(offenders, 'import TAXI_STOP_OPEN_STATUSES / TAXI_STOP_TRANSITIONS from modules/order/order-status instead').toEqual([]);
  });
});
