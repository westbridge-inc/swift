/** Explicit provider disablement and the operational kill switch both stop new
 * card instructions. A live provider may still reconcile while killed. */
export function cardRailKilled(env: Record<string, string | undefined> = process.env): boolean {
  return env['PAYMENT_PROVIDER'] === 'disabled' || env['CARD_RAIL_KILL'] === '1';
}

/** No implicit OFF state: disabling the provider also requires the billing
 * kill switch, so boot and provider construction enforce the same contract. */
export function assertDisabledCardRailConfig(env: Record<string, string | undefined>): void {
  if (env['PAYMENT_PROVIDER'] === 'disabled' && env['CARD_RAIL_KILL'] !== '1') {
    throw new Error('FATAL: PAYMENT_PROVIDER=disabled requires CARD_RAIL_KILL=1. Refusing to start.');
  }
}
