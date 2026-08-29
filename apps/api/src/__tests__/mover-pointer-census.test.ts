import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// [B2 / SWIFT_CONCURRENCY.md §15.4] The census that must not drift.
//
// `currentOrderId` / `currentRideId` is not a lock. It is the ROUTING KEY that
// several subsystems use to answer "which job is this mover on" — custody,
// rescue, safety, ops, the client. Band B keeps that field meaning exactly what
// it means today (THE CURRENT LEG) and adds a plural beside it, precisely so
// most of those subsystems never have to change.
//
// §15.4 asks for this gate in its own words: every file that touches the
// pointer either still reads it with its unchanged meaning, or is on an
// explicit migrated list with a reason. "A thirteenth file quietly learning
// about runs is how this goes wrong."
//
// ⚠️ THE SPEC'S OWN NUMBERS ARE STALE, AND THIS FILE RECORDS THE MEASUREMENT
// RATHER THAN THE CLAIM. §12.2/§15.1 say twelve files and "this single decision
// saves eleven of the twelve". Measured on the tree (REPORT-039, independently
// re-run here): thirteen files mention the names, of which ELEVEN read or write
// a value, and SIX of those eleven must migrate — not one. The other two are
// name-only: live-eta.ts mentions them in a comment while its functions take an
// explicit orderId, and readiness.ts matches index-name strings.
//
// Six-of-eleven is a materially bigger migration than one-of-twelve. Anyone
// planning Band B from the prose alone would under-scope it, which is the whole
// reason this list is in code where CI reads it.
// ---------------------------------------------------------------------------

type Verdict =
  /** Reads the pointer as "the current leg". That meaning survives Band B, so
   *  the file is correct as written and needs no edit. */
  | 'UNTOUCHED'
  /** Would silently do the wrong thing once a mover holds two legs. Named here
   *  with the harm so the migration cannot forget one. */
  | 'MUST_MIGRATE'
  /** Mentions the names without reading a value — a comment, a type, an index
   *  name. Listed so the census is complete and so a real read added to one of
   *  these files shows up as a change of verdict, not as silence. */
  | 'NAME_ONLY'
  /** THE SEAM. The one file whose job is to answer the capacity question, so
   *  it names the columns on purpose. Distinct from MUST_MIGRATE because those
   *  break silently; this one is where the change is MEANT to happen. */
  | 'SEAM';

const CENSUS: Record<string, { verdict: Verdict; why: string }> = {
  // ── the seam ─────────────────────────────────────────────────────────────
  'apps/api/src/modules/dispatch/concurrency-policy.ts': {
    verdict: 'SEAM',
    why: 'B1. It owns moverCapacity() and renders the live-leg predicate for all four gates, so it names both columns deliberately. Raising the capacity changes THIS file — that is the point of it. It arrived after this census was first written and the gate caught its own omission in CI, which is exactly the thirteenth-file failure §15.4 describes.',
  },

  // ── must migrate ─────────────────────────────────────────────────────────
  'apps/api/src/modules/dispatch/dispatch.service.ts': {
    verdict: 'MUST_MIGRATE',
    why: 'candidate filtering, the offer gate and the claim CAS all require the pointer to be null, so a decided second order can neither be offered nor accepted. B1 routed these through concurrency-policy; raising the capacity is the migration.',
  },
  'apps/api/src/modules/rider/rider.routes.ts': {
    verdict: 'MUST_MIGRATE',
    why: ':809 publishes GPS/ETA to one room, so the sibling customer\'s map freezes; :840/:1039 reject a second job; :998 can mark the rider free while sibling work is still live.',
  },
  'apps/api/src/modules/driver/driver.routes.ts': {
    verdict: 'MUST_MIGRATE',
    why: ':555 publishes GPS/ETA to one room. Latent today because taxi is capacity one by policy, not by accident — but the shape is identical to the rider side.',
  },
  'apps/api/src/modules/order/order.service.ts': {
    verdict: 'MUST_MIGRATE',
    why: 'direct assignment requires a null pointer; cancellation and completion clear it and mark the rider available instead of advancing to a still-live sibling leg.',
  },
  'apps/api/src/modules/mover-authority.ts': {
    verdict: 'MUST_MIGRATE',
    why: 'session revocation builds cleanup for the current leg ONLY, so a sibling can stay assigned to a revoked rider with no redispatch, no escalation, no customer notice and no float release. The outbox emitters downstream are already per-effect and correct — this producer is the defect.',
  },
  'apps/api/src/modules/dispatch/delivery-watchdog.ts': {
    verdict: 'MUST_MIGRATE',
    why: 'finds a GPS-dark rider through one pointer and rescues that order; a sibling stays assigned and unrescued, and clearing the pointer removes even the routing key while its work is still live.',
  },

  // ── untouched under current-leg semantics ────────────────────────────────
  'apps/api/src/modules/admin/admin.routes.ts': {
    verdict: 'UNTOUCHED',
    why: 'derives the ops-map "busy" boolean. A non-null current leg still correctly means the mover is busy.',
  },
  'apps/api/src/modules/safety/liveness.service.ts': {
    verdict: 'UNTOUCHED',
    why: 'restricts random mid-shift prompts to idle movers, and clears the taxi pointer for one customer-reported release. Current-leg non-nullness remains the correct "not idle" signal. ⚠️ A safety path must never lose a mover because they hold three jobs — re-read this one if the semantics ever move.',
  },
  'apps/mobile/src/lib/moverProfile.ts': {
    verdict: 'UNTOUCHED',
    why: 'chooses the DRIVER vs RIDER UI by which profile owns the current leg; it does not enumerate jobs. NOTE the separate B6 path: the singular active-job hook it feeds (MoverStack, ActiveJobScreen, MoverHomeScreen) renders only one job and IS a Band B migration.',
  },
  'apps/api/src/modules/mover-authority-cutover-preparation.ts': {
    verdict: 'UNTOUCHED',
    why: 'one-time cutover preparation against the singular pointer as it existed; historical, and correct for what it did.',
  },
  'packages/types/src/rider.ts': {
    verdict: 'UNTOUCHED',
    why: 'a type declaration of the field. It gains a sibling when the plural lands; it does not read a value.',
  },

  // ── name-only ────────────────────────────────────────────────────────────
  'apps/api/src/modules/dispatch/live-eta.ts': {
    verdict: 'NAME_ONLY',
    why: 'the names appear in a comment; every function takes an explicit orderId. It still becomes per-leg for B3, but through its CALLERS (rider.routes :748-754, driver.routes :503-509), which is a different change from a field migration.',
  },
  'apps/api/src/plugins/readiness.ts': {
    verdict: 'NAME_ONLY',
    why: 'matches index NAME strings against pg_index metadata; it never reads a pointer value.',
  },
};

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** The census as the FILESYSTEM reports it — the code actually under test.
 *
 *  This used to `git grep HEAD`, which was wrong in a way that only showed up
 *  in CI: the shared worktree ships via a temp index and never moves HEAD, so
 *  HEAD here is ~90 commits stale. The gate passed locally against an ancient
 *  tree and failed in CI against the real one. Every other source gate in this
 *  suite walks the filesystem; this one now does too. */
