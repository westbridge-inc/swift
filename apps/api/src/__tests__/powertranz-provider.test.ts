import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { nanoid } from 'nanoid';
import {
  POWERTRANZ_SANDBOX_ROOT,
  PowerTranzCardRailProvider,
  PowerTranzConfigError,
  alphaOfCurrency,
  authenticationDecision,
  authenticationResultOf,
  minorOfTotalAmount,
  powerTranzConfigFromEnv,
  readCompletion,
  totalAmountOf,
  type PowerTranzConfig,
} from '../providers/card/powertranz-provider';
import { CardBindingMismatchError } from '../providers/card/card-provider';
import { createHash, randomUUID } from 'node:crypto';
import { CARD_ON_FILE_CONSENT_SHA256, CARD_ON_FILE_CONSENT_TEXT, CARD_ON_FILE_CONSENT_VERSION } from '../modules/billing/card-rail.service';

// ---------------------------------------------------------------------------
// [PT-4] The real card provider against a fake gateway that answers in the
// shapes of PowerTranz's own guide v2.7 (sec. 6 response fields; sec. 7.2 HPP
// preprocessing; sec. 7.3 completion; sec. 7.5 refund; sec. 7.6 void;
// Appendix 1 codes). Every value is synthetic: no real card, no real
// credential, no real token. What is proved:
//   - requests carry exactly the guide's paths, headers and fields, and
//     never a card number [C1];
//   - the completion is the only money truth, sent at most once per page, and
//     only after the bank's 3-D Secure check passed (sec. 8);
//   - anything the guide does not document is unknown, never success;
//   - no off-session charge is ever sent (sec. 7.8): requires_action, no call;
//   - a refund or void is sent at most once per key.
// ---------------------------------------------------------------------------

const RUN = nanoid(8).replace(/[^A-Za-z0-9]/g, '0');
const PREFIX = `ptz:t${RUN}:`;
let redis: Redis;

const CONFIG: PowerTranzConfig = {
  account: `pt4-${RUN}`,
  environment: 'sandbox',
  apiRoot: POWERTRANZ_SANDBOX_ROOT,
  powerTranzId: 'TESTID01',
  password: 'test-password-not-real',
  pageSet: 'PTZ/SwiftTest',
  pageName: 'WeeklyFee',
  publicBaseUrl: 'https://api.example.test',
};

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };
type Responder = (call: Call) => { status: number; body: unknown } | 'network' | 'timeout';

