import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis';
import { nanoid } from 'nanoid';
import {
  CardBindingMismatchError, cardRefundDisplay, rawDigest,
  type CardRailBinding, type CardRailProvider,
} from '../providers/card/card-provider';
import {
  SIMULATOR_KEY_PREFIX, SIMULATOR_PAGE, SIMULATOR_SCENARIOS, SimulatorCardRailProvider, SimulatorRefusal,
} from '../providers/card/simulator-provider';
import { getCardRailProvider } from '../providers/card/card-rail-factory';
import { deleteRunKeys, runKeyPrefix } from './helpers/card-sim-keys';

// ---------------------------------------------------------------------------
// [PT-1 · C10] The card SIMULATOR's contract. It is the only card rail v2
// provider in this build, so everything the service and billing prove runs on
// it — and it must be exactly what the owner will see on staging: four
// buttons, no card field, a TEST PAGE label, deterministic outcomes, state in
// Redis (never process memory) so the API and the worker agree, one capture
// per key, and a hard refusal to exist in production.
// ---------------------------------------------------------------------------

const REDIS_URL = process.env['REDIS_URL'] || 'redis://localhost:6382/5';
const RUN = nanoid(6).replace(/[^a-zA-Z0-9]/g, '0');
const ACCOUNT = `pt1-sim-${RUN}`;
/** [AX297 F3] This run's own simulator namespace: the teardown deletes exactly it. */
const PREFIX = runKeyPrefix(RUN);
const BINDING: CardRailBinding = { provider: 'simulator', environment: 'sandbox', account: ACCOUNT };
let api: Redis;
let worker: Redis;
let apiSim: SimulatorCardRailProvider;
let workerSim: SimulatorCardRailProvider;

const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000);
/** Synthetic references in the simulator's own shapes, built at runtime (low entropy on purpose). */
const SYNTH_TOKEN = `simtok_ok_${'0'.repeat(24)}`;
const SYNTH_CAPTURE = `simch_${'0'.repeat(24)}`;
async function openSession(purpose: 'ENROLL' | 'PAY_NOW', extra: { amountMinor?: number; currencyCode?: string; expiresAt?: Date } = {}) {
  const created = await apiSim.createSession({
    binding: BINDING,
    sessionRef: `sess_${nanoid(8)}`,
    purpose,
    returnUrl: `/api/v1/billing/card/return?session=s1&state=st1`,
    expiresAt: extra.expiresAt ?? inAnHour(),
    ...(purpose === 'PAY_NOW' ? { amountMinor: extra.amountMinor ?? 1_200_000, currencyCode: extra.currencyCode ?? 'GYD' } : {}),
  });
  if (created.status !== 'succeeded') throw new Error(`simulator refused to open a session: ${created.status}`);
  return created;
}

beforeAll(() => {
  // Two connections stand in for two processes (the API that opens a
  // session, the worker that confirms and charges): nothing is shared but Redis.
  api = new Redis(REDIS_URL);
  worker = new Redis(REDIS_URL);
  apiSim = new SimulatorCardRailProvider(api, { account: ACCOUNT, keyPrefix: PREFIX });
  workerSim = new SimulatorCardRailProvider(worker, { account: ACCOUNT, keyPrefix: PREFIX });
});

afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  await deleteRunKeys(api, PREFIX);
  await api.quit();
  await worker.quit();
});

describe('[C10] the scenario page is four buttons and nothing to type into', () => {
  it('offers exactly Approve / Approve but weekly charges need 3-D Secure / Decline / Time out — and no input at all', () => {
    expect(SIMULATOR_PAGE.buttons.map((b) => b.label)).toEqual([
      'Approve', 'Approve, but weekly charges need 3-D Secure', 'Decline', 'Time out',
    ]);
    expect(SIMULATOR_PAGE.buttons.map((b) => b.scenario)).toEqual([...SIMULATOR_SCENARIOS]);
    expect(SIMULATOR_PAGE.inputs).toEqual([]);
    expect(SIMULATOR_PAGE.testModeLabel).toMatch(/TEST PAGE/);
    expect(SIMULATOR_PAGE.testModeLabel).toMatch(/no real money/);
  });

  it('a button press can only ever be one of the four scenario words — anything else, a card number included, is refused and records nothing', async () => {
    const { providerSessionRef } = await openSession('ENROLL');
    for (const junk of ['4242424242424242', 'approve', '', null, { cardNumber: '4242424242424242' }]) {
      await expect(apiSim.choose(providerSessionRef, junk)).rejects.toMatchObject({ code: 'UNKNOWN_SCENARIO' });
    }
    expect(await api.hget(`${PREFIX}s:${providerSessionRef}`, 'scenario')).toBeNull();
    expect((await workerSim.confirm({ binding: BINDING, providerSessionRef, purpose: 'ENROLL' })).status).toBe('pending');
  });

  it('the simulator says what it is: a test page, sandbox only', () => {
    expect(apiSim.simulator).toBe(true);
    expect(apiSim.binding).toEqual(BINDING);
    expect(apiSim.hostedUrlFor('sim_abc')).toBe('/api/v1/billing/card/simulator/sim_abc');
  });
});

