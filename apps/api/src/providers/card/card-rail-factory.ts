import type Redis from 'ioredis';
import { isProduction } from '../../utils/runtime-mode';
import type { CardRailProvider } from './card-provider';
import { SIMULATOR_PROVIDER, SimulatorCardRailProvider } from './simulator-provider';
import { POWERTRANZ_PROVIDER, PowerTranzCardRailProvider, powerTranzConfigFromEnv } from './powertranz-provider';

/** A provider account label: Swift's own short name for a merchant account.
 *  Never the merchant number, never a credential (the same shape the
 *  payment_instruments / card_sessions CHECK constraints hold). */
export const CARD_RAIL_ACCOUNT_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * [PT-1] The card rail v2 provider for this process. Chosen EXPLICITLY by
 * CARD_RAIL_PROVIDER — there is no default — and resolved lazily: only v2 work
 * (a session, an instrument charge, a v2 reconciliation) ever asks for it, so
 * a process with the flag off never needs it configured.
 *
 *   CARD_RAIL_PROVIDER     simulator (Swift's test page; never production) |
 *                          powertranz (real cards, PT-4: powertranz-provider.ts)
 *   CARD_RAIL_ENVIRONMENT  sandbox | live   (the simulator is sandbox only;
 *                          production takes live only)
 *   CARD_RAIL_ACCOUNT      the merchant-account label tokens are bound to
 *   API_PUBLIC_URL         the public origin the hosted pages are served from
 *   POWERTRANZ_*           the real provider's settings and secrets
 *                          (powerTranzConfigFromEnv names each one)
 *
 * Both keep their per-page state in Redis so the API and the worker share it;
 * the caller passes its own connection (app.redis, or the worker's).
 */
export function getCardRailProvider(
  deps: { redis: Redis },
  env: Record<string, string | undefined> = process.env,
): CardRailProvider {
  const provider = env['CARD_RAIL_PROVIDER'];
  if (!provider) {
    throw new Error('CARD_RAIL_PROVIDER is not set: the card rail v2 provider is chosen explicitly, never by default');
  }
  if (provider === SIMULATOR_PROVIDER) {
    // [C10] Mirrors getPaymentProvider's sandbox refusal: the simulator is a
    // test page with no real money, and production never selects it.
    if (isProduction(env)) {
      throw new Error('CARD_RAIL_PROVIDER=simulator is forbidden in production: the simulator is a test page with no real money');
    }
    // Empty reads as unset, as in the env templates [AX297 F6].
    const environment = env['CARD_RAIL_ENVIRONMENT'] || 'sandbox';
    if (environment !== 'sandbox') {
      throw new Error('The card simulator runs only in the sandbox environment (CARD_RAIL_ENVIRONMENT=sandbox)');
    }
    const account = env['CARD_RAIL_ACCOUNT'] || 'simulator';
    if (!CARD_RAIL_ACCOUNT_LABEL.test(account)) {
      throw new Error('CARD_RAIL_ACCOUNT must be a short label (letters, digits, dot, dash, underscore; at most 64)');
    }
    return new SimulatorCardRailProvider(deps.redis, { account, publicBaseUrl: env['API_PUBLIC_URL'] ?? '' }, env);
  }
  if (provider === POWERTRANZ_PROVIDER) {
    return new PowerTranzCardRailProvider(deps.redis, powerTranzConfigFromEnv(env));
  }
  throw new Error(`Unknown CARD_RAIL_PROVIDER: ${provider}. The card rail v2 providers are simulator and powertranz.`);
}