/** A fake gateway: records every call and answers with the scripted responder for its path. */
function gateway(routes: Record<string, Responder>) {
  const calls: Call[] = [];
  const fakeFetch = (async (url: string | URL, init?: Parameters<typeof globalThis.fetch>[1]) => {
    const call: Call = {
      url: String(url), method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const path = new URL(call.url).pathname;
    const responder = routes[path];
    if (!responder) return new Response('not found', { status: 404 });
    const answer = responder(call);
    if (answer === 'network') throw new TypeError('fetch failed');
    if (answer === 'timeout') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    return new Response(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fakeFetch, calls, paths: () => calls.map((c) => new URL(c.url).pathname) };
}

/** sec. 7.2: the HPP preprocessing answer (SP4, RedirectData, SpiToken), echoing the request's identifiers. */
const preprocessed = (call: Call) => {
  const req = JSON.parse(call.body ?? '{}') as Record<string, unknown>;
  return {
    status: 200,
    body: {
      TransactionType: 2, Approved: false, TransactionIdentifier: req['TransactionIdentifier'], IsoResponseCode: 'SP4',
      ResponseMessage: 'SPI Preprocessing complete', OrderIdentifier: req['OrderIdentifier'],
      RedirectData: '<html><body><form id="f" method="post" action="https://staging.ptranz.com/hpp"><input type="hidden" name="t" value="synthetic"></form><script>document.getElementById("f").submit()</script></body></html>',
      SpiToken: `spi-synthetic-${nanoid(10)}`,
    },
  };
};

/** sec. 7.3: the completion answer for the held transaction. */
const completion = (fields: Record<string, unknown>) => (txnId: string) => ({
  status: 200,
  body: {
    TransactionType: 2, Approved: true, AuthorizationCode: '123456', TransactionIdentifier: txnId, TotalAmount: 2100, CurrencyCode: '328', RRN: '000000000001', CardBrand: 'Visa', IsoResponseCode: '00', ResponseMessage: 'Transaction is approved.',
    RiskManagement: { ThreeDSecure: { Eci: '05', AuthenticationStatus: 'Y', ResponseCode: '3D0' } }, // sec. 6: present in every response
    ...fields,
  },
});

function provider(gw: ReturnType<typeof gateway>, opts: { now?: () => Date; config?: Partial<PowerTranzConfig> } = {}) {
  return new PowerTranzCardRailProvider(redis, { ...CONFIG, ...opts.config }, { fetch: gw.fetch, keyPrefix: PREFIX, ...(opts.now ? { now: opts.now } : {}) });
}

const RETURN_URL = 'https://api.example.test/api/v1/billing/card/return?session=cs_synthetic&state=' + 'S'.repeat(43);

async function openPage(p: PowerTranzCardRailProvider, overrides: Partial<Parameters<PowerTranzCardRailProvider['createSession']>[0]> = {}) {
  const created = await p.createSession({
    binding: p.binding, sessionRef: `cs_${nanoid(10)}`, purpose: 'PAY_NOW', returnUrl: RETURN_URL,
    expiresAt: new Date(Date.now() + 15 * 60_000), amountMinor: 210_000, currencyCode: 'GYD', ...overrides,
  });
  expect(created.status).toBe('succeeded');
  if (created.status !== 'succeeded') throw new Error('unreachable');
  const held = await redis.hgetall(`${PREFIX}s:${created.providerSessionRef}`);
  return { ref: created.providerSessionRef, hostedUrl: created.hostedUrl, txnId: held['txnId']!, orderId: held['orderId']!, spiToken: held['spiToken']! };
}

/** What the iframe posts back (sec. 2.2 1.6, Appendix 2), flattened as the return route flattens it. */
function authResult(page: { txnId: string; orderId: string; spiToken: string }, tds: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    TransactionType: '2', Approved: 'false', TransactionIdentifier: page.txnId, IsoResponseCode: String(tds['ResponseCode'] ?? '3D0'),
    OrderIdentifier: page.orderId, SpiToken: page.spiToken,
    RiskManagement: JSON.stringify({ ThreeDSecure: { Eci: '05', AuthenticationStatus: 'Y', ResponseCode: '3D0', ...tds } }),
    ...extra,
  } as Record<string, string>;
}

beforeAll(() => {
  redis = new Redis(process.env['REDIS_URL']!);
});

afterAll(async () => {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 500);
    cursor = next;
    const mine = keys.filter((k) => k.startsWith(PREFIX));
    if (mine.length) await redis.del(...mine);
  } while (cursor !== '0');
  await redis.quit();
});

describe('configuration (secrets named, never echoed)', () => {
  const base = {
    NODE_ENV: 'development',
    CARD_RAIL_ENVIRONMENT: 'sandbox', CARD_RAIL_ACCOUNT: 'swift-gy', POWERTRANZ_ID: 'TESTID01', POWERTRANZ_PASSWORD: 'p@ss-not-real',
    POWERTRANZ_PAGE_SET: 'PTZ/Swift', POWERTRANZ_PAGE_NAME: 'Weekly', API_PUBLIC_URL: 'https://api.example.test',
  };
  it('the sandbox defaults to the guide\'s staging root (sec. 2.1, 2.3)', () => {
    expect(powerTranzConfigFromEnv(base)).toMatchObject({ apiRoot: POWERTRANZ_SANDBOX_ROOT, environment: 'sandbox', pageSet: 'PTZ/Swift' });
  });
  it('live needs its own non-test root; production takes live only; every refusal names the setting, never a value', () => {
    const cases: Array<[Record<string, string | undefined>, RegExp]> = [
      [{ ...base, CARD_RAIL_ENVIRONMENT: 'live' }, /POWERTRANZ_API_URL is required/],
      [{ ...base, CARD_RAIL_ENVIRONMENT: 'live', POWERTRANZ_API_URL: 'https://staging.ptranz.com' }, /test system/],
      [{ ...base, POWERTRANZ_API_URL: 'https://gateway.example.com' }, /not a test system/],
      [{ ...base, NODE_ENV: 'production' }, /live/],
      [{ ...base, POWERTRANZ_API_URL: 'http://staging.ptranz.com' }, /https/],
      [{ ...base, POWERTRANZ_API_URL: 'https://staging.ptranz.com/api' }, /bare https/],
      [{ ...base, POWERTRANZ_ID: '' }, /POWERTRANZ_ID/],
      [{ ...base, POWERTRANZ_ID: 'X'.repeat(26) }, /POWERTRANZ_ID/],
      [{ ...base, POWERTRANZ_PASSWORD: '' }, /POWERTRANZ_PASSWORD/],
      [{ ...base, POWERTRANZ_GATEWAY_KEY: 'not-a-guid' }, /POWERTRANZ_GATEWAY_KEY/],
      [{ ...base, POWERTRANZ_PAGE_SET: '' }, /POWERTRANZ_PAGE_SET/],
      [{ ...base, API_PUBLIC_URL: 'http://api.example.test' }, /API_PUBLIC_URL/],
      [{ ...base, CARD_RAIL_ACCOUNT: 'has spaces' }, /CARD_RAIL_ACCOUNT/],
      [{ ...base, CARD_RAIL_ENVIRONMENT: undefined }, /CARD_RAIL_ENVIRONMENT/],
    ];
    for (const [env, message] of cases) {
      let thrown: unknown;
      try { powerTranzConfigFromEnv(env); } catch (err) { thrown = err; }
      expect(thrown, JSON.stringify(message)).toBeInstanceOf(PowerTranzConfigError);
      expect((thrown as Error).message).toMatch(message);
      expect((thrown as Error).message).not.toContain('p@ss-not-real');
    }
    expect(powerTranzConfigFromEnv({ ...base, NODE_ENV: 'production', CARD_RAIL_ENVIRONMENT: 'live', POWERTRANZ_API_URL: 'https://gateway.example.com' }))
      .toMatchObject({ environment: 'live', apiRoot: 'https://gateway.example.com' });
  });
});

