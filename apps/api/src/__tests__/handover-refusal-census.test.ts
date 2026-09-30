import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HANDOVER_BLOCK_REASONS, HANDOVER_REFUSALS } from '../modules/order/handover-authority';

// ---------------------------------------------------------------------------
// [F-106-xx] EVERY REASON THE DOOR CAN REFUSE MUST HAVE AN ANSWER.
//
// The completing route enumerated two block reasons and let anything else fall
// through to `PAYMENT_NOT_CAPTURED`. `PAYMENT_STATE_INCONSISTENT` — a reason the
// door genuinely produces — therefore answered the rider:
//
//     "Payment is captured — do not hand over. Refresh, or ask the store to
//      confirm the payment."
//
// A sentence that contradicts itself, and re-offers the "ask the store" advice
// F-106-03 removed for exactly this case. Meanwhile `GET /orders/active` DID
// send the third reason, so the screen and the completing route disagreed about
// the same row — the precise class of defect this PR exists to close.
//
// Deleting the third mapping used to be free: no test went red. Now it is not.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const RIDER_ROUTES = readFileSync(path.join(REPO_ROOT, 'apps/api/src/modules/rider/rider.routes.ts'), 'utf8');

describe('[F-106-xx] the handover refusal table is complete and is what the route uses', () => {
  it('every block reason the door can return has rider-facing copy', () => {
    const missing = HANDOVER_BLOCK_REASONS.filter((r) => !HANDOVER_REFUSALS[r]);
    expect(
      missing,
      'a block reason with no entry falls through to a generic payment message that may contradict itself',
    ).toEqual([]);
  });

  it('the census enumerates every reason the module actually defines', () => {
    // Guard the guard: if a new *_BLOCK constant is added and not enrolled in
    // HANDOVER_BLOCK_REASONS, the completeness check above goes vacuous.
    const source = readFileSync(path.join(REPO_ROOT, 'apps/api/src/modules/order/handover-authority.ts'), 'utf8');
    const declared = [...source.matchAll(/export const ([A-Z_]+_BLOCK) = '([A-Z_]+)'/g)].map((m) => m[2]!);
    expect(declared.length).toBeGreaterThan(0);
    expect(
      declared.filter((d) => !(HANDOVER_BLOCK_REASONS as readonly string[]).includes(d)),
      'a new block reason was defined but not enrolled in HANDOVER_BLOCK_REASONS',
    ).toEqual([]);
  });

  it('no refusal message tells the rider to ask the store about a dispute or a corrupt row', () => {
    // F-106-03: that advice cannot work while someone is holding food at a door.
    for (const reason of HANDOVER_BLOCK_REASONS) {
      expect(HANDOVER_REFUSALS[reason]!.message.toLowerCase(), reason).not.toContain('ask the store');
    }
  });

  it('the completing route answers from the table, not from a hand-rolled enumeration', () => {
    expect(RIDER_ROUTES).toMatch(/HANDOVER_REFUSALS\[authority\.blockReason \?\? ''\]/);
    // The two-reason enumeration this replaced must not creep back.
    expect(
      /if \(authority\.blockReason === /.test(RIDER_ROUTES),
      'the route is enumerating block reasons by hand again — that is how the third one was lost',
    ).toBe(false);
  });

  it('each message names a distinct situation — a shared string would hide which one fired', () => {
    const messages = HANDOVER_BLOCK_REASONS.map((r) => HANDOVER_REFUSALS[r]!.message);
    expect(new Set(messages).size).toBe(messages.length);
  });
});