describe('[C1] no card data anywhere on the provider', () => {
  it('no method takes, returns or names a card number, security code or PIN, and there is no tokenize method', () => {
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(apiSim)).filter((m) => m !== 'constructor');
    // [PT-2] pageFor: what the test page shows (purpose, the server's price) — no card data.
    expect(methods.sort()).toEqual(['answerCharge', 'chargeInstrument', 'choose', 'confirm', 'createSession', 'hostedUrlFor', 'pageFor', 'parseReturn', 'refund', 'retrieve']);
    expect(methods.filter((m) => /tokeni[sz]e|pan$|cvv|cvc|cardnumber|pin$/i.test(m))).toEqual([]);
  });
});

describe('sessions: deterministic per button, shared across processes, one choice', () => {
  it('APPROVE on an enrolment: the WORKER (another Redis connection) confirms what the API opened — a vault reference and display facts only', async () => {
    const { providerSessionRef, hostedUrl } = await openSession('ENROLL');
    expect(hostedUrl).toBe(`/api/v1/billing/card/simulator/${providerSessionRef}`);
    const { redirectUrl } = await apiSim.choose(providerSessionRef, 'APPROVE');
    expect(redirectUrl).toBe(`/api/v1/billing/card/return?session=s1&state=st1&sim_ref=${providerSessionRef}&sim_outcome=approve`);
    const outcome = await workerSim.confirm({ binding: BINDING, providerSessionRef, purpose: 'ENROLL' });
    expect(outcome).toMatchObject({
      status: 'succeeded', purpose: 'ENROLL',
      card: { brand: 'SIMULATED', last4: '4242', expMonth: 12, expYear: new Date().getUTCFullYear() + 4 },
    });
    if (outcome.status !== 'succeeded' || outcome.purpose !== 'ENROLL') throw new Error('unreachable');
    expect(outcome.card.vaultToken).toMatch(/^simtok_ok_[0-9a-f]{24}$/);
    // The digest never has the token in its preimage in the clear.
    expect(outcome.rawSha256).toMatch(/^[0-9a-f]{64}$/);
    // Asked again, the same answer: the provider's truth does not drift.
    expect(await apiSim.confirm({ binding: BINDING, providerSessionRef, purpose: 'ENROLL' })).toEqual(outcome);
  });

  it('TIME OUT on a Pay now: the first answer is lost, the next one finds the SAME capture — one capture, never two', async () => {
    const { providerSessionRef } = await openSession('PAY_NOW', { amountMinor: 1_200_000, currencyCode: 'GYD' });
    await apiSim.choose(providerSessionRef, 'TIMEOUT');
    expect((await workerSim.confirm({ binding: BINDING, providerSessionRef, purpose: 'PAY_NOW' })).status).toBe('unknown');
    const second = await workerSim.confirm({ binding: BINDING, providerSessionRef, purpose: 'PAY_NOW' });
    const third = await apiSim.confirm({ binding: BINDING, providerSessionRef, purpose: 'PAY_NOW' });
    expect(second).toMatchObject({ status: 'succeeded', purpose: 'PAY_NOW', amountMinor: 1_200_000, currencyCode: 'GYD' });
    expect(third).toEqual(second);
  });

  it('DECLINE: failed, nothing vaulted; the page cannot be pressed twice with a different answer', async () => {
    const { providerSessionRef } = await openSession('ENROLL');
    await apiSim.choose(providerSessionRef, 'DECLINE');
    await expect(apiSim.choose(providerSessionRef, 'APPROVE')).rejects.toMatchObject({ code: 'ALREADY_CHOSEN' });
    // The same button twice is the same answer (a double tap), not a refusal.
    await expect(apiSim.choose(providerSessionRef, 'DECLINE')).resolves.toMatchObject({ redirectUrl: expect.stringContaining('sim_outcome=decline') });
    const outcome = await workerSim.confirm({ binding: BINDING, providerSessionRef, purpose: 'ENROLL' });
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(await api.hget(`${PREFIX}s:${providerSessionRef}`, 'vaultToken')).toBeNull();
  });

  it('a page past its window, or one that never existed, takes no button press', async () => {
    const { providerSessionRef } = await openSession('ENROLL', { expiresAt: new Date(Date.now() + 1000) });
    await expect(apiSim.choose(providerSessionRef, 'APPROVE', new Date(Date.now() + 5000))).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    await expect(apiSim.choose('sim_nope', 'APPROVE')).rejects.toBeInstanceOf(SimulatorRefusal);
    expect(await workerSim.confirm({ binding: BINDING, providerSessionRef: 'sim_nope', purpose: 'ENROLL' })).toMatchObject({ status: 'unknown' });
  });

  it('parseReturn is an observation only: it reads what the browser CLAIMS and moves nothing', async () => {
    expect(apiSim.parseReturn({ sim_ref: 'sim_x', sim_outcome: 'approve' })).toMatchObject({ claimedStatus: 'succeeded' });
    expect(apiSim.parseReturn({ sim_outcome: 'approve_3ds_later' })).toMatchObject({ claimedStatus: 'succeeded' });
    expect(apiSim.parseReturn({ sim_outcome: 'decline' })).toMatchObject({ claimedStatus: 'failed' });
    expect(apiSim.parseReturn({ sim_outcome: 'timeout' })).toMatchObject({ claimedStatus: 'unknown' });
    expect(apiSim.parseReturn({ sim_outcome: 'paid-in-full' })).toMatchObject({ claimedStatus: 'invalid' });
    expect(apiSim.parseReturn({ a: '1', b: '2' }).rawSha256).toBe(rawDigest({ b: '2', a: '1' }));
  });
});