describe('amounts and currencies (sec. 5.1 DEC 18,3; ISO 4217 numeric)', () => {
  it('minor units <-> TotalAmount, exactly, and nothing finer than the currency allows', () => {
    expect(totalAmountOf(210_000, 'GYD')).toBe(2100);
    expect(totalAmountOf(210_005, 'GYD')).toBe(2100.05);
    expect(minorOfTotalAmount(2100, 'GYD')).toBe(210_000);
    expect(minorOfTotalAmount('2100.050', 'GYD')).toBe(210_005);
    expect(minorOfTotalAmount('2100.005', 'GYD')).toBeNull();
    expect(minorOfTotalAmount(-1, 'GYD')).toBeNull();
    expect(minorOfTotalAmount('1e3', 'GYD')).toBeNull();
    expect(alphaOfCurrency('328')).toBe('GYD');
    expect(alphaOfCurrency(840)).toBe('USD');
    expect(alphaOfCurrency('978')).toBeNull();
  });
});

describe('createSession: the hosted payment page, preprocessed (sec. 2.2 1.3-1.4, 5.1, 7.2)', () => {
  it('POST <root>/api/spi/sale with the guide\'s headers and fields — 3-D Secure on, the hosted page named, NO card data', async () => {
    const gw = gateway({ '/api/spi/sale': preprocessed });
    const p = provider(gw);
    const page = await openPage(p);
    expect(page.hostedUrl).toBe(`https://api.example.test/api/v1/billing/card/pay/${page.ref}`);
    expect(gw.calls).toHaveLength(1);
    const call = gw.calls[0]!;
    expect(call.url).toBe('https://staging.ptranz.com/api/spi/sale');
    expect(call.method).toBe('POST');
    expect(call.headers['powertranz-powertranzid']).toBe('TESTID01');
    expect(call.headers['powertranz-powertranzpassword']).toBe('test-password-not-real');
    expect(call.headers).not.toHaveProperty('powertranz-gatewaykey'); // "Do not send until value is provided" (sec. 4)
    const body = JSON.parse(call.body!) as Record<string, unknown>;
    expect(body).toMatchObject({
      TotalAmount: 2100, CurrencyCode: '328', ThreeDSecure: true, Source: {}, OrderIdentifier: expect.stringMatching(/^SWIFT-cs_/),
      ExtendedData: { ThreeDSecure: { ChallengeWindowSize: 5, ChallengeIndicator: '01' }, MerchantResponseUrl: RETURN_URL, HostedPage: { PageSet: 'PTZ/SwiftTest', PageName: 'WeeklyFee' } },
    });
    expect(body['TransactionIdentifier']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(body)).not.toMatch(/CardPan|CardCvv|CardExpiration|\d{13,19}/);
  });

  it('sends PowerTranz-GatewayKey only once one is configured', async () => {
    const gw = gateway({ '/api/spi/sale': preprocessed });
    const issued = randomUUID(); // a synthetic GUID, made at run time
    await openPage(provider(gw, { config: { gatewayKey: issued } }));
    expect(gw.calls[0]!.headers['powertranz-gatewaykey']).toBe(issued);
  });

  it('anything but SP4 with RedirectData and SpiToken is no page — definitively (no money can follow, sec. 7.3)', async () => {
    const answers: Responder[] = [
      () => ({ status: 200, body: { Approved: false, IsoResponseCode: '12', ResponseMessage: 'Invalid transaction', Errors: [{ Code: '757', Message: 'Hosted page not found' }] } }),
      () => ({ status: 200, body: { IsoResponseCode: 'SP4', SpiToken: 'x' } }),
      () => ({ status: 200, body: { IsoResponseCode: 'SP4', RedirectData: '<form></form>' } }),
      (call) => ({ ...preprocessed(call), body: { ...(preprocessed(call).body), TransactionIdentifier: '00000000-0000-0000-0000-000000000000' } }),
      () => ({ status: 500, body: 'server error' }),
      () => 'network',
      () => 'timeout',
    ];
    for (const answer of answers) {
      const p = provider(gateway({ '/api/spi/sale': answer }));
      const created = await p.createSession({ binding: p.binding, sessionRef: 'cs_x', purpose: 'PAY_NOW', returnUrl: RETURN_URL, expiresAt: new Date(Date.now() + 60_000), amountMinor: 100, currencyCode: 'GYD' });
      expect(created.status).toBe('failed');
    }
  });

  it('no page, no call: an Add card session (the guide documents no saved-card charge), an unknown currency, a bad amount, a return address over 255', async () => {
    const gw = gateway({ '/api/spi/sale': preprocessed });
    const p = provider(gw);
    const ask = (o: Record<string, unknown>) => p.createSession({ binding: p.binding, sessionRef: 'cs_y', purpose: 'PAY_NOW', returnUrl: RETURN_URL, expiresAt: new Date(Date.now() + 60_000), amountMinor: 100, currencyCode: 'GYD', ...o });
    expect(await ask({ purpose: 'ENROLL', amountMinor: undefined, currencyCode: undefined })).toMatchObject({ status: 'failed', reason: 'SAVING_CARDS_NOT_OFFERED' });
    expect(await ask({ currencyCode: 'EUR' })).toMatchObject({ status: 'failed' });
    expect(await ask({ amountMinor: 0 })).toMatchObject({ status: 'failed' });
    expect(await ask({ returnUrl: `https://api.example.test/${'x'.repeat(260)}` })).toMatchObject({ status: 'failed', reason: 'RETURN_URL_INVALID' });
    expect(gw.calls).toHaveLength(0);
    expect(p.savesCards).toBe(false);
  });

  it('a binding that is not its own is refused before any call [C2]', async () => {
    const gw = gateway({ '/api/spi/sale': preprocessed });
    const p = provider(gw);
    await expect(p.createSession({ binding: { ...p.binding, account: 'other' }, sessionRef: 'cs', purpose: 'PAY_NOW', returnUrl: RETURN_URL, expiresAt: new Date(), amountMinor: 1, currencyCode: 'GYD' }))
      .rejects.toBeInstanceOf(CardBindingMismatchError);
    await expect(p.confirm({ binding: { ...p.binding, environment: 'live' }, providerSessionRef: 'ptz_x', purpose: 'PAY_NOW' })).rejects.toBeInstanceOf(CardBindingMismatchError);
    expect(gw.calls).toHaveLength(0);
  });
});

