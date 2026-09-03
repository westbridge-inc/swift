import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// THE CI GATE [MKT-2 Movement 1].
//
// `Item.stockQuantity` is a cache; `stock_movements` is the truth. That only
// holds while ONE function writes both. Before this, five separate places wrote
// the counter and three of them logged nothing — including the most ordinary
// write of all, selling something. So a vendor asking "I had twelve, you show
// nine" could not be answered, because the three that sold were never recorded.
//
// A rule enforced only by convention is a rule that gets forked by the next
// person in a hurry. This is a SOURCE SCAN: it fails the build if any file
// outside the inventory module writes stockQuantity directly. Same mechanism as
// operate-gate-unification.test.ts, which stops `subscriptionOperability` being
// copied inline — and that one already caught a real divergence.
//
// If this test fails, the fix is not to add an exemption. It is to route the
// new write through `applyStockMovement`.
// ---------------------------------------------------------------------------

const API_SRC = join(__dirname, '..');

/** The only file allowed to move the counter. */
const SINGLE_WRITER = join('modules', 'inventory', 'stock.ts');

/**
 * What we are actually protecting: MUTATING an existing balance.
 *
 * The first draft matched any `data: { ... stockQuantity ... }` and flagged the
 * API RESPONSE payload `data: { adjustment, stockQuantity: fresh?... }` — a
 * false positive, and a useful reminder that a gate which cries wolf gets an
 * exemption added and then stops being a gate.
 *
 * So this targets the mutation forms precisely. Setting an initial quantity at
 * item CREATION is deliberately not caught: nothing moved, a baseline was
 * declared — and `recordOpeningBalance` writes the ledger row that explains it.
 */
/**
 * Find every Prisma write that ASSIGNS `stockQuantity`, precisely.
 *
 * Two regexes were tried and both were wrong, in opposite directions:
 *
 *  · `data: { [^}]* stockQuantity: }` — `[^}]*` cannot cross a `}`, so a spread
 *    like `...(x !== undefined && { stockQuantity: y })` slipped through. The
 *    gate EXEMPTED the item editor: the single most dangerous writer there is.
 *  · a fixed-width window after `.item.update(` — matched the NEXT statement's
 *    `where: { stockQuantity: { gt: 0 } }` and cried wolf on auto-hide updates.
 *
 * A gate with a hole shaped like the bug is worse than none, because it is
 * trusted. A gate that cries wolf gets disabled. Regex cannot balance braces, so
 * it is the wrong tool — this walks the braces instead.
 *
 * Only `update`/`updateMany` count. `create` sets a BASELINE, not a movement,
 * and `recordOpeningBalance` writes the ledger row that explains it.
 */
function findCounterWrites(src: string): number[] {
  const hits: number[] = [];
  const call = /\.item\.update(?:Many)?\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = call.exec(src)) !== null) {
    // Walk from the opening paren to its match, so we get exactly this call.
    let i = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (c === '(' || c === '{' || c === '[') depth += 1;
      else if (c === ')' || c === '}' || c === ']') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) continue;
    const args = src.slice(m.index, end);

    // Inside this call, isolate the `data:` object and look only in there —
    // `where:` may legitimately FILTER on stockQuantity.
    const d = args.search(/\bdata\s*:\s*\{/);
    if (d === -1) continue;
    let j = args.indexOf('{', d);
    let dep = 0;
    let dEnd = -1;
    for (; j < args.length; j += 1) {
      const c = args[j];
      if (c === '{') dep += 1;
      else if (c === '}') { dep -= 1; if (dep === 0) { dEnd = j; break; } }
    }
    if (dEnd === -1) continue;

    if (/stockQuantity\s*:/.test(args.slice(d, dEnd))) {
      hits.push(src.slice(0, m.index).split('\n').length);
    }
  }
  return hits;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'generated') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('the stock counter has exactly one writer', () => {
  it('no file outside modules/inventory/stock.ts writes Item.stockQuantity', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(API_SRC)) {
      const rel = file.slice(API_SRC.length + 1);
      if (rel === SINGLE_WRITER) continue;

      const src = readFileSync(file, 'utf8');
      if (!src.includes('stockQuantity')) continue;

      const lines = findCounterWrites(src);
      if (lines.length > 0) offenders.push(`${rel} (lines ${lines.join(', ')})`);
    }

    expect(
      offenders,
      `These files write Item.stockQuantity directly. Route them through applyStockMovement() in `
        + `modules/inventory/stock.ts so the ledger and the counter move together — do not add an `
        + `exemption here:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the single writer is where we think it is, and still writes the ledger', () => {
    // Guards against the gate passing because the writer was moved or gutted.
    const src = readFileSync(join(API_SRC, SINGLE_WRITER), 'utf8');
    expect(src).toContain('export async function applyStockMovement');
    expect(src).toContain('stockMovement.create');
    // The conditional decrement is the concurrency guarantee — losing it would
    // let two customers win the last item without failing any other test here.
    expect(src).toMatch(/stockQuantity:\s*\{\s*gte:/);
  });

  it('the ledger is append-only in the database, not just by convention', () => {
    const migration = readFileSync(
      join(API_SRC, '..', 'prisma', 'migrations', '20260825000000_stock_movement_ledger', 'migration.sql'),
      'utf8',
    );
    // A stock ledger that can be rewritten is not evidence.
    expect(migration).toMatch(/BEFORE UPDATE ON "stock_movements"/);
    expect(migration).toMatch(/BEFORE DELETE ON "stock_movements"/);
    expect(migration).toMatch(/REVOKE TRUNCATE ON "stock_movements"/);
    // And every pre-existing item must have an opening balance, or every one of
    // them would read as drifted by exactly its current quantity.
    expect(migration).toContain('OPENING_BALANCE');
    // Tenancy is not optional.
    expect(migration).toMatch(/ENABLE ROW LEVEL SECURITY/);
  });
});