describe('off-session charges: one capture per key, answers by the token the button produced', () => {
  async function enrolled(scenario: 'APPROVE' | 'APPROVE_3DS_LATER' | 'TIMEOUT'): Promise<string> {
    const { providerSessionRef } = await openSession('ENROLL');
    await apiSim.choose(providerSessionRef, scenario);
    let outcome = await workerSim.confirm({ binding: BINDING, providerSessionRef, purpose: 'ENROLL' });
    if (outcome.status === 'unknown') outcome = await workerSim.confirm({ binding: BINDING, providerSessionRef, purpose: 'ENROLL' });
    if (outcome.status !== 'succeeded' || outcome.purpose !== 'ENROLL') throw new Error(`no card: ${outcome.status}`);
    return outcome.card.vaultToken;
  }

  it('APPROVE card: a capture that says how much and in what currency; the same key never captures again', async () => {
    const vaultToken = await enrolled('APPROVE');
    const key = `card:${nanoid(8)}:2026-09-29:a0`;
    const first = await workerSim.chargeInstrument({ binding: BINDING, vaultToken, amountMinor: 1_200_000, currencyCode: 'GYD', idempotencyKey: key });
    expect(first).toMatchObject({ status: 'succeeded', amountMinor: 1_200_000, currencyCode: 'GYD', providerRef: expect.stringMatching(/^simch_/) });
    const again = await apiSim.chargeInstrument({ binding: BINDING, vaultToken, amountMinor: 1_200_000, currencyCode: 'GYD', idempotencyKey: key });
    expect(again).toEqual(first);
    expect(await apiSim.retrieve({ binding: BINDING, idempotencyKey: key })).toEqual(first);
  });

  it('"weekly charges need 3-D Secure" card: every off-session charge answers requires_action — no capture', async () => {
    const vaultToken = await enrolled('APPROVE_3DS_LATER');
    const outcome = await workerSim.chargeInstrument({ binding: BINDING, vaultToken, amountMinor: 1_200_000, currencyCode: 'GYD', idempotencyKey: `card:${nanoid(8)}:a0` });
    expect(outcome).toMatchObject({ status: 'requires_action' });
  });

  it('TIME OUT card: captured, the first answer lost; retrieval and a repeat under the same key find the SAME capture', async () => {
    const vaultToken = await enrolled('TIMEOUT');
    const key = `card:${nanoid(8)}:a0`;
    expect(await workerSim.chargeInstrument({ binding: BINDING, vaultToken, amountMinor: 900_000, currencyCode: 'GYD', idempotencyKey: key }))
      .toMatchObject({ status: 'unknown' });
    const found = await apiSim.retrieve({ binding: BINDING, idempotencyKey: key });
    expect(found).toMatchObject({ status: 'succeeded', amountMinor: 900_000, currencyCode: 'GYD' });
    expect(await workerSim.chargeInstrument({ binding: BINDING, vaultToken, amountMinor: 900_000, currencyCode: 'GYD', idempotencyKey: key })).toEqual(found);
  });

  it('a key it never saw is UNKNOWN and marked absent — never a decline', async () => {
    expect(await workerSim.retrieve({ binding: BINDING, idempotencyKey: `card:never-${nanoid(6)}` })).toMatchObject({ status: 'unknown', absent: true });
  });

  it('the same key with a different amount is Swift’s bug, not the card’s: unknown, never a decline and never a second capture', async () => {
    const vaultToken = await enrolled('APPROVE');
    const key = `card:${nanoid(8)}:a0`;
    await workerSim.chargeInstrument({ binding: BINDING, vaultToken, amountMinor: 100, currencyCode: 'GYD', idempotencyKey: key });
    expect(await workerSim.chargeInstrument({ binding: BINDING, vaultToken, amountMinor: 999, currencyCode: 'GYD', idempotencyKey: key }))
      .toMatchObject({ status: 'unknown' });
  });
});