describe('the browser\'s 3-D Secure result decides only whether Swift completes (sec. 2.2 1.6-1.7, 8)', () => {
  const held = { spiToken: 'spi-1', txnId: '11111111-1111-1111-1111-111111111111', orderId: 'SWIFT-cs_1' };
  const result = (tds: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ SpiToken: 'spi-1', TransactionIdentifier: held.txnId, OrderIdentifier: held.orderId, IsoResponseCode: '3D0', RiskManagement: { ThreeDSecure: { ResponseCode: '3D0', ...tds } }, ...extra });
  it('proceeds on 3D0 with Y or A; declines N, R, U, 3D1, 3D3, a missing result, and a result naming another page', () => {
    expect(authenticationDecision(result({ AuthenticationStatus: 'Y' }), held).proceed).toBe(true);
    expect(authenticationDecision(result({ AuthenticationStatus: 'A' }), held).proceed).toBe(true);
    for (const status of ['N', 'R', 'U', undefined]) expect(authenticationDecision(result({ AuthenticationStatus: status }), held).proceed, String(status)).toBe(false);
    expect(authenticationDecision(result({ ResponseCode: '3D1', AuthenticationStatus: undefined }, { IsoResponseCode: '3D1' }), held).proceed).toBe(false);
    expect(authenticationDecision(result({ ResponseCode: '3D3', AuthenticationStatus: 'Y' }), held).proceed).toBe(false);
    expect(authenticationDecision(null, held).proceed).toBe(false);
    expect(authenticationDecision(result({ AuthenticationStatus: 'Y' }, { SpiToken: 'spi-OTHER' }), held)).toEqual({ proceed: false, note: 'OTHER_PAGE_TOKEN' });
    expect(authenticationDecision(result({ AuthenticationStatus: 'Y' }, { TransactionIdentifier: '22222222-2222-2222-2222-222222222222' }), held).proceed).toBe(false);
    expect(authenticationDecision(result({ AuthenticationStatus: 'Y' }, { OrderIdentifier: 'SWIFT-cs_2' }), held).proceed).toBe(false);
  });
  it('reads the result from top-level fields (nested objects as JSON text) or from one field holding the JSON', () => {
    const flat = { IsoResponseCode: '3D0', SpiToken: 'spi-1', RiskManagement: JSON.stringify({ ThreeDSecure: { ResponseCode: '3D0', AuthenticationStatus: 'Y' } }) };
    expect(authenticationDecision(authenticationResultOf(flat), held).proceed).toBe(true);
    const wrapped = { Response: JSON.stringify(result({ AuthenticationStatus: 'Y' })) };
    expect(authenticationDecision(authenticationResultOf(wrapped), held).proceed).toBe(true);
    expect(authenticationResultOf({ hello: 'world' })).toBeNull();
    expect(authenticationResultOf({ a: JSON.stringify({ SpiToken: 'x' }), b: JSON.stringify({ SpiToken: 'y' }) })).toBeNull();
  });
  it('parseReturn is an observation: pure, and its digest never holds the token or the cardholder\'s details in the clear', () => {
    const p = provider(gateway({}));
    const params = { IsoResponseCode: '3D0', SpiToken: 'spi-secret-token', BillingAddress: JSON.stringify({ EmailAddress: 'someone@example.test' }), RiskManagement: JSON.stringify({ ThreeDSecure: { ResponseCode: '3D0', AuthenticationStatus: 'Y' } }) };
    const observed = p.parseReturn(params);
    expect(observed.claimedStatus).toBe('pending');
    expect(observed.rawSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.parseReturn({ nothing: 'here' }).claimedStatus).toBe('invalid');
  });
});

