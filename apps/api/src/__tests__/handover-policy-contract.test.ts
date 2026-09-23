import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HANDOVER_POLICY } from '../modules/order/handover-authority';

// ---------------------------------------------------------------------------
// [DOC-INV-48 · F-106-01] THE HANDOVER POLICY IS A CROSS-APP CONTRACT.
//
// The rider's app refuses to act on a handover authority whose `policy` it does
// not recognise — correctly, because an authority from a server that predates
// the dispute rule will happily say DELIVER_NO_CASH on a disputed order.
//
// But the value lived as TWO INDEPENDENT STRING LITERALS, one per app, with
// nothing binding them, while the API constant's own doc comment said "bump
// this whenever the door's rules change". Following that instruction on the API
// alone turns every mobile-money door in the fleet red. Both suites imported
// their own constant, so every assertion was satisfied by ANY value; CI stayed
// green and `tsc --noEmit` stayed clean. And because the refusal is minted on
// the DEVICE, `swift_handover_block_total` never moves — cash keeps working, the
// dashboards look normal, and nothing on the server shows that every rider on a
// mobile-money order is standing at a customer's door unable to continue.
//
// So the binding is a test, and it reads the mobile file as TEXT — the same way
// mover-pointer-census and the notification-kind census grade their contracts.
// Bumping the API policy without shipping a mobile release that accepts it is
// now a RED BUILD rather than an outage.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const MOBILE_DOOR = 'apps/mobile/src/lib/handoverAuthority.ts';

const mobileSource = readFileSync(path.join(REPO_ROOT, MOBILE_DOOR), 'utf8');

/** The accepted list, read out of the mobile source rather than imported. */
function acceptedPoliciesInMobile(): string[] {
  const decl = /export const ACCEPTED_HANDOVER_POLICIES\s*:\s*readonly string\[\]\s*=\s*\[([^\]]*)\]/.exec(mobileSource);
  if (!decl) return [];
  return [...decl[1]!.matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2]!);
}

describe('[F-106-01] the handover policy binds the API and the rider app', () => {
  it('the mobile door still declares an accepted-policy list — a census that finds nothing is not a census', () => {
    expect(
      acceptedPoliciesInMobile().length,
      `${MOBILE_DOOR} no longer declares ACCEPTED_HANDOVER_POLICIES in a shape this test can read. ` +
        'It was renamed or restructured — repoint this census, do not delete it.',
    ).toBeGreaterThan(0);
  });

  it('the policy the API serves is one the shipped rider app will accept', () => {
    const accepted = acceptedPoliciesInMobile();
    expect(
      accepted,
      `The API serves handover authorities under policy "${HANDOVER_POLICY}", which ${MOBILE_DOOR} does not accept.\n` +
        'Every mobile-money handover in the fleet would be refused ON THE DEVICE — invisible in server metrics, ' +
        'while cash orders keep working and the dashboards look normal.\n' +
        `Fix: add '${HANDOVER_POLICY}' to the FRONT of ACCEPTED_HANDOVER_POLICIES and keep the previous value for one release, ` +
        'so an app and an API from adjacent releases interoperate during rollout AND rollback.',
    ).toContain(HANDOVER_POLICY);
  });

  it('the app keeps a grace entry, or is explicitly on its first policy', () => {
    const accepted = acceptedPoliciesInMobile();
    // One entry is correct only while no policy has ever been superseded. Once a
    // second exists, dropping back to one removes the rollback window — so this
    // records the intent rather than silently allowing either.
    expect(accepted[0], 'the preferred policy must be the newest, listed first').toBe(HANDOVER_POLICY);
    expect(accepted.length, 'ACCEPTED_HANDOVER_POLICIES should hold the current policy and at most one grace entry').toBeLessThanOrEqual(2);
  });

  it('the mobile door refuses an unknown policy rather than defaulting to permissive', () => {
    // Grading the shape of the guard, because its absence is what the whole
    // contract rests on. A parser that stopped checking `policy` would satisfy
    // every other test in both apps.
    expect(mobileSource).toMatch(/ACCEPTED_HANDOVER_POLICIES\.includes\(h\['policy'\]\)/);
    expect(mobileSource).toMatch(/return null;/);
  });
});