describe('[C2] a token bound to one provider setup is never acted on for another', () => {
  it('another account, environment or provider is refused BEFORE any effect — not one Redis key is written', async () => {
    const vaultToken = SYNTH_TOKEN;
    const before = (await api.keys(`${PREFIX}*`)).length;
    for (const other of [
      { ...BINDING, account: 'someone-else' },
      { ...BINDING, environment: 'live' as const },
      { ...BINDING, provider: 'another' },
    ]) {
      await expect(apiSim.chargeInstrument({ binding: other, vaultToken, amountMinor: 1, currencyCode: 'GYD', idempotencyKey: `k-${nanoid(6)}` }))
        .rejects.toBeInstanceOf(CardBindingMismatchError);
      await expect(apiSim.retrieve({ binding: other, idempotencyKey: 'k' })).rejects.toBeInstanceOf(CardBindingMismatchError);
      await expect(apiSim.confirm({ binding: other, providerSessionRef: 'sim_x', purpose: 'ENROLL' })).rejects.toBeInstanceOf(CardBindingMismatchError);
      await expect(apiSim.createSession({ binding: other, sessionRef: 's', purpose: 'ENROLL', returnUrl: '/r', expiresAt: inAnHour() }))
        .rejects.toBeInstanceOf(CardBindingMismatchError);
      await expect(apiSim.refund({ binding: other, providerRef: SYNTH_CAPTURE, amountMinor: 1, currencyCode: 'GYD', idempotencyKey: 'r' }))
        .rejects.toBeInstanceOf(CardBindingMismatchError);
    }
    expect((await api.keys(`${PREFIX}*`)).length).toBe(before);
  });
});

describe('refunds: pending is never shown as refunded', () => {
  it('the first answer is PENDING (the money is not back yet); only a later succeeded answer displays as refunded', async () => {
    const key = `refund:${nanoid(8)}`;
    const first = await apiSim.refund({ binding: BINDING, providerRef: SYNTH_CAPTURE, amountMinor: 100, currencyCode: 'GYD', idempotencyKey: key });
    expect(first.status).toBe('pending');
    expect(cardRefundDisplay(first)).toBe('REFUND_PENDING');
    const second = await workerSim.refund({ binding: BINDING, providerRef: SYNTH_CAPTURE, amountMinor: 100, currencyCode: 'GYD', idempotencyKey: key });
    expect(second.status).toBe('succeeded');
    expect(cardRefundDisplay(second)).toBe('REFUNDED');
    // Every non-succeeded outcome says what it is — none of them says refunded.
    for (const status of ['pending', 'failed', 'unknown'] as const) expect(cardRefundDisplay({ status })).not.toBe('REFUNDED');
  });
});