describe('confirm: the completion is the money truth, sent at most once (sec. 2.2 1.7-1.8, 7.3)', () => {
  it('pending until the browser comes back; then ONE POST /api/spi/payment with the SpiToken as the body, no credential headers; approved 00 -> succeeded', async () => {
    let page!: Awaited<ReturnType<typeof openPage>>;
    const gw = gateway({ '/api/spi/sale': preprocessed, '/api/spi/payment': () => completion({})(page.txnId) });
    const p = provider(gw);
    page = await openPage(p);
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'pending' });
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, { AuthenticationStatus: 'Y' }) });
    const outcome = await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' });
    expect(outcome).toMatchObject({ status: 'succeeded', purpose: 'PAY_NOW', providerRef: page.txnId, amountMinor: 210_000, currencyCode: 'GYD' });
    const pay = gw.calls.filter((c) => c.url.endsWith('/api/spi/payment'));
    expect(pay).toHaveLength(1);
    expect(pay[0]!.body).toBe(JSON.stringify(page.spiToken));
    expect(pay[0]!.headers).not.toHaveProperty('powertranz-powertranzid');
    expect(pay[0]!.headers).not.toHaveProperty('powertranz-powertranzpassword');
    // Asked again (a reload, the sweep): the recorded answer, never a second completion.
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'succeeded', providerRef: page.txnId });
    expect(gw.calls.filter((c) => c.url.endsWith('/api/spi/payment'))).toHaveLength(1);
    // The token and the bank's form are gone from Swift once the page is done.
    expect(await redis.hmget(`${PREFIX}s:${page.ref}`, 'spiToken', 'redirectData')).toEqual([null, null]);
  });

  it('a failed bank check (N) is never completed: failed, nothing sent', async () => {
    const gw = gateway({ '/api/spi/sale': preprocessed, '/api/spi/payment': () => ({ status: 200, body: { Approved: true, IsoResponseCode: '00' } }) });
    const p = provider(gw);
    const page = await openPage(p);
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, { AuthenticationStatus: 'N' }) });
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'failed', reason: expect.stringMatching(/^NOT_AUTHENTICATED/) });
    expect(gw.paths()).not.toContain('/api/spi/payment');
  });

  it('a return naming another page (its SpiToken) is never completed', async () => {
    const gw = gateway({ '/api/spi/sale': preprocessed, '/api/spi/payment': () => ({ status: 200, body: { Approved: true, IsoResponseCode: '00' } }) });
    const p = provider(gw);
    const page = await openPage(p);
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult({ ...page, spiToken: 'spi-forged' }, { AuthenticationStatus: 'Y' }) });
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'failed' });
    expect(gw.paths()).not.toContain('/api/spi/payment');
  });

  it('the first return\'s decision stands: a later "Y" cannot turn a refused page into a completion', async () => {
    const gw = gateway({ '/api/spi/sale': preprocessed, '/api/spi/payment': () => ({ status: 200, body: { Approved: true, IsoResponseCode: '00' } }) });
    const p = provider(gw);
    const page = await openPage(p);
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, { AuthenticationStatus: 'R' }) });
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, { AuthenticationStatus: 'Y' }) });
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'failed' });
    expect(gw.paths()).not.toContain('/api/spi/payment');
  });

  it('a page never finished: pending inside its window, failed after it, nothing sent', async () => {
    let now = Date.now();
    const gw = gateway({ '/api/spi/sale': preprocessed });
    const p = provider(gw, { now: () => new Date(now) });
    const page = await openPage(p, { expiresAt: new Date(now + 60_000) });
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'pending' });
    now += 61_000;
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'failed', reason: 'PAGE_NOT_FINISHED' });
    // The browser arrives late: the page's fate is already decided.
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, { AuthenticationStatus: 'Y' }) });
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'failed' });
    expect(gw.paths()).not.toContain('/api/spi/payment');
  });

  it('the completion\'s answer lost (network, timeout, 5xx, unreadable): unknown, and NEVER sent a second time', async () => {
    for (const lost of [(): ReturnType<Responder> => 'network', (): ReturnType<Responder> => 'timeout', (): ReturnType<Responder> => ({ status: 503, body: 'down' }), (): ReturnType<Responder> => ({ status: 200, body: '<html>oops' })]) {
      const gw = gateway({ '/api/spi/sale': preprocessed, '/api/spi/payment': lost });
      const p = provider(gw);
      const page = await openPage(p);
      await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, { AuthenticationStatus: 'Y' }) });
      expect((await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).status).toBe('unknown');
      expect((await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).status).toBe('unknown');
      expect(gw.calls.filter((c) => c.url.endsWith('/api/spi/payment'))).toHaveLength(1);
    }
  });

  it('two confirmations racing: exactly one completion is sent', async () => {
    let page!: Awaited<ReturnType<typeof openPage>>;
    const gw = gateway({ '/api/spi/sale': preprocessed, '/api/spi/payment': () => completion({})(page.txnId) });
    const p = provider(gw);
    page = await openPage(p);
    await p.noteReturn({ binding: p.binding, providerSessionRef: page.ref, params: authResult(page, { AuthenticationStatus: 'Y' }) });
    const answers = await Promise.all(Array.from({ length: 5 }, () => p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })));
    expect(gw.calls.filter((c) => c.url.endsWith('/api/spi/payment'))).toHaveLength(1);
    expect(answers.filter((a) => a.status === 'succeeded').length + answers.filter((a) => a.status === 'unknown').length).toBe(5);
    expect(await p.confirm({ binding: p.binding, providerSessionRef: page.ref, purpose: 'PAY_NOW' })).toMatchObject({ status: 'succeeded' });
  });

  it('no record of the page (lost state): unknown, never success', async () => {
    const p = provider(gateway({}));
    expect(await p.confirm({ binding: p.binding, providerSessionRef: 'ptz_000000000000000000000000', purpose: 'PAY_NOW' })).toMatchObject({ status: 'unknown' });
    expect(await p.confirm({ binding: p.binding, providerSessionRef: 'ptz_000000000000000000000000', purpose: 'ENROLL' })).toMatchObject({ status: 'failed' });
  });
});

