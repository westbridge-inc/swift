import { describe, expect, it } from 'vitest';
import { ALGO_DEFAULTS } from '../modules/algo/algo-config';
import { desiredPlatformConfig } from '../modules/ops/platform-config';
import { PARTNER_BLOCKERS } from '../modules/user/partner-wind-down';

// ---------------------------------------------------------------------------
// [DELETION-INTEGRITY · coordinator ruling 2026-10-05, Q1] A rescue incentive
// is Swift's own money owed to a mover, and nothing pays it out yet. Account
// deletion therefore does not wait for it (that would be a dead end), and the
// incentive must stay OFF until BOTH a payout path and a deletion block for
// unpaid incentives ship. Nothing shipped may switch it on.
// ---------------------------------------------------------------------------
describe('rescue incentives stay off until they can be paid and protected at deletion', () => {
  it('ships at 0, and no installer plan sets it', () => {
    expect(ALGO_DEFAULTS['rescue.incentiveGyd']).toBe(0);
    expect(desiredPlatformConfig().algoConfig.map((row) => row.key)).not.toContain('rescue.incentiveGyd');
  });

  it('deletion has no rescue-incentive blocker yet: adding one is the same change that may switch incentives on', () => {
    expect(PARTNER_BLOCKERS).not.toContain('RESCUE_INCENTIVE_OWED');
  });
});
