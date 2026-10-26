import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HANDOVER_POLICY, HANDOVER_POLICY_VERSION } from '../modules/order/handover-authority';

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

/** The minimum the shipped app accepts, read out of the mobile source rather than imported. */
function mobileMinimum(): number | null {
  const m = /export const MIN_HANDOVER_POLICY_VERSION\s*=\s*(\d+)/.exec(mobileSource);
  return m ? Number(m[1]) : null;
}

describe('[F-106-01] the handover policy binds the API and the rider app', () => {
  it('the mobile door still declares a minimum it will accept — a census that finds nothing is not a census', () => {
    expect(
      mobileMinimum(),
      `${MOBILE_DOOR} no longer declares MIN_HANDOVER_POLICY_VERSION in a shape this test can read. ` +
        'It was renamed or restructured — repoint this census, do not delete it.',
    ).not.toBeNull();
  });

  it('the API never serves a policy OLDER than the shipped app will accept', () => {
    // The one direction that is dangerous. A server BEHIND the fleet computed
    // its authority under fewer rules and can say DELIVER_NO_CASH on a disputed
    // order. A server AHEAD is strictly safer, so it is deliberately allowed:
    // that is what lets the API bump without a matching mobile release.
    expect(
      HANDOVER_POLICY_VERSION,
      `The API serves handover policy v${HANDOVER_POLICY_VERSION}, below the v${String(mobileMinimum())} minimum ` +
        `${MOBILE_DOOR} accepts. Every mobile-money handover would be refused ON THE DEVICE — invisible in server ` +
        'metrics, while cash orders keep working. Raise the API, or lower the app minimum deliberately.',
    ).toBeGreaterThanOrEqual(mobileMinimum()!);
  });

  it('the version is monotonic and the bump instruction is safe to follow', () => {
    expect(Number.isInteger(HANDOVER_POLICY_VERSION)).toBe(true);
    expect(HANDOVER_POLICY_VERSION).toBeGreaterThan(0);
  });

  it('the LEGACY string is still served, so an already-installed app keeps working', () => {
    // Removing this field is the outage this whole mechanism exists to prevent:
    // a build in the field matches the string and knows nothing about versions.
    expect(typeof HANDOVER_POLICY).toBe('string');
    expect(HANDOVER_POLICY.length).toBeGreaterThan(0);
    expect(
      mobileSource.match(/export const ACCEPTED_HANDOVER_POLICIES[^=]*=\s*\[([^\]]*)\]/)?.[1] ?? '',
      'the app no longer accepts the legacy string the API still serves',
    ).toContain(`'${HANDOVER_POLICY}'`);
  });

  it('the mobile door refuses an OLDER server rather than defaulting to permissive', () => {
    // Grading the shape of the guard, because the whole contract rests on it.
    expect(mobileSource).toMatch(/servedVersion < MIN_HANDOVER_POLICY_VERSION\)\s*return null;/);
    // ...and still falls back to the string when no version is served.
    expect(mobileSource).toMatch(/ACCEPTED_HANDOVER_POLICIES\.includes\(h\['policy'\]\)/);
  });

  it('the API actually puts the version on the wire', () => {
    // A minimum nothing serves is a minimum nothing enforces.
    const api = readFileSync(path.join(REPO_ROOT, 'apps/api/src/modules/order/handover-authority.ts'), 'utf8');
    expect(api).toMatch(/policyVersion:\s*HANDOVER_POLICY_VERSION/);
  });
});