describe('reading the completion (sec. 6, Appendix 1): undocumented is unknown, never success', () => {
  const held = { txnId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
  const approved = { Approved: true, IsoResponseCode: '00', TransactionIdentifier: held.txnId, TotalAmount: 2100, CurrencyCode: '328', RiskManagement: { ThreeDSecure: { AuthenticationStatus: 'Y', Eci: '05' } } };
  it('approved 00, this transaction, readable amount: succeeded', () => {
    expect(readCompletion(approved, held)).toEqual({ status: 'succeeded', amountMinor: 210_000, currencyCode: 'GYD' });
    expect(readCompletion({ ...approved, TransactionIdentifier: undefined, OriginalTrxnIdentifier: held.txnId }, held).status).toBe('succeeded');
  });
  it('[3DS] approved 00 is booked only on PowerTranz\'s OWN 3-D Secure proof (sec. 6, 8.3, 8.4): Y or A, never N / U / R / absent / a failed ECI', () => {
    expect(readCompletion({ ...approved, RiskManagement: { ThreeDSecure: { AuthenticationStatus: 'A', Eci: '06' } } }, held).status).toBe('succeeded');
    expect(readCompletion({ ...approved, RiskManagement: { ThreeDSecure: { AuthenticationStatus: 'Y' } } }, held).status).toBe('succeeded');
    for (const tds of [{ AuthenticationStatus: 'N' }, { AuthenticationStatus: 'U' }, { AuthenticationStatus: 'R' }, {}, { AuthenticationStatus: 'Y', Eci: '07' }, { AuthenticationStatus: 'Y', Eci: '00' }]) {
      expect(readCompletion({ ...approved, RiskManagement: { ThreeDSecure: tds } }, held), JSON.stringify(tds)).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/^APPROVED_UNAUTHENTICATED_/) });
    }
    expect(readCompletion({ ...approved, RiskManagement: undefined }, held).status).toBe('unknown');
  });

  it('approved with any other code, naming another transaction, or with no readable amount or currency: unknown', () => {
    for (const iso of ['10', '11', '16', '32', '', undefined]) expect(readCompletion({ ...approved, IsoResponseCode: iso }, held).status, String(iso)).toBe('unknown');
    expect(readCompletion({ ...approved, TransactionIdentifier: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }, held).status).toBe('unknown');
    expect(readCompletion({ ...approved, CurrencyCode: '978' }, held).status).toBe('unknown');
    expect(readCompletion({ ...approved, TotalAmount: 'lots' }, held).status).toBe('unknown');
    expect(readCompletion({ ...approved, Approved: 'true' }, held).status).toBe('unknown');
    expect(readCompletion(null, held).status).toBe('unknown');
  });
  it('declined by the bank: failed; a possible duplicate (787, 788, 387) or a code that is not the bank\'s answer (09, 68, 91, 94, 96, 98, 99, 06): unknown', () => {
    for (const iso of ['05', '51', '54', '57', '12', '14', '82', 'N7', '97', '89']) {
      expect(readCompletion({ Approved: false, IsoResponseCode: iso }, held).status, iso).toBe('failed');
    }
    for (const code of ['787', '788', '387']) {
      expect(readCompletion({ Approved: false, IsoResponseCode: '12', Errors: [{ Code: code, Message: 'Duplicate' }] }, held).status, code).toBe('unknown');
    }
    for (const iso of ['09', '68', '91', '94', '96', '98', '99', '06']) {
      expect(readCompletion({ Approved: false, IsoResponseCode: iso }, held).status, iso).toBe('unknown');
    }
  });
});

