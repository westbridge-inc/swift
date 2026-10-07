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

/** [PROD-PATH] A partner can pay the weekly fee by card on this server: card
 * rail v2 (hosted enrolment and hosted Pay now, the only card paths a partner
 * can open) is on, and neither the kill switch nor a disabled provider stops
 * it. Exactly the gate CardRailService.startSession applies before it opens
 * a hosted card page. Server switches only: nothing about a partner (their
 * card on file, their billing method) enters it. */
export function weeklyFeeCardLive(env: Record<string, string | undefined> = process.env): boolean {
  return cardRailV2Enabled(env) && !cardRailKilled(env);
}

/** [PT-1 · AX297 F5] With CARD_RAIL_V2 off, drain what v2 left in flight:
 * CARD_RAIL_V2_DRAIN exactly '1' (default 0) lets the billing worker keep
 * confirming open card sessions and retrieving v2 charges already sent, and
 * nothing else — no new session and no new charge (those still need
 * CARD_RAIL_V2=1). Switching v2 off and draining it are separate decisions. */
export function cardRailV2DrainEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['CARD_RAIL_V2_DRAIN'] === '1';
}

/** No implicit OFF state: disabling the provider also requires the billing
 * kill switch, so boot and provider construction enforce the same contract. */
export function assertDisabledCardRailConfig(env: Record<string, string | undefined>): void {
  if (env['PAYMENT_PROVIDER'] === 'disabled' && env['CARD_RAIL_KILL'] !== '1') {
    throw new Error('FATAL: PAYMENT_PROVIDER=disabled requires CARD_RAIL_KILL=1. Refusing to start.');
  }
}