describe('[C10 · DS285 F8] production can never have a simulator', () => {
  it('the provider source refuses the simulator in production, mirroring the legacy sandbox refusal', () => {
    expect(() => getCardRailProvider({ redis: api }, { NODE_ENV: 'production', CARD_RAIL_PROVIDER: 'simulator' }))
      .toThrow(/forbidden in production/);
  });

  it('the simulator refuses to be CONSTRUCTED in a production process, whoever calls it', () => {
    expect(() => new SimulatorCardRailProvider(api, { account: 'x' }, { NODE_ENV: 'production' })).toThrow(/never run in production/);
  });

  it('the source never guesses: no provider named, a non-sandbox simulator, a bad label or an unknown provider are refused', () => {
    expect(() => getCardRailProvider({ redis: api }, { NODE_ENV: 'development' })).toThrow(/CARD_RAIL_PROVIDER is not set/);
    expect(() => getCardRailProvider({ redis: api }, { NODE_ENV: 'development', CARD_RAIL_PROVIDER: 'simulator', CARD_RAIL_ENVIRONMENT: 'live' })).toThrow(/sandbox/);
    expect(() => getCardRailProvider({ redis: api }, { NODE_ENV: 'development', CARD_RAIL_PROVIDER: 'simulator', CARD_RAIL_ACCOUNT: 'has spaces' })).toThrow(/label/);
    expect(() => getCardRailProvider({ redis: api }, { NODE_ENV: 'development', CARD_RAIL_PROVIDER: 'some-bank' })).toThrow(/Unknown CARD_RAIL_PROVIDER/);
    const made: CardRailProvider = getCardRailProvider({ redis: api }, { NODE_ENV: 'development', CARD_RAIL_PROVIDER: 'simulator', CARD_RAIL_ACCOUNT: 'staging-sim' });
    expect(made.binding).toEqual({ provider: 'simulator', environment: 'sandbox', account: 'staging-sim' });
    expect(made.simulator).toBe(true);
  });
});

describe('[AX297 F3] a test run cleans up only what it wrote', () => {
  it('teardown deletes this run’s keys and nothing else: another run’s keys, and the shared namespace, survive', async () => {
    const mine = runKeyPrefix(`${RUN}f3`);
    const theirs = runKeyPrefix(`${RUN}f3other`); // shares a prefix of the id: the glob must not reach it
    const ours = new SimulatorCardRailProvider(api, { account: ACCOUNT, keyPrefix: mine });
    const created = await ours.createSession({ binding: BINDING, sessionRef: `sess_${nanoid(8)}`, purpose: 'ENROLL', returnUrl: '/r', expiresAt: inAnHour() });
    if (created.status !== 'succeeded') throw new Error('the simulator did not open a session');
    const theirSession = `${theirs}s:sim_other_run`;
    const sharedSession = `${SIMULATOR_KEY_PREFIX}s:sim_dev_server_${RUN}`;
    await api.set(theirSession, 'another run');
    await api.set(sharedSession, 'a dev server');
    try {
      expect(await api.exists(`${mine}s:${created.providerSessionRef}`)).toBe(1);
      expect(await deleteRunKeys(api, mine)).toBeGreaterThanOrEqual(1);
      expect(await api.keys(`${mine}*`)).toEqual([]);
      expect(await api.get(theirSession)).toBe('another run');
      expect(await api.get(sharedSession)).toBe('a dev server');
    } finally {
      await api.del(theirSession, sharedSession);
    }
  });

  it('the teardown refuses anything wider than one run: the shared namespace, a glob, another shape', async () => {
    for (const prefix of ['cardsim:', 'cardsim:*', 'cardsim:t-*:', 'cardsim:s:', '*', `cardsim:t-${RUN}`]) {
      await expect(deleteRunKeys(api, prefix), prefix).rejects.toThrow(/refusing to delete/);
    }
    expect(() => runKeyPrefix('a*b')).toThrow(/not a run id/);
  });

  it('a simulator’s namespace is cardsim: or cardsim:<name>:, nothing else', () => {
    expect(new SimulatorCardRailProvider(api, { account: 'x' }).keyPrefix).toBe(SIMULATOR_KEY_PREFIX);
    for (const keyPrefix of ['other:', 'cardsim:*:', 'cardsim:a b:', 'cardsim:x']) {
      expect(() => new SimulatorCardRailProvider(api, { account: 'x', keyPrefix }), keyPrefix).toThrow(/key prefix/);
    }
  });
});

describe('[AX297 F6] the templates’ blank settings read as unset', () => {
  it('an EMPTY CARD_RAIL_ENVIRONMENT (as the templates ship it blank-or-sandbox) means sandbox, and an empty account means "simulator"', () => {
    const made = getCardRailProvider({ redis: api }, { NODE_ENV: 'development', CARD_RAIL_PROVIDER: 'simulator', CARD_RAIL_ENVIRONMENT: '', CARD_RAIL_ACCOUNT: '' });
    expect(made.binding).toEqual({ provider: 'simulator', environment: 'sandbox', account: 'simulator' });
  });
});