describe('off-session: never attempted (sec. 7.8)', () => {
  it('chargeInstrument answers requires_action (no penalty) and retrieve answers absent — with no call at all', async () => {
    const gw = gateway({});
    const p = provider(gw);
    expect(await p.chargeInstrument({ binding: p.binding, vaultToken: 'tok', amountMinor: 1, currencyCode: 'GYD', idempotencyKey: 'k' })).toMatchObject({ status: 'requires_action' });
    expect(await p.retrieve({ binding: p.binding, idempotencyKey: 'k' })).toMatchObject({ status: 'unknown', absent: true });
    expect(gw.calls).toHaveLength(0);
  });
});

describe('refund and void (sec. 5.2, 7.5, 7.6): the original transaction, at most one call per key', () => {
  const original = 'cab173a7-f75e-444b-ac42-cc6a367b8b6b';
  it('refund: POST <root>/api/refund {Refund true, original TransactionIdentifier, TotalAmount, CurrencyCode}; approved 00 -> succeeded; the same key again is the recorded answer', async () => {
    const gw = gateway({ '/api/refund': () => ({ status: 200, body: { OriginalTrxnIdentifier: original, TransactionType: 5, Approved: true, TransactionIdentifier: '0446a902-311d-4868-8247-e9dfbd8ea0a6', TotalAmount: 2100, CurrencyCode: '328', IsoResponseCode: '00' } }) });
    const p = provider(gw);
    const key = `refund-${nanoid(6)}`;
    const first = await p.refund({ binding: p.binding, providerRef: original, amountMinor: 210_000, currencyCode: 'GYD', idempotencyKey: key });
    expect(first).toMatchObject({ status: 'succeeded', providerRef: '0446a902-311d-4868-8247-e9dfbd8ea0a6' });
    expect(JSON.parse(gw.calls[0]!.body!)).toEqual({ Refund: true, TransactionIdentifier: original, TotalAmount: 2100, CurrencyCode: '328' });
    expect(gw.calls[0]!.headers['powertranz-powertranzid']).toBe('TESTID01');
    expect(await p.refund({ binding: p.binding, providerRef: original, amountMinor: 210_000, currencyCode: 'GYD', idempotencyKey: key })).toEqual(first);
    expect(gw.calls).toHaveLength(1);
  });
  it('a refund whose answer was lost is unknown and is never sent again under its key; a refused one is failed', async () => {
    const lost = gateway({ '/api/refund': () => 'timeout' });
    const p = provider(lost);
    const key = `refund-${nanoid(6)}`;
    expect((await p.refund({ binding: p.binding, providerRef: original, amountMinor: 100, currencyCode: 'GYD', idempotencyKey: key })).status).toBe('unknown');
    expect((await p.refund({ binding: p.binding, providerRef: original, amountMinor: 100, currencyCode: 'GYD', idempotencyKey: key })).status).toBe('unknown');
    expect(lost.calls).toHaveLength(1);
    const refused = gateway({ '/api/refund': () => ({ status: 200, body: { Approved: false, IsoResponseCode: '12', Errors: [{ Code: '384', Message: 'Invalid refund' }] } }) });
    const q = provider(refused);
    expect(await q.refund({ binding: q.binding, providerRef: original, amountMinor: 100, currencyCode: 'GYD', idempotencyKey: `refund-${nanoid(6)}` })).toMatchObject({ status: 'failed' });
    expect(await q.refund({ binding: q.binding, providerRef: 'not-a-guid', amountMinor: 100, currencyCode: 'GYD', idempotencyKey: `refund-${nanoid(6)}` })).toMatchObject({ status: 'failed', reason: 'REFUND_REQUEST_INVALID' });
    expect(refused.calls).toHaveLength(1);
  });
  it('void: POST <root>/api/void with the original TransactionIdentifier only (no partial voids)', async () => {
    const gw = gateway({ '/api/void': () => ({ status: 200, body: { OriginalTrxnIdentifier: original, TransactionType: 4, Approved: true, TransactionIdentifier: original, IsoResponseCode: '00' } }) });
    const p = provider(gw);
    expect(await p.voidPayment({ binding: p.binding, providerRef: original, idempotencyKey: `void-${nanoid(6)}` })).toMatchObject({ status: 'succeeded' });
    expect(JSON.parse(gw.calls[0]!.body!)).toEqual({ TransactionIdentifier: original });
  });
});