const ROOTS = [
  'apps/api/src', 'apps/mobile/src', 'apps/web/src', 'apps/admin/src', 'packages',
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist' || entry === 'generated') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function filesMentioningThePointer(): string[] {
  return ROOTS
    .flatMap((root) => walk(path.join(REPO_ROOT, root)))
    .filter((f) => /currentOrderId|currentRideId/.test(readFileSync(f, 'utf8')))
    .map((f) => path.relative(REPO_ROOT, f))
    .sort();
}

describe('the singular-pointer census [B2 / SWIFT_CONCURRENCY §15.4]', () => {
  it('every file touching currentOrderId/currentRideId is registered with a verdict', () => {
    const actual = filesMentioningThePointer();
    const registered = Object.keys(CENSUS).sort();

    const unregistered = actual.filter((f) => !(f in CENSUS));
    expect(
      unregistered,
      'a file learned about the mover pointer without being classified. Decide whether it reads '
      + '"the current leg" (UNTOUCHED) or would break once a mover holds two legs (MUST_MIGRATE), '
      + 'and say why in CENSUS — this is the thirteenth-file failure §15.4 exists to prevent',
    ).toEqual([]);

    const departed = registered.filter((f) => !actual.includes(f));
    expect(
      departed,
      'registered but no longer mentions the pointer — remove the entry so the list cannot '
      + 'become a place where real entries hide',
    ).toEqual([]);
  });

  it('records the MEASURED split, not the spec\'s stale one', () => {
    const counts = Object.values(CENSUS).reduce<Record<string, number>>((acc, { verdict }) => {
      acc[verdict] = (acc[verdict] ?? 0) + 1;
      return acc;
    }, {});
    // 14 files: 1 seam, 6 must migrate, 5 untouched, 2 name-only.
    // The spec says "eleven of the twelve untouched". It is not eleven, and it
    // is not twelve. If these numbers move, the migration's scope moved with
    // them and someone should notice deliberately rather than in passing.
    expect(counts).toEqual({ SEAM: 1, MUST_MIGRATE: 6, UNTOUCHED: 5, NAME_ONLY: 2 });
  });

  it('every entry carries a reason someone can act on', () => {
    const thin = Object.entries(CENSUS)
      .filter(([, { why }]) => why.trim().length < 40)
      .map(([file]) => file);
    expect(thin, 'a verdict without a real reason is an unexamined assumption with a label').toEqual([]);
  });

  it('the name-only entries really do not read a value', () => {
    // The weakest claim in the census, so it is the one checked against source.
    // A NAME_ONLY file that starts reading the pointer for real is exactly the
    // quiet drift this gate is for.
    for (const [file, { verdict }] of Object.entries(CENSUS)) {
      if (verdict !== 'NAME_ONLY') continue;
      const src = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      // A value read looks like `.currentOrderId` or `currentOrderId:` in a
      // where/select/data object. An index NAME is a quoted string.
      const readsValue = /\.\s*current(Order|Ride)Id\b|current(Order|Ride)Id\s*:/.test(stripped);
      expect(readsValue, `${file} is registered NAME_ONLY but now reads the pointer — reclassify it`).toBe(false);
    }
  });
});
