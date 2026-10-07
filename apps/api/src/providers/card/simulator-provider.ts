import { randomBytes } from 'node:crypto';
import type Redis from 'ioredis';
import { isProduction } from '../../utils/runtime-mode';
import {
  assertBinding,
  rawDigest,
  type CardChargeOutcome,
  type CardOutcomeStatus,
  type CardRailBinding,
  type CardRailProvider,
  type CardRefundOutcome,
  type CardReturnObservation,
  type CardSessionOutcome,
  type CardSessionPurpose,
  type CreateCardSessionOutcome,
} from './card-provider';

// ---------------------------------------------------------------------------
// [PT-1 · C10] Swift's card SIMULATOR — the whole card loop, provable before
// any real processor is plugged in, with no card and no money anywhere.
//
//  - Its hosted page (served by the routes in PT-2) offers exactly four
//    buttons and NO input of any kind: it never accepts a card number, a
//    security code or a PIN (AH.10.9: no Swift-hosted card form, ever).
//  - It is labelled as a TEST PAGE with no real money wherever it appears.
//  - Production can never construct it (the constructor throws), the
//    provider factory refuses it, and the boot guard refuses to start.
//  - Its state lives in Redis, never in process memory: the API process that
//    opens a session and the worker process that confirms or charges later
//    read the same facts. Outcomes are deterministic per button.
// ---------------------------------------------------------------------------

export const SIMULATOR_PROVIDER = 'simulator';

export const SIMULATOR_SCENARIOS = ['APPROVE', 'APPROVE_3DS_LATER', 'DECLINE', 'TIMEOUT'] as const;
export type SimulatorScenario = (typeof SIMULATOR_SCENARIOS)[number];

export function isSimulatorScenario(value: unknown): value is SimulatorScenario {
  return typeof value === 'string' && (SIMULATOR_SCENARIOS as readonly string[]).includes(value);
}

/** Everything the simulator page may show. Four buttons, no inputs. */
export const SIMULATOR_PAGE = {
  title: 'Swift card simulator',
  testModeLabel: 'TEST PAGE — no real card and no real money. This page never asks for a card number.',
  buttons: [
    { scenario: 'APPROVE', label: 'Approve', explains: 'The test card is approved. Swift saves it (Add card) or takes the payment (Pay now).' },
    { scenario: 'APPROVE_3DS_LATER', label: 'Approve, but weekly charges need 3-D Secure', explains: 'Approved now. Every later automatic weekly charge answers "needs 3-D Secure": the partner is asked to confirm their card and is never penalised for it.' },
    { scenario: 'DECLINE', label: 'Decline', explains: 'The bank declines. Nothing is saved and nothing is charged.' },
    { scenario: 'TIMEOUT', label: 'Time out', explains: 'The bank approves, but the answer is lost on the way back once. Swift must look it up — and never charges twice.' },
  ],
  inputs: [],
} as const satisfies {
  title: string;
  testModeLabel: string;
  buttons: ReadonlyArray<{ scenario: SimulatorScenario; label: string; explains: string }>;
  inputs: readonly never[];
};

