import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * [Part 11.6 sweep 13] The two env examples must not quietly disagree about how
 * the product BEHAVES.
 *
 * This repo has already paid for this once, and the record is in
 * `apps/api/.env.example` in its own words: `LIFECYCLE_V2` shipped `0` locally
 * while `deploy/.env.deploy.example` shipped `1` under "match the current
 * launch posture". So a fresh checkout ran DIFFERENT ORDER SEMANTICS from
 * production — the five-minute hold never opened, and the hold screen, the one
 * the whole tracking design is built around, was unreachable while developing
 * against it. Nobody noticed because neither file is wrong on its own; they are
 * only wrong together.
 *
 * Codex's flag census (REPORT-038 S6) found the same shape again. This test
 * makes that shape a build failure instead of an archaeology exercise.
 *
 * SCOPE, deliberately narrow: only flags that change what a USER experiences.
 * Credentials, hostnames, thresholds, timeouts and per-environment
 * infrastructure are expected to differ and are not listed. A flag absent from
 * a file is not automatically a disagreement — the code's own default decides —
 * so the comparison is on EFFECTIVE value, and each flag records how its code
 * reads an unset variable.
 */

const api = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
const deploy = readFileSync(join(process.cwd(), '../../deploy/.env.deploy.example'), 'utf8');

/** Read `NAME=value` (ignoring trailing comments) from an env-example file. */
function declared(file: string, name: string): string | undefined {
  for (const line of file.split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=([^#]*?)(?:\s+#.*)?$/);
    if (m && m[1] === name) return (m[2] ?? '').trim();
  }
  return undefined;
}

/**
 * Product-behaviour flags, with what the CODE does when the variable is unset.
 * `whenUnset` is the effective value, so a flag documented in one file and
 * omitted from the other is only a finding when the two EFFECTIVELY differ.
 */
const BEHAVIOUR_FLAGS: Array<{ name: string; whenUnset: string; what: string }> = [
  { name: 'LIFECYCLE_V2', whenUnset: '1', what: 'orders are born HELD — the five-minute free-cancel window' },
  { name: 'ORDER_HOLD_MINUTES', whenUnset: '5', what: 'how long that window lasts' },
  { name: 'DELIVERY_BLOCK_ON_NONE', whenUnset: '1', what: 'whether a no-rider delivery checkout is blocked' },
  { name: 'TAXI_ALLOW_REQUEST_ON_NONE', whenUnset: '1', what: 'whether a passenger may request with no drivers near' },
  { name: 'DISPATCH_EXHAUSTION', whenUnset: '0', what: 'the terminal exhausted state and pickup conversion' },
  { name: 'PREVIEW_MODE', whenUnset: '0', what: 'whether never-live vendors may draft listings' },
  { name: 'ALERTS_LOUD', whenUnset: '0', what: 'whether ops paging is push+in-app or log-only' },
];

/**
 * Known differences, each with the reason it is allowed to differ. Audited from
 * BOTH sides below: an exemption whose flag no longer differs also fails, so
 * the list cannot outlive its reasons.
 */
const EXEMPT: Array<{ name: string; reason: string }> = [
  {
    name: 'DISPATCH_AVAILABILITY',
    // api/.env.example says 0 and calls it "current default";
    // deploy/.env.deploy.example says 1 under "match the current launch
    // posture". Both files call themselves current, so one is stale — and
    // which one is a PRODUCT decision, not an engineering guess.
    //
    // The case for the difference being deliberate: with this ON and
    // DELIVERY_BLOCK_ON_NONE=1, a delivery checkout is refused whenever no
    // mover is online near the pickup — which locally is nearly always, so
    // every developer's checkout would fail. The case against: this is exactly
    // the LIFECYCLE_V2 shape, and it means the honest-supply UX (taxi's "No
    // drivers available · Notify me", checkout's DELIVERY_NO_RIDERS) cannot be
    // seen while developing the screens that show it.
    //
    // Registered as a founder decision rather than flipped in a PR (policy
    // flags are never flipped in a PR). Delete this entry when it is answered.
    reason: 'FOUNDER DECISION PENDING: dev-convenience vs seeing the honest-supply UX locally',
  },
  {
    name: 'CONSENT_REQUIRED',
    // api says 0 with "leave 0 until all shipped clients send the field";
    // deploy omits it, and the code fails CLOSED (enforcement ON unless the
    // value is exactly '0'), which is the correct secure default.
    //
    // The compat window it describes is provably OVER: both shipped clients
    // send acceptTerms — apps/mobile RegisterScreen.tsx:36 and apps/web
    // signup/page.tsx:70. So the deployed behaviour is right and the local 0
    // is stale, which means a developer never exercises the consent-recording
    // path. Aligning it changes a local default, so it is registered rather
    // than flipped here.
    reason: 'FOUNDER DECISION PENDING: the stated compat window is over (both clients send acceptTerms)',
  },
];

describe('the two env examples agree on how the product behaves', () => {
  const exemptNames = new Set(EXEMPT.map((e) => e.name));

  for (const flag of BEHAVIOUR_FLAGS) {
    it(`${flag.name} — ${flag.what}`, () => {
      const a = declared(api, flag.name) ?? flag.whenUnset;
      const d = declared(deploy, flag.name) ?? flag.whenUnset;
      expect(
        a,
        `apps/api/.env.example and deploy/.env.deploy.example disagree on ${flag.name} ` +
          `(${a} vs ${d}). That means local development runs different product behaviour from ` +
          `what deploys — the LIFECYCLE_V2 defect. Fix the stale one, or add a written exemption.`,
      ).toBe(d);
    });
  }

  it('every exemption still describes a real difference', () => {
    // Audited from the other side, like the stock-photo gate's exemptions: an
    // exemption whose flag now agrees is stale permission, and a list nobody
    // prunes stops being read.
    for (const { name } of EXEMPT) {
      const a = declared(api, name);
      const d = declared(deploy, name);
      expect(a === d, `${name} is exempt but the two files now agree (${a}) — remove the exemption`).toBe(false);
    }
  });

  it('every exemption carries a written reason', () => {
    for (const { name, reason } of EXEMPT) {
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(30);
    }
  });

  it('no behaviour flag is silently both listed and exempt', () => {
    for (const flag of BEHAVIOUR_FLAGS) {
      expect(exemptNames.has(flag.name), `${flag.name} cannot be both compared and exempt`).toBe(false);
    }
  });
});
