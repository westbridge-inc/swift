import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MMG_UPDATE_APP_CODE, STORE_MMG_PAY_LINK_OFF_CODE, storeMmgPayLinkEnabled } from '../utils/store-mmg';

// ---------------------------------------------------------------------------
// [PAYMENT-SIMPLIFY #1848 · STAGING-RUN 18 Oct] The live journeys (scripts/livetest) grade the server's MMG
// refusals by code, but CI never runs them — so #1848 changed the codes on purpose and the staging journeys
// still expected the old ones. This keeps the harness and the server in step: every journey step that sets a
// store pay link or checks out by MMG must expect exactly the refusal the server now gives, by the server's
// own constants. (Switch STORE_MMG_PAY_LINK unset = OFF everywhere the journeys run.)
// ---------------------------------------------------------------------------

const JOURNEYS = ['customer.ts', 'money.ts', 'vendor.ts'] as const;
const read = (file: string) => readFileSync(join(__dirname, '../../../../scripts/livetest/journeys', file), 'utf8');

/** For each `const <v> = await <call>(…)` matching `pick`, the codes its `rec.deny(…, <v>, [status], [codes]…)` expects. */
function graded(src: string, pick: RegExp): Array<{ call: string; status: string; codes: string[] }> {
  const out: Array<{ call: string; status: string; codes: string[] }> = [];
  for (const m of src.matchAll(/const (\w+) = await ([^;]+);/g)) {
    if (!pick.test(m[2]!)) continue;
    // [REVIEW-G S4-2] The deny that FOLLOWS this declaration — a later step reusing the name is graded on its own.
    const deny = new RegExp(`rec\\.deny\\([^\\n]*?, ${m[1]}, \\[([^\\]]*)\\], \\[([^\\]]*)\\]`).exec(src.slice(m.index! + m[0].length));
    out.push({ call: m[2]!, status: deny?.[1] ?? 'NOT GRADED', codes: (deny?.[2] ?? '').split(',').map((c) => c.trim().replace(/^'|'$/g, '')).filter(Boolean) });
  }
  return out;
}

describe('[#1848] the live journeys expect the MMG refusals the server gives', () => {
  it('the journeys run with the store pay link OFF (its default)', () => {
    expect(storeMmgPayLinkEnabled({})).toBe(false);
  });

  it('setting a store pay link: 409 MMG_PAY_LINK_OFF, in every journey that tries', () => {
    const steps = JOURNEYS.flatMap((f) => graded(read(f), /^PUT\('\/vendor\/profile', \{ mmgPayUrl:/).map((s) => ({ f, ...s })));
    expect(steps.length).toBeGreaterThanOrEqual(3);
    for (const s of steps) expect({ f: s.f, status: s.status, codes: s.codes }).toEqual({ f: s.f, status: '409', codes: [STORE_MMG_PAY_LINK_OFF_CODE] });
  });

  it('an MMG checkout the old pay-link way: 400 MMG_UPDATE_APP; to the number at a store with none: 400 MMG_NOT_AVAILABLE', () => {
    const steps = JOURNEYS.flatMap((f) => graded(read(f), /^placeOrder\(.*payment: 'MOBILE_MONEY'/).map((s) => ({ f, ...s })));
    const oldShape = steps.filter((s) => !s.call.includes("mmgPayTo: 'STORE_NUMBER'"));
    const toNumber = steps.filter((s) => s.call.includes("mmgPayTo: 'STORE_NUMBER'"));
    expect(oldShape.length).toBeGreaterThanOrEqual(2);
    expect(toNumber.length).toBeGreaterThanOrEqual(2);
    for (const s of oldShape) expect({ f: s.f, status: s.status, codes: s.codes }).toEqual({ f: s.f, status: '400', codes: [MMG_UPDATE_APP_CODE] });
    for (const s of toNumber) expect({ f: s.f, status: s.status, codes: s.codes }).toEqual({ f: s.f, status: '400', codes: ['MMG_NOT_AVAILABLE'] });
  });

  // The journeys may only use +5920 fixture phone literals (livetest-guard), which are not mobiles: the server
  // validates the number BEFORE the step-up, so the journeys can prove the validation; the step-up comes after a
  // valid mobile and is proven here in CI (store-mmg-number.test: 'owner only, step-up first, a mobile only').
  it("setting the store's MMG number to a fixture (non-mobile) number: 400 INVALID_MMG_NUMBER, nothing written", () => {
    const steps = JOURNEYS.flatMap((f) => graded(read(f), /^PUT\('\/vendor\/profile', \{ mmgNumber: '\+5920/).map((s) => ({ f, ...s })));
    expect(steps.length).toBeGreaterThanOrEqual(3);
    for (const s of steps) expect({ f: s.f, status: s.status, codes: s.codes }).toEqual({ f: s.f, status: '400', codes: ['INVALID_MMG_NUMBER'] });
  });
});