/** A page action the simulator refuses. Nothing was recorded. */
export class SimulatorRefusal extends Error {
  override readonly name = 'SimulatorRefusal';
  constructor(readonly code: 'SESSION_NOT_FOUND' | 'SESSION_EXPIRED' | 'ALREADY_CHOSEN' | 'UNKNOWN_SCENARIO') {
    super(`card simulator refused: ${code}`);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A session's facts outlive its page long enough for any reconciliation. */
const SESSION_RETAIN_MS = 30 * DAY_MS;
const RECORD_TTL_SEC = 90 * 24 * 60 * 60;

/** The simulated card each approving button produces. The digits are display
 *  facts chosen by the simulator; no card number exists anywhere. */
const SIMULATED_CARD: Record<Exclude<SimulatorScenario, 'DECLINE'>, { variant: TokenVariant; last4: string }> = {
  APPROVE: { variant: 'ok', last4: '4242' },
  APPROVE_3DS_LATER: { variant: '3ds', last4: '3155' },
  TIMEOUT: { variant: 'timeout', last4: '0077' },
};
type TokenVariant = 'ok' | '3ds' | 'timeout';
const TOKEN_SHAPE = /^simtok_(ok|3ds|timeout)_[0-9a-f]{24}$/;

/** Where the simulator keeps its facts in Redis. Every process that must agree
 *  (the API and the worker) uses the default. [AX297 F3] A test run passes
 *  its own namespace, cardsim:<run>:, so it can delete exactly what it wrote
 *  and never another run's sessions or captures. */
export const SIMULATOR_KEY_PREFIX = 'cardsim:';
const KEY_PREFIX_SHAPE = /^cardsim:(?:[A-Za-z0-9_-]{1,64}:)?$/;

/** First choice wins, atomically: a second button press cannot rewrite what
 *  the bank "did". Returns 'missing', 'set' or 'chosen:<scenario>'. */
const CHOOSE_ONCE = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 'missing' end
local chosen = redis.call('HGET', KEYS[1], 'scenario')
if chosen then return 'chosen:' .. chosen end
redis.call('HSET', KEYS[1], unpack(ARGV))
return 'set'`;

/** One lost answer: while the counter is above zero, spend one and say so. */
const SPEND_TIMEOUT = `
local left = tonumber(redis.call('HGET', KEYS[1], 'timeouts') or '0')
if left > 0 then return redis.call('HINCRBY', KEYS[1], 'timeouts', -1) end
return -1`;

/** An off-session charge record: created once per key (the provider's own
 *  idempotency), then every answer for that key reads the same record and,
 *  for a timing-out card, loses the first answer. Returns { json, left }. */
const CHARGE_ONCE = `
if ARGV[4] == '1' and redis.call('HSETNX', KEYS[1], 'json', ARGV[1]) == 1 then
  redis.call('HSET', KEYS[1], 'timeouts', ARGV[2])
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
end
local json = redis.call('HGET', KEYS[1], 'json')
if not json then return { '', -1 } end
local left = -1
if tonumber(redis.call('HGET', KEYS[1], 'timeouts') or '0') > 0 then
  left = redis.call('HINCRBY', KEYS[1], 'timeouts', -1)
end
return { json, left }`;

interface ChargeRecord {
  outcome: 'succeeded' | 'requires_action';
  providerRef: string;
  amountMinor: number;
  currencyCode: string;
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex');

export class SimulatorCardRailProvider implements CardRailProvider {
  readonly simulator = true;
  /** The simulator exercises the whole Add card loop on a test server. */
  readonly savesCards = true;
  readonly binding: CardRailBinding;
  /** The Redis namespace this simulator reads and writes (SIMULATOR_KEY_PREFIX by default). */
  readonly keyPrefix: string;
  private readonly publicBaseUrl: string;
  private readonly key = {
    session: (ref: string) => `${this.keyPrefix}s:${ref}`,
    charge: (account: string, idempotencyKey: string) => `${this.keyPrefix}c:${account}:${idempotencyKey}`,
    refund: (account: string, idempotencyKey: string) => `${this.keyPrefix}r:${account}:${idempotencyKey}`,
  };

  constructor(
    private readonly redis: Redis,
    opts: { account: string; publicBaseUrl?: string; keyPrefix?: string },
    env: Record<string, string | undefined> = process.env,
  ) {
    // [C10] Refused at construction, not only by the factory and the boot
    // guard: no path — a test helper, a script, a future caller — builds a
    // simulator in a production process.
    if (isProduction(env)) {
      throw new Error('FATAL: the card simulator can never run in production — it is a test page with no real money');
    }
    this.binding = { provider: SIMULATOR_PROVIDER, environment: 'sandbox', account: opts.account };
    this.publicBaseUrl = (opts.publicBaseUrl ?? '').replace(/\/+$/, '');
    const keyPrefix = opts.keyPrefix ?? SIMULATOR_KEY_PREFIX;
    if (!KEY_PREFIX_SHAPE.test(keyPrefix)) {
      throw new Error('The card simulator key prefix is cardsim: or cardsim:<name>: (letters, digits, dash, underscore)');
    }
    this.keyPrefix = keyPrefix;
  }

  /** [PT-2] What the scenario page shows for one session: its purpose and,
   *  for a Pay now, the server's price. Null when the simulator holds no such
   *  session. Never the return address, Swift's state or a token. */
  async pageFor(providerSessionRef: string, now = new Date()): Promise<{
    purpose: CardSessionPurpose; amountMinor?: number; currencyCode?: string; expired: boolean; chosen: SimulatorScenario | null;
  } | null> {
    const facts = await this.redis.hgetall(this.key.session(providerSessionRef));
    if (!facts['sessionRef'] || (facts['purpose'] !== 'ENROLL' && facts['purpose'] !== 'PAY_NOW')) return null;
    const chosen = facts['scenario'];
    return {
      purpose: facts['purpose'],
      ...(facts['purpose'] === 'PAY_NOW' ? { amountMinor: Number(facts['amountMinor']), currencyCode: facts['currencyCode'] ?? '' } : {}),
      expired: now.getTime() > Number(facts['expiresAtMs']),
      chosen: isSimulatorScenario(chosen) ? chosen : null,
    };
  }

  /** The address of the scenario page for one session (served in PT-2). */
  hostedUrlFor(providerSessionRef: string): string {
    return `${this.publicBaseUrl}/api/v1/billing/card/simulator/${providerSessionRef}`;
  }

  async createSession(input: Parameters<CardRailProvider['createSession']>[0]): Promise<CreateCardSessionOutcome> {
    assertBinding(this.binding, input.binding);
    if (input.purpose === 'PAY_NOW' && (!Number.isSafeInteger(input.amountMinor) || (input.amountMinor ?? 0) <= 0 || !/^[A-Z]{3}$/.test(input.currencyCode ?? ''))) {
      return { status: 'failed', reason: 'A Pay-now session needs a positive amount in minor units and a currency', rawSha256: rawDigest({ refused: 'amount' }) };
    }
    const providerSessionRef = `sim_${hex(12)}`;
    const k = this.key.session(providerSessionRef);
    await this.redis.hset(k, {
      sessionRef: input.sessionRef,
      purpose: input.purpose,
      returnUrl: input.returnUrl,
      expiresAtMs: String(input.expiresAt.getTime()),
      ...(input.purpose === 'PAY_NOW' ? { amountMinor: String(input.amountMinor), currencyCode: input.currencyCode! } : {}),
    });
    await this.redis.pexpireat(k, input.expiresAt.getTime() + SESSION_RETAIN_MS);
    return {
      status: 'succeeded',
      providerSessionRef,
      hostedUrl: this.hostedUrlFor(providerSessionRef),
      rawSha256: rawDigest({ providerSessionRef, purpose: input.purpose, sessionRef: input.sessionRef }),
    };
  }

  /**
   * The page's button (PT-2 serves it). Records what the "bank" did, once,
   * and answers where the browser goes next: the session's return URL with the
   * simulator's claimed outcome appended. That claim is an observation Swift
   * records and never trusts [C5]; Swift's confirmation asks this provider.
   */
  async choose(providerSessionRef: string, scenario: unknown, now = new Date()): Promise<{ redirectUrl: string }> {
    if (!isSimulatorScenario(scenario)) throw new SimulatorRefusal('UNKNOWN_SCENARIO');
    const k = this.key.session(providerSessionRef);
    const facts = await this.redis.hgetall(k);
    if (!facts['sessionRef']) throw new SimulatorRefusal('SESSION_NOT_FOUND');
    if (now.getTime() > Number(facts['expiresAtMs'])) throw new SimulatorRefusal('SESSION_EXPIRED');

    const fields: string[] = ['scenario', scenario];
    if (scenario !== 'DECLINE') {
      const card = SIMULATED_CARD[scenario];
      if (facts['purpose'] === 'ENROLL') {
        fields.push(
          'vaultToken', `simtok_${card.variant}_${hex(12)}`,
          'brand', 'SIMULATED', 'last4', card.last4,
          'expMonth', '12', 'expYear', String(now.getUTCFullYear() + 4),
        );
      } else {
        fields.push('captureRef', `simpay_${hex(12)}`);
      }
      if (scenario === 'TIMEOUT') fields.push('timeouts', '1');
    }
    const result = String(await this.redis.eval(CHOOSE_ONCE, 1, k, ...fields));
    if (result === 'missing') throw new SimulatorRefusal('SESSION_NOT_FOUND');
    if (result.startsWith('chosen:') && result !== `chosen:${scenario}`) throw new SimulatorRefusal('ALREADY_CHOSEN');

    const returnUrl = facts['returnUrl'] ?? '';
    const sep = returnUrl.includes('?') ? '&' : '?';
    return { redirectUrl: `${returnUrl}${sep}sim_ref=${encodeURIComponent(providerSessionRef)}&sim_outcome=${scenario.toLowerCase()}` };
  }

  parseReturn(params: Readonly<Record<string, string>>): CardReturnObservation {
    const claimed: Record<string, CardOutcomeStatus> = {
      approve: 'succeeded', approve_3ds_later: 'succeeded', decline: 'failed', timeout: 'unknown',
    };
    const outcome = params['sim_outcome'];
    return {
      rawSha256: rawDigest(params),
      claimedStatus: (outcome !== undefined && claimed[outcome]) || 'invalid',
    };
  }

  async confirm(input: { binding: CardRailBinding; providerSessionRef: string; purpose: CardSessionPurpose }): Promise<CardSessionOutcome> {
    assertBinding(this.binding, input.binding);
    const k = this.key.session(input.providerSessionRef);
    const facts = await this.redis.hgetall(k);
    const raw = { ref: input.providerSessionRef, scenario: facts['scenario'] ?? null, purpose: facts['purpose'] ?? null };
    if (!facts['sessionRef']) return { status: 'unknown', reason: 'The simulator holds no such session', rawSha256: rawDigest(raw) };
    if (facts['purpose'] !== input.purpose) return { status: 'failed', reason: 'Purpose does not match the session', rawSha256: rawDigest(raw) };
    const scenario = facts['scenario'];
    if (!scenario) return { status: 'pending', rawSha256: rawDigest(raw) };
    if (scenario === 'DECLINE') return { status: 'failed', reason: 'Card declined (simulator)', rawSha256: rawDigest(raw) };
    if (scenario === 'TIMEOUT' && Number(await this.redis.eval(SPEND_TIMEOUT, 1, k)) >= 0) {
      return { status: 'unknown', reason: 'Simulated timeout: the answer was lost on the way back', rawSha256: rawDigest({ ...raw, lost: true }) };
    }
    if (input.purpose === 'ENROLL') {
      return {
        status: 'succeeded',
        purpose: 'ENROLL',
        card: {
          vaultToken: facts['vaultToken']!,
          brand: facts['brand']!,
          last4: facts['last4']!,
          expMonth: Number(facts['expMonth']),
          expYear: Number(facts['expYear']),
        },
        // The token never enters the digest's preimage in the clear.
        rawSha256: rawDigest({ ...raw, card: rawDigest(facts['vaultToken']) }),
      };
    }
    return {
      status: 'succeeded',
      purpose: 'PAY_NOW',
      providerRef: facts['captureRef']!,
      amountMinor: Number(facts['amountMinor']),
      currencyCode: facts['currencyCode']!,
      rawSha256: rawDigest({ ...raw, captureRef: facts['captureRef'] }),
    };
  }

  async chargeInstrument(input: Parameters<CardRailProvider['chargeInstrument']>[0]): Promise<CardChargeOutcome> {
    assertBinding(this.binding, input.binding);
    const variant = TOKEN_SHAPE.exec(input.vaultToken)?.[1] as TokenVariant | undefined;
    if (!variant) return { status: 'failed', reason: 'Invalid vault token (simulator)', rawSha256: rawDigest({ refused: 'token' }) };
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || !/^[A-Z]{3}$/.test(input.currencyCode)) {
      return { status: 'failed', reason: 'Invalid amount or currency (simulator)', rawSha256: rawDigest({ refused: 'amount' }) };
    }
    const record: ChargeRecord = {
      outcome: variant === '3ds' ? 'requires_action' : 'succeeded',
      providerRef: `simch_${hex(12)}`,
      amountMinor: input.amountMinor,
      currencyCode: input.currencyCode,
    };
    const answer = await this.answerCharge(input.idempotencyKey, record, variant === 'timeout' ? 1 : 0);
    if (answer.kept.amountMinor !== input.amountMinor || answer.kept.currencyCode !== input.currencyCode) {
      // The same key with a different amount is Swift's bug, not the card's:
      // never a decline, never a second charge.
      return { status: 'unknown', reason: 'Idempotency key reused with a different amount (simulator)', rawSha256: rawDigest({ conflict: input.idempotencyKey }) };
    }
    return answer.outcome;
  }

  async retrieve(input: { binding: CardRailBinding; idempotencyKey: string; providerRef?: string }): Promise<CardChargeOutcome> {
    assertBinding(this.binding, input.binding);
    const answer = await this.answerCharge(input.idempotencyKey, null, 0);
    return answer.outcome;
  }

  private async answerCharge(idempotencyKey: string, create: ChargeRecord | null, timeouts: number): Promise<{ outcome: CardChargeOutcome; kept: ChargeRecord }> {
    const k = this.key.charge(this.binding.account, idempotencyKey);
    const [json, left] = await this.redis.eval(
      CHARGE_ONCE, 1, k, create ? JSON.stringify(create) : '', String(timeouts), String(RECORD_TTL_SEC), create ? '1' : '0',
    ) as [string, number];
    if (!json) {
      return {
        outcome: { status: 'unknown', reason: 'The simulator holds no charge under this key', absent: true, rawSha256: rawDigest({ absent: idempotencyKey }) },
        kept: create ?? { outcome: 'succeeded', providerRef: '', amountMinor: 0, currencyCode: '' },
      };
    }
    const kept = JSON.parse(json) as ChargeRecord;
    const rawSha256 = rawDigest({ key: idempotencyKey, ...kept, lost: Number(left) >= 0 });
    if (Number(left) >= 0) {
      return { outcome: { status: 'unknown', reason: 'Simulated timeout: captured, but the answer was lost on the way back', rawSha256 }, kept };
    }
    const outcome: CardChargeOutcome = kept.outcome === 'requires_action'
      ? { status: 'requires_action', reason: 'The bank asks the cardholder to confirm this charge (3-D Secure, simulator)', providerRef: kept.providerRef, rawSha256 }
      : { status: 'succeeded', providerRef: kept.providerRef, amountMinor: kept.amountMinor, currencyCode: kept.currencyCode, rawSha256 };
    return { outcome, kept };
  }

  /** A refund answers PENDING first — the money has not come back yet — and
   *  SUCCEEDED when asked again under the same key. */
  async refund(input: Parameters<CardRailProvider['refund']>[0]): Promise<CardRefundOutcome> {
    assertBinding(this.binding, input.binding);
    if (!/^sim(pay|ch)_[0-9a-f]{24}$/.test(input.providerRef)) {
      return { status: 'failed', reason: 'The simulator holds no such payment', rawSha256: rawDigest({ refused: input.providerRef }) };
    }
    const k = this.key.refund(this.binding.account, input.idempotencyKey);
    await this.redis.hsetnx(k, 'refundRef', `simre_${hex(12)}`);
    await this.redis.expire(k, RECORD_TTL_SEC);
    const calls = await this.redis.hincrby(k, 'calls', 1);
    const refundRef = (await this.redis.hget(k, 'refundRef')) ?? '';
    const rawSha256 = rawDigest({ refundRef, calls });
    return calls > 1 ? { status: 'succeeded', providerRef: refundRef, rawSha256 } : { status: 'pending', providerRef: refundRef, rawSha256 };
  }
}
