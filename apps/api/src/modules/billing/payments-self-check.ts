import Redis from 'ioredis';
import {
  MMG_CHECKOUT_PRODUCT_DESCRIPTION,
  buildCheckoutRequest,
  encryptCheckoutRequest,
  loadMmgCheckoutConfig,
  newMerchantTransactionId,
  oaepSha256MaxPlaintextBytes,
  requestInitiationTime,
  serializeCheckoutRequest,
} from '../../providers/mmg/mmg-checkout';
import { getMmgProvider } from '../../providers/mmg/mmg-provider';
import { PowerTranzCardRailProvider, PowerTranzConfigError, powerTranzConfigFromEnv } from '../../providers/card/powertranz-provider';

// ---------------------------------------------------------------------------
// [PT-5] The owner's payments self-check, run ON THE SERVER after the
// credentials were entered with deploy/owner/swift-payments-setup.command.
// It prints only OK / FAIL lines: never a value, a key, a token, a merchant
// number or an answer from a provider. A FAIL line may name a SETTING (never
// its value) so the owner knows what to fix.
//
//   card  the provider's settings are complete; its gateway answers (guide
//         v2.7 sec. 3 "Alive"); the credentials are not refused (Appendix 1,
//         89 / 312); in the sandbox, the hosted payment page preprocesses
//         (SP4) — preprocessing is no authorization (sec. 7.3) and the
//         self-check never completes anything: no money moves.
//   mmg   the checkout settings and both keys load; both keys are 4096-bit;
//         a test request encrypts within what the key carries (RSA-OAEP
//         SHA-256: 446 bytes for 4096 bits); the merchant login answers.
// ---------------------------------------------------------------------------

export type SelfCheckLine = { ok: boolean; check: string };
export type SelfCheckPart = 'card' | 'mmg';

export interface SelfCheckDeps {
  redis?: Redis;
  /** The card provider's HTTP client (tests pass a fake gateway). */
  fetch?: typeof fetch;
  /** The MMG merchant login (tests pass a fake). */
  mmgLogin?: () => Promise<{ token: string }>;
}

/**
 * [DS845 S4] The self-check's Redis, connected up front: a Redis that cannot be
 * reached is the plain FAIL line "the self-check reaches Redis", never an
 * unhandled client error printed with its stack into the container's logs.
 */
export async function connectSelfCheckRedis(url: string | undefined): Promise<Redis | undefined> {
  if (!url) return undefined;
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 5_000, enableOfflineQueue: false, retryStrategy: () => null });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    return redis;
  } catch {
    redis.disconnect();
    return undefined;
  }
}

/** What a FAIL may say about configuration: the names of the settings it mentions, nothing else. */
function settingNames(message: string): string {
  const names = [...new Set(message.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) ?? [])];
  return names.length ? ` (${names.join(', ')})` : '';
}

async function cardLines(env: Record<string, string | undefined>, deps: SelfCheckDeps): Promise<SelfCheckLine[]> {
  if (env['CARD_RAIL_PROVIDER'] !== 'powertranz') {
    return [{ ok: false, check: 'card: CARD_RAIL_PROVIDER is set to powertranz' }];
  }
  let provider: PowerTranzCardRailProvider;
  try {
    const config = powerTranzConfigFromEnv(env);
    if (!deps.redis) return [{ ok: false, check: 'card: the self-check reaches Redis (REDIS_URL)' }];
    provider = new PowerTranzCardRailProvider(deps.redis, config, { keyPrefix: 'ptz:selfcheck:', ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  } catch (err) {
    const why = err instanceof PowerTranzConfigError ? settingNames(err.message) : '';
    return [{ ok: false, check: `card: settings complete${why}` }];
  }
  const out: SelfCheckLine[] = [{ ok: true, check: 'card: settings complete' }];
  const base = (env['API_PUBLIC_URL'] ?? '').replace(/\/+$/, '');
  const lines = await provider.selfCheck({
    preprocess: provider.binding.environment === 'sandbox',
    returnUrl: `${base}/api/v1/billing/card/return?session=selfcheck&state=${'0'.repeat(43)}`,
  }).catch(() => [{ check: 'the provider checks could finish', ok: false }]);
  for (const line of lines) out.push({ ok: line.ok, check: `card: ${line.check}` });
  return out;
}

async function mmgLines(env: Record<string, string | undefined>, deps: SelfCheckDeps): Promise<SelfCheckLine[]> {
  let config: ReturnType<typeof loadMmgCheckoutConfig>;
  try {
    config = loadMmgCheckoutConfig(env);
  } catch (err) {
    return [{ ok: false, check: `mmg: checkout settings and keys load${settingNames((err as Error).message)}` }];
  }
  const out: SelfCheckLine[] = [{ ok: true, check: 'mmg: checkout settings and keys load' }];
  const requestBits = config.requestPublicKey.asymmetricKeyDetails?.modulusLength ?? 0;
  const resultBits = config.resultPrivateKey.asymmetricKeyDetails?.modulusLength ?? 0;
  out.push({ ok: requestBits === 4096, check: 'mmg: the request key (MMG_CHECKOUT_PUBLIC_KEY) is 4096-bit' });
  out.push({ ok: resultBits === 4096, check: 'mmg: the reply key (MMG_CHECKOUT_PRIVATE_KEY) is 4096-bit' });
  try {
    const now = new Date();
    const plaintext = serializeCheckoutRequest(buildCheckoutRequest({
      secretKey: config.secretKey, amount: '1', merchantId: config.merchantId, merchantTransactionId: newMerchantTransactionId(now),
      productDescription: MMG_CHECKOUT_PRODUCT_DESCRIPTION, requestInitiationTime: requestInitiationTime(now), merchantName: config.merchantName,
    }));
    const limit = oaepSha256MaxPlaintextBytes(requestBits / 8);
    const sealed = encryptCheckoutRequest(plaintext, config.requestPublicKey);
    out.push({ ok: plaintext.length <= limit && sealed.length === requestBits / 8, check: `mmg: a test request encrypts within the key's limit (${limit} bytes)` });
  } catch {
    out.push({ ok: false, check: 'mmg: a test request encrypts within the key\'s limit' });
  }
  if ((env['MMG_DRIVER'] ?? 'sandbox') !== 'live') {
    out.push({ ok: false, check: 'mmg: MMG_DRIVER is live (the merchant login is checked only then)' });
    return out;
  }
  const login = deps.mmgLogin ?? (() => getMmgProvider().authenticate());
  const answered = await login().then((r) => typeof r.token === 'string' && r.token.length > 0).catch(() => false);
  out.push({ ok: answered, check: 'mmg: the merchant login works' });
  return out;
}

export async function runPaymentsSelfCheck(
  parts: readonly SelfCheckPart[],
  env: Record<string, string | undefined> = process.env,
  deps: SelfCheckDeps = {},
): Promise<SelfCheckLine[]> {
  const out: SelfCheckLine[] = [];
  if (parts.includes('card')) out.push(...await cardLines(env, deps));
  if (parts.includes('mmg')) out.push(...await mmgLines(env, deps));
  return out;
}

/** The printed form: `OK   check` / `FAIL check`. */
export function formatSelfCheck(lines: readonly SelfCheckLine[]): string {
  return lines.map((l) => `${l.ok ? 'OK  ' : 'FAIL'} ${l.check}`).join('\n');
}