describe('the owner\'s self-check: OK / FAIL lines only', () => {
  it('reachable, credentials accepted, hosted page set up — and never a value in the answer', async () => {
    const gw = gateway({
      '/api/alive': () => ({ status: 200, body: { ok: true } }),
      '/api/spi/riskmgmt': () => ({ status: 200, body: { Approved: false, IsoResponseCode: '97', Errors: [{ Code: '37', Message: 'Missing field(s)' }] } }),
      '/api/spi/sale': preprocessed,
    });
    const lines = await provider(gw).selfCheck({ preprocess: true, returnUrl: RETURN_URL });
    expect(lines).toEqual([{ check: 'gateway reachable', ok: true }, { check: 'credentials accepted', ok: true }, { check: 'hosted payment page set up', ok: true }]);
    expect(gw.paths()).not.toContain('/api/spi/payment'); // a self-check never completes anything
  });
  it('invalid credentials (Appendix 1: 89 / 312) or an unreachable gateway: FAIL', async () => {
    const gw = gateway({
      '/api/alive': () => 'network',
      '/api/spi/riskmgmt': () => ({ status: 200, body: { Approved: false, IsoResponseCode: '89', Errors: [{ Code: '312', Message: 'Invalid credentials' }] } }),
      '/api/spi/sale': () => ({ status: 200, body: { Approved: false, IsoResponseCode: '12', Errors: [{ Code: '757' }] } }),
    });
    const lines = await provider(gw).selfCheck({ preprocess: true, returnUrl: RETURN_URL });
    expect(lines.map((l) => l.ok)).toEqual([false, false, false]);
    expect(JSON.stringify(lines)).not.toContain('test-password-not-real');
  });
});

describe('the card-save consent (owner sign-off, 7 Oct 2026)', () => {
  it('version card-on-file-v1 is exactly the approved words: a new wording is a new version, never a silent edit', () => {
    expect(CARD_ON_FILE_CONSENT_VERSION).toBe('card-on-file-v1');
    expect(CARD_ON_FILE_CONSENT_TEXT).toBe('Swift will charge the card you add for your weekly fee each week, when it is due, until you remove it. Your bank may ask you to confirm a charge. You can remove the card here at any time.');
    expect(createHash('sha256').update(CARD_ON_FILE_CONSENT_TEXT).digest('hex')).toBe(CARD_ON_FILE_CONSENT_SHA256);
  });
});
