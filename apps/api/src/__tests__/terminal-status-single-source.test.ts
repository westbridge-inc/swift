import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { TERMINAL_ORDER_STATUSES } from '../modules/order/order.service';

/**
 * ONE ANSWER TO "IS THIS ORDER OVER?"
 *
 * Home's active-order query hand-wrote the terminal set with FOUR entries when
 * the real one has five. `FAILED` was missing. So a failed handover — a no-show
 * or a refusal at the door — came back as the customer's ACTIVE order, with a
 * "Track order" button, PERMANENTLY: `FAILED` is terminal, so nothing ever
 * moved it on.
 *
 * And the second consequence is worse than the first. `findFirst` orders by
 * `placedAt desc`, so once the failed order is the newest it MASKS a genuinely
 * live order behind it. The customer has a delivery in flight and Home points
 * them at the one that failed.
 *
 * Measured on the running database before the fix:
 *
 *   newest order is   : SW-260716-002A4T  FAILED
 *   Home predicate  -> SW-260716-002A4T  (FAILED)          ← wrong
 *   canonical (5)   -> SW-260716-0032DB  (READY_FOR_PICKUP) ← the live one
 *
 * This is the duplicated-business-predicate class that REPORT-038 counted six
 * families of, and the same shape as the visibility predicate that had six
 * copies before PR #835. The cure is the same: export the one definition and
 * make a second copy fail the build.
 */

const SRC = join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** Source with comments stripped — the standing hazard-matching rule. The
 *  comments in these files necessarily quote the very list being banned. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const files = walk(SRC);
const rel = (f: string) => f.slice(join(process.cwd()).length + 1);

describe('the terminal set has one definition', () => {
  it('it contains all five terminal statuses', () => {
    // FAILED is the one that went missing, and it is the one that matters:
    // DELIVERED/COMPLETED are the happy ends nobody forgets.
    expect([...TERMINAL_ORDER_STATUSES].sort()).toEqual(
      ['CANCELLED', 'COMPLETED', 'DELIVERED', 'FAILED', 'REFUNDED'].sort(),
    );
  });

  it('no file hand-writes a FOUR-entry terminal list', () => {
    // The exact drift that shipped: the happy ends plus cancellations, minus
    // FAILED. It reads complete, which is why it survived review.
    const offenders = files
      .filter((f) => !f.endsWith('order.service.ts'))
      .filter((f) =>
        /\[\s*'DELIVERED',\s*'COMPLETED',\s*'CANCELLED',\s*'REFUNDED'\s*\]/.test(code(f)),
      )
      .map(rel);

    expect(
      offenders,
      'This list is missing FAILED. Import TERMINAL_ORDER_STATUSES from order.service instead — ' +
        'a failed handover otherwise reads as a live order forever, and hides the real one.',
    ).toEqual([]);
  });

  it('the scan can actually see the pattern (guards the guard)', () => {
    // If the regex could not match the shape it bans, the assertion above would
    // pass against anything. This is the literal string that shipped.
    const shipped = `status: { notIn: ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED'] },`;
    expect(/\[\s*'DELIVERED',\s*'COMPLETED',\s*'CANCELLED',\s*'REFUNDED'\s*\]/.test(shipped)).toBe(true);
  });

  it('Home takes its active-order predicate from the shared constant', () => {
    // Named explicitly so the fix cannot be quietly reverted into a literal.
    const customer = code(join(SRC, 'modules/user/customer.routes.ts'));
    expect(customer).toMatch(/TERMINAL_ORDER_STATUSES/);
    expect(customer).toMatch(/notIn:\s*TERMINAL_ORDER_STATUSES/);
  });
});

describe('the remaining hand-written copies are recorded, not hidden', () => {
  /**
   * Sites that still enumerate terminal-ish statuses inline. Each is a
   * DIFFERENT question from "is this order over", which is why they are not
   * mechanically swept into the constant — but they are listed so the next
   * reader knows they exist and can judge them, rather than discovering the
   * seventh copy the hard way.
   */
  const KNOWN_INLINE: Array<{ file: string; why: string }> = [
    {
      file: 'modules/mover-authority-cutover-preparation.ts',
      why: 'raw SQL — the Prisma constant cannot be interpolated into a tagged template safely; it lists all FIVE and is correct',
    },
  ];

  it('courier no longer hand-writes a THREE-entry list', () => {
    // It did, at four sites, omitting REFUNDED and FAILED. Three of them were
    // backstopped by ORDER_TRANSITIONS; the fourth was a direct updateMany that
    // nothing guarded, so a rider could stamp a delivery-proof URL onto a job
    // that had already FAILED at the door. Now imported like everywhere else.
    const courier = code(join(SRC, 'modules/courier/courier.routes.ts'));
    expect(courier).not.toMatch(/\[\s*'DELIVERED',\s*'COMPLETED',\s*'CANCELLED'\s*\]/);
    expect(courier).toMatch(/TERMINAL_ORDER_STATUSES/);
  });

  it('every recorded site still exists', () => {
    for (const { file } of KNOWN_INLINE) {
      expect(files.map(rel)).toContain(`src/${file}`);
    }
  });

  it('every recorded site carries a written reason', () => {
    for (const { file, why } of KNOWN_INLINE) {
      expect(why.length, `${file} needs a reason`).toBeGreaterThan(40);
    }
  });
});
