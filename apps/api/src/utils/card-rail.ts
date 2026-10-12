/** Explicit provider disablement and the operational kill switch both stop new
 * card instructions. A live provider may still reconcile while killed. */
export function cardRailKilled(env: Record<string, string | undefined> = process.env): boolean {
  return env['PAYMENT_PROVIDER'] === 'disabled' || env['CARD_RAIL_KILL'] === '1';
}

/** [PT-1] Card rail v2 — hosted enrolment, bound instruments, hosted Pay now —
 * is dormant unless CARD_RAIL_V2 is exactly '1'. OFF (the default) leaves the
 * legacy card path byte-identical, and the billing worker does no v2 work at
 * all: it builds no v2 provider and sweeps no session [AX297 F5]. */
export function cardRailV2Enabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['CARD_RAIL_V2'] === '1';
}

/** [PT-1 · AX297 F5] With CARD_RAIL_V2 off, drain what v2 left in flight:
 * CARD_RAIL_V2_DRAIN exactly '1' (default 0) lets the billing worker keep
 * confirming open card sessions and retrieving v2 charges already sent, and
 * nothing else — no new session and no new charge (those still need
 * CARD_RAIL_V2=1). Switching v2 off and draining it are separate decisions. */
export function cardRailV2DrainEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['CARD_RAIL_V2_DRAIN'] === '1';
}

/** [PT-2] Saving a card for the weekly fee (an ENROLL session) is OFF unless
 * CARD_RAIL_ENROLL is exactly '1' — independent of the provider's ability:
 * the on-screen consent wording waits for the owner's sign-off. Off: the
 * CARD entry offers Pay now only and an ENROLL request is refused. */
export function cardEnrollEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['CARD_RAIL_ENROLL'] === '1';
}

/** [PT-2] STAGING ONLY: CARD_RAIL_SIMULATOR_LIVE exactly '1' lets the
 * simulator make the CARD pay action live — labelled as a test — so the whole
 * card choice can be exercised on a test server. Production refuses to boot
 * with it set (boot-config.ts), and the simulator itself never builds there. */
export function cardSimulatorLiveEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['CARD_RAIL_SIMULATOR_LIVE'] === '1';
}

/** [PT-2 · review S2] The simulator moves no money, yet a simulator "Approve"
 * books a paid week. So it opens pages ONLY for the TEST subscriptions listed
 * by id in CARD_RAIL_SIMULATOR_SUBSCRIPTIONS (comma-separated): a real
 * partner on a test server never sees or settles a simulator payment. Empty
 * or unset: no subscription may use it. */
export function cardSimulatorSubscriptions(env: Record<string, string | undefined> = process.env): ReadonlySet<string> {
  return new Set((env['CARD_RAIL_SIMULATOR_SUBSCRIPTIONS'] ?? '').split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s)));
}

/** [PT-2 · review S2] The host the public talks to (and, until the DNS
 * cutover, Apple's reviewers): no test switch or test page may ever run there. */
export const PUBLIC_API_HOST = 'api.swiftgy.com';

/** No implicit OFF state: disabling the provider also requires the billing
 * kill switch, so boot and provider construction enforce the same contract. */
export function assertDisabledCardRailConfig(env: Record<string, string | undefined>): void {
  if (env['PAYMENT_PROVIDER'] === 'disabled' && env['CARD_RAIL_KILL'] !== '1') {
    throw new Error('FATAL: PAYMENT_PROVIDER=disabled requires CARD_RAIL_KILL=1. Refusing to start.');
  }
}
