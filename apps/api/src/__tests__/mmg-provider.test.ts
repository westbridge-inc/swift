import { describe, it, expect, vi } from 'vitest';
import { SandboxMmgProvider, LiveMmgProvider, getMmgProvider, historyAnswerFrom, historyRowFrom, lookupDetailFrom, MMG_REFERENCE_WIRE_CONTRACT, MMG_UAT_URL, type LiveMmgConfig } from '../providers/mmg/mmg-provider';

// MMG Merchant-Initiated sandbox: exercises the whole loop (initiate → the
// payer approves on their phone → lookup) deterministically, so billing/agent
// code can be built + tested before a live MMG account exists.
describe('MMG sandbox provider — merchant-initiated loop', () => {
  const mmg = new SandboxMmgProvider();

  it('authenticates', async () => {
    const { token } = await mmg.authenticate();
    expect(token).toMatch(/^mmg_sandbox_/);
  });

  it('initiate → pending, then lookup → approved', async () => {
    const init = await mmg.initiatePayment({ payerId: '+5926000000', amountMinor: 130000, currencyCode: 'GYD', reference: 'order-123' });
    expect(init.status).toBe('pending');
    expect(init.transactionId).toBeTruthy();
    const look = await mmg.transactionLookup({ transactionId: init.transactionId });
    expect(look.status).toBe('approved');
    expect(look).toMatchObject({ amountMinor: 130000, currencyCode: 'GYD', reference: 'order-123' });
  });

  it('a reference marked "pending" stays pending on lookup', async () => {
    const init = await mmg.initiatePayment({ payerId: 'x', amountMinor: 100, currencyCode: 'GYD', reference: 'weekly-pending-1' });
    const look = await mmg.transactionLookup({ transactionId: init.transactionId });
    expect(look.status).toBe('pending');
  });

  it('a reference marked "decline" is declined at initiate', async () => {
    const init = await mmg.initiatePayment({ payerId: 'x', amountMinor: 100, currencyCode: 'GYD', reference: 'decline-me' });
    expect(init.status).toBe('declined');
    expect(init.transactionId).toBe('');
  });

  it('reverse, balance and history behave', async () => {
    const rev = await mmg.reverseTransaction({ transactionId: 'mmgtx_approved_abc' });
    expect(rev.status).toBe('reversed');
    expect((await mmg.accountBalance()).currencyCode).toBe('GYD');
    expect(await mmg.transactionHistory()).toEqual([]);
  });

  it('the factory returns the sandbox by default', () => {
    const prev = process.env['MMG_DRIVER'];
    delete process.env['MMG_DRIVER'];
    expect(getMmgProvider()).toBeInstanceOf(SandboxMmgProvider);
    if (prev !== undefined) process.env['MMG_DRIVER'] = prev;
  });

  it('the factory never permits the sandbox in production', () => {
    const previousNodeEnv = process.env['NODE_ENV'];
    const previousDriver = process.env['MMG_DRIVER'];
    process.env['NODE_ENV'] = 'production';
    delete process.env['MMG_DRIVER'];
    try {
      expect(() => getMmgProvider()).toThrow(/sandbox.*forbidden/i);
    } finally {
      if (previousNodeEnv === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previousNodeEnv;
      if (previousDriver === undefined) delete process.env['MMG_DRIVER'];
      else process.env['MMG_DRIVER'] = previousDriver;
    }
  });

  it('the factory refuses a half-configured live driver, naming the gaps', () => {
    const prev = { ...process.env };
    process.env['MMG_DRIVER'] = 'live';
    process.env['MMG_API_KEY'] = 'k';
    delete process.env['MMG_MERCHANT_ID'];
    delete process.env['MMG_PASSWORD'];
    delete process.env['MMG_MKEY'];
    delete process.env['MMG_MSECRET'];
    expect(() => getMmgProvider()).toThrow(/missing: merchantMsisdn, password, mkey, msecret/);
    process.env = prev;
  });

  it('the live factory is fail-closed until the exact reference round-trip is UAT-verified', () => {
    const prev = { ...process.env };
    Object.assign(process.env, {
      MMG_DRIVER: 'live', MMG_API_KEY: 'k', MMG_MERCHANT_ID: '9991161', MMG_PASSWORD: 'p',
      MMG_MKEY: 'mk', MMG_MSECRET: 'ms',
    });
    delete process.env['MMG_REFERENCE_ROUNDTRIP_VERIFIED'];
    try {
      expect(() => getMmgProvider()).toThrow(/MMG_REFERENCE_ROUNDTRIP_VERIFIED/);
      process.env['MMG_REFERENCE_ROUNDTRIP_VERIFIED'] = '1';
      expect(getMmgProvider()).toBeInstanceOf(LiveMmgProvider);
    } finally {
      process.env = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// Live adapter — wire format per https://mmg.gy/developer/openapi.yaml, fetch
// injected so no network is touched. Money paths must NEVER throw.
// ---------------------------------------------------------------------------

const CFG: LiveMmgConfig = {
  baseUrl: MMG_UAT_URL,
  apiKey: 'api-key-1',
  merchantMsisdn: '9991161',
  password: 'pw',
  mkey: 'mkey-1',
  msecret: 'msecret-1',
};

const AUTH_OK = { ok: true, status: 200, json: async () => ({ token_type: 'Bearer', access_token: 'tok_1', expires_in: 120 }) };

function jsonRes(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe('MMG live adapter — merchant-initiated wire format', () => {
  it('exports the exact asymmetric reference contract that sandbox UAT must prove', () => {
    expect(MMG_REFERENCE_WIRE_CONTRACT).toEqual({
      outbound: { carrier: 'header', field: 'x-wss-correlationid' },
      lookup: { carrier: 'json', field: 'metadata[].description' },
      history: { carrier: 'json', field: 'TransactionList[].external_id' },
      activationEnv: 'MMG_REFERENCE_ROUNDTRIP_VERIFIED',
    });
  });

  it('authenticates form-encoded against /e-commerce-login/mer and caches the 120s token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(AUTH_OK);
    const mmg = new LiveMmgProvider(CFG, fetchMock as any);

    const { token } = await mmg.authenticate();
    expect(token).toBe('tok_1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${MMG_UAT_URL}/e-commerce-login/mer`);
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(init.body);
    expect(form.get('grant_type')).toBe('password');
    expect(form.get('api_key')).toBe('api-key-1');
    expect(form.get('username')).toBe('9991161');
    expect(form.get('password')).toBe('pw');

    // Within TTL a second transactional call re-uses the token: balance right
    // after auth issues exactly ONE more fetch (no second login).
    fetchMock.mockResolvedValueOnce(jsonRes(200, { accounts: [{ accountBalance: { availableBalance: '4500', currency: 'GYD' } }] }));
    await mmg.accountBalance();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('initiate sends the documented body + x-wss headers and maps pending', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(AUTH_OK)
      .mockResolvedValueOnce(
        jsonRes(200, { status: 'pending', pendingReason: 'approvalrequired', notificationMethod: 'polling', executionId: '20373216452995', expiryTime: '2026-01-01T00:00:00Z' }),
      );
    const mmg = new LiveMmgProvider(CFG, fetchMock as any);

    const res = await mmg.initiatePayment({ payerId: '6983238', amountMinor: 130050, currencyCode: 'GYD', reference: 'sub-week-29' });
    expect(res).toEqual({ status: 'pending', transactionId: '20373216452995', reason: 'approvalrequired' });

    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe(`${MMG_UAT_URL}/e-merchant-initiated-transactions/payment?merchant_msisdn=9991161`);
    expect(init.headers['x-wss-token']).toBe('tok_1');
    expect(init.headers['x-wss-mid']).toBe('9991161');
    expect(init.headers['x-wss-mkey']).toBe('mkey-1');
    expect(init.headers['x-api-key']).toBe('api-key-1');
    expect(init.headers['x-wss-msecret']).toBe('msecret-1');
    expect(init.headers['x-wss-correlationid']).toBe('sub-week-29'); // idempotent retries carry the same id
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      amount: '1300.50', // minor→major string conversion
      currency: 'GYD',
      subType: 'merinipmt',
      type: 'transfer',
      debitParty: [{ key: 'accountid', value: '6983238' }],
      creditParty: [{ key: 'accountid', value: '9991161' }],
    });
  });

  it.each([
    ['missing', { status: 'successful' }],
    ['empty', { status: 'successful', executionId: '' }],
    ['whitespace', { status: 'successful', executionId: '   ' }],
    ['object', { status: 'successful', executionId: { bad: 'shape' } }],
  ])('R5 approved initiate with %s reference exposes no usable transaction id', async (_label, body) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(AUTH_OK).mockResolvedValueOnce(jsonRes(200, body));
    const mmg = new LiveMmgProvider(CFG, fetchMock as any);
    const result = await mmg.initiatePayment({ payerId: '6983238', amountMinor: 210000, currencyCode: 'GYD', reference: 'sub-week-29' });
    expect(result.status).toBe('approved');
    expect(result.transactionId).toBe('');
  });

  it('R5 uses a valid objectReference when executionId is unusable', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(AUTH_OK).mockResolvedValueOnce(jsonRes(200, {
      status: 'successful', executionId: '', objectReference: '20373216452995',
    }));
    const mmg = new LiveMmgProvider(CFG, fetchMock as any);
    expect(await mmg.initiatePayment({ payerId: '6983238', amountMinor: 210000, currencyCode: 'GYD', reference: 'sub-week-29' }))
      .toMatchObject({ status: 'approved', transactionId: '20373216452995' });
  });

  it('initiate maps a 422 business rejection to declined with MMG\'s message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(AUTH_OK)
      .mockResolvedValueOnce(jsonRes(422, { transactionId: '203', statusCode: '102', message: 'INVALID_CREDENTIALS' }));
    const mmg = new LiveMmgProvider(CFG, fetchMock as any);
    const res = await mmg.initiatePayment({ payerId: 'x', amountMinor: 100, currencyCode: 'GYD', reference: 'r1' });
    expect(res.status).toBe('declined');
    expect(res.reason).toBe('INVALID_CREDENTIALS');
  });

  it('initiate NEVER throws — transport failure resolves to an error result', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const mmg = new LiveMmgProvider(CFG, fetchMock as any);
    const res = await mmg.initiatePayment({ payerId: 'x', amountMinor: 100, currencyCode: 'GYD', reference: 'r2' });
    expect(res.status).toBe('error');
    expect(res.reason).toContain('ECONNREFUSED');
  });

  it('lookup maps successful → approved and major-string amounts → minor ints', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(AUTH_OK)
      .mockResolvedValueOnce(jsonRes(200, {
        amount: '500', currency: 'GYD', transactionStatus: 'successful', transactionReference: '20373216965979',
        metadata: [{ key: 'description', value: 'sub-week-29' }], creationDate: '2025-11-01T22:52:21.253Z',
      }));
    const mmg = new LiveMmgProvider(CFG, fetchMock as any);
    const tx = await mmg.transactionLookup({ transactionId: '20373216965979' });
    expect(tx.status).toBe('approved');
    expect(tx.amountMinor).toBe(50000);
    expect(tx.transactionId).toBe('20373216965979');
    expect(tx.reference).toBe('sub-week-29');
  });

  it.each([
    ['currency', { amount: '500', transactionStatus: 'successful', transactionReference: '20373216965979', metadata: [{ key: 'description', value: 'sub-week-29' }] }, 'currencyCode'],
    ['transaction reference', { amount: '500', currency: 'GYD', transactionStatus: 'successful', metadata: [{ key: 'description', value: 'sub-week-29' }] }, 'transactionId'],
  ] as const)('does not manufacture omitted lookup %s as settlement evidence', async (_label, body, field) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(AUTH_OK)
      .mockResolvedValueOnce(jsonRes(200, body));
    const mmg = new LiveMmgProvider(CFG, fetchMock as any);

    const tx = await mmg.transactionLookup({ transactionId: '20373216965979' });

    expect(tx.status).toBe('approved');
    expect(tx[field]).toBe('');
  });

  it('an unknown lookup status stays pending (a poller must never guess approval)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(AUTH_OK)
      .mockResolvedValueOnce(jsonRes(200, { amount: '500', transactionStatus: 'inprogress_weird', transactionReference: 't1' }));
    const mmg = new LiveMmgProvider(CFG, fetchMock as any);
    expect((await mmg.transactionLookup({ transactionId: 't1' })).status).toBe('pending');
  });

  it('reversal 200/pending reports in-flight; 422 duplicate resolves to error (no throw)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(AUTH_OK)
      .mockResolvedValueOnce(jsonRes(200, { transactionStatus: 'pending', type: 'reversal', transactionReference: 'rev-1' }))
      .mockResolvedValueOnce(jsonRes(422, { statusCode: '184', message: 'REVERSAL_FAIL_DUPLICATE' }));
    const mmg = new LiveMmgProvider(CFG, fetchMock as any);

    const first = await mmg.reverseTransaction({ transactionId: 'tx-9' });
    expect(first).toEqual({ status: 'pending', transactionId: 'rev-1' });

    const dup = await mmg.reverseTransaction({ transactionId: 'tx-9' });
    expect(dup.status).toBe('error');
    expect(dup.reason).toBe('REVERSAL_FAIL_DUPLICATE');
  });

  it('history maps TransactionList rows (external_id → reference)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(AUTH_OK)
      .mockResolvedValueOnce(
        jsonRes(200, {
          executionId: 'e1',
          TransactionList: [
            { amount: '500', currency: 'GYD', transactionStatus: 'completed', transactionReference: 'tr-1', external_id: '11203023', modificationDate: '2025-11-01T18:02:16.000Z' },
          ],
        }),
      );
    const mmg = new LiveMmgProvider(CFG, fetchMock as any);
    const list = await mmg.transactionHistory({ limit: 5 });
    expect(list).toEqual([
      { transactionId: 'tr-1', status: 'approved', amountMinor: 50000, currencyCode: 'GYD', reference: '11203023', createdAt: '2025-11-01T18:02:16.000Z' },
    ]);
  });

  it('balance reads the wallet\'s availableBalance', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(AUTH_OK)
      .mockResolvedValueOnce(jsonRes(200, { accounts: [{ accountcategoryName: 'Normal Wallet', accountBalance: { availableBalance: '4500', currency: 'GYD', status: 'available' } }] }));
    const mmg = new LiveMmgProvider(CFG, fetchMock as any);
    expect(await mmg.accountBalance()).toEqual({ currencyCode: 'GYD', balanceMinor: 450000 });
  });
});

// [owner, 1 Oct] The checkout verifier's lookup, read exactly as MMG's UAT
// answered it (evidence/mmg-uat/ROUNDTRIP-PROOF-20261001.md): the checkout
// transactionId is looked up; MMG answers with its own ledger number in
// transactionReference, a status word, a whole-dollar amount string, the
// currency, a creationDate, the parties as [{ key: "accountid", value }] and
// metadata whose description is empty.
describe('MMG live adapter — the checkout lookup as MMG UAT answers it', () => {
  const UAT_ANSWER = {
    transactionStatus: 'successful', amount: '500', currency: 'GYD', creationDate: '2026-10-01T15:39:36.526Z',
    subType: 'subscriber_mpay', transactionReference: '20402048601581',
    creditParty: [{ key: 'accountid', value: '9991161' }], debitParty: [{ key: 'accountid', value: '6000002' }],
    metadata: [{ key: 'amount', value: '500' }, { key: 'merchant', value: 'Swift' }, { key: 'description', value: '' }],
    descriptionText: null,
  };

  it('reads every field the verifier needs, exactly as sent, from an HTTP 200 answer', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(AUTH_OK).mockResolvedValueOnce(jsonRes(200, UAT_ANSWER));
    const mmg = new LiveMmgProvider(CFG, fetchMock as any);
    const detail = await mmg.transactionLookupDetail('20402048536279');
    expect(fetchMock.mock.calls[1]![0]).toBe(`${MMG_UAT_URL}/e-merchant-initiated-transactions/lookup?transactionId=20402048536279`);
    expect(detail).toEqual({
      outcome: 'found', transactionId: '20402048601581', status: 'approved', statusText: 'successful',
      amountMinor: 50000, currencyCode: 'GYD', creditParties: ['9991161'], creditAccounts: ['9991161'],
      createdAt: '2026-10-01T15:39:36.526Z', ledgerReference: '20402048601581', echoedReferences: [], raw: UAT_ANSWER,
    });
    expect(lookupDetailFrom(UAT_ANSWER, '20402048536279')).toEqual(detail);
  });

  it('only an "accountid" party names the account the money went to', () => {
    const detail = lookupDetailFrom({ ...UAT_ANSWER, creditParty: [{ key: 'msisdn', value: '9991161' }, { key: 'accountid', value: '6000009' }, 'x', null] }, 'T1');
    expect(detail.creditParties).toEqual(['9991161', '6000009']);
    expect(detail.creditAccounts).toEqual(['6000009']);
    expect(lookupDetailFrom({ ...UAT_ANSWER, creditParty: undefined }, 'T1').creditAccounts).toBeNull();
    expect(lookupDetailFrom({ ...UAT_ANSWER, transactionReference: 20402048601581 }, 'T1')).toMatchObject({ ledgerReference: null, transactionId: 'T1' });
    expect(lookupDetailFrom({ ...UAT_ANSWER, transactionStatus: 'completed' }, 'T1')).toMatchObject({ status: 'approved', statusText: 'completed' });
  });

  it('[DS632] an "accountid" party with an empty or missing value is kept, never dropped: the verifier then holds the payment', () => {
    for (const blank of [{ key: 'accountid', value: '' }, { key: 'accountid' }, { key: 'accountid', value: null }]) {
      const detail = lookupDetailFrom({ ...UAT_ANSWER, creditParty: [blank, { key: 'accountid', value: '9991161' }] }, 'T1');
      expect(detail.creditAccounts, JSON.stringify(blank)).toEqual(['', '9991161']);
    }
    expect(lookupDetailFrom({ ...UAT_ANSWER, creditParty: [{ key: 'accountid' }] }, 'T1').creditAccounts).toEqual(['']);
  });

  it.each([201, 202, 204])('an HTTP %s answer is not an answer: an error to retry, never evidence', async (status) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(AUTH_OK).mockResolvedValueOnce(jsonRes(status, UAT_ANSWER));
    const mmg = new LiveMmgProvider(CFG, fetchMock as any);
    expect(await mmg.transactionLookupDetail('20402048536279')).toEqual({ outcome: 'error', reason: `MMG lookup HTTP ${status}` });
  });

  it.each([400, 404, 422])('HTTP %s means MMG does not know the transaction', async (status) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(AUTH_OK).mockResolvedValueOnce(jsonRes(status, { error: 'x' }));
    const mmg = new LiveMmgProvider(CFG, fetchMock as any);
    expect(await mmg.transactionLookupDetail('20402048536279')).toEqual({ outcome: 'not_found' });
  });
});

// ---------------------------------------------------------------------------
// [7 Oct] MMG's Transaction History, read for the checkout's payment time.
// MMG (7 Oct): the lookup's creationDate is the moment of the LOOKUP; history's
// modificationDate is when the transaction was performed. The shapes below are
// MMG UAT's own answers to Swift's merchant credentials on 7 Oct (field names,
// types and formats from the read-only probe; party values and external_id are
// placeholders: the probe printed only their keys).
// ---------------------------------------------------------------------------
describe('MMG live adapter — Transaction History for the checkout payment time (UAT, 7 Oct)', () => {
  /** The 1 Oct payment's row, as MMG UAT listed it on 7 Oct. */
  const UAT_ROW = {
    amount: '500', currency: 'GYD', displayType: 'EMerchant Payment', transactionStatus: 'completed', descriptionText: '',
    modificationDate: '2026-10-01T15:38:31.000Z', transactionReference: '20402048536279', transactionReceipt: '20402048536279',
    debitParty: [{ key: 'accountid', value: 'P-DEBIT' }, { key: 'accountcategory', value: 'P-CAT' }],
    creditParty: [{ key: 'accountid', value: 'P-CREDIT' }, { key: 'accountcategory', value: 'P-CAT' }],
    external_id: '1790883499',
  };
  /** Another UAT row of the same day, a payment that is not ours. */
  const OTHER_ROW = { ...UAT_ROW, modificationDate: '2026-10-01T15:38:15.000Z', transactionReference: '20402048536111', transactionReceipt: '20402048536111' };
  const UAT_ANSWER = { executionId: 'EXEC-1', TransactionList: [OTHER_ROW, UAT_ROW] };
  const QUERY = { fromdate: '2026-10-01T15:26:19.000Z', todate: '2026-10-01T15:51:05.000Z', rows: 100 };

  it('asks GET txn-history for the merchant with exactly the dates and row count it is given, with the x-wss headers the lookup carries', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(AUTH_OK).mockResolvedValueOnce(jsonRes(200, UAT_ANSWER));
    const mmg = new LiveMmgProvider(CFG, fetchMock as any);
    expect(await mmg.transactionHistoryRows(QUERY)).toEqual({ outcome: 'rows', rows: [OTHER_ROW, UAT_ROW] });
    const [url, init] = fetchMock.mock.calls[1]!;
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(`${MMG_UAT_URL}/e-merchant-initiated-transactions/txn-history`);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ msisdn: '9991161', offset: '100', fromdate: QUERY.fromdate, todate: QUERY.todate });
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({ 'x-wss-token': 'tok_1', 'x-wss-mid': '9991161', 'x-wss-mkey': CFG.mkey, 'x-api-key': CFG.apiKey, 'x-wss-msecret': CFG.msecret });
    expect(String(init.headers['x-wss-correlationid'])).toMatch(/^hist-/);
  });

  it('never throws: MMG unreachable, or any answer other than HTTP 200 with a TransactionList of objects, is an error to retry, never evidence', async () => {
    const down = vi.fn().mockResolvedValueOnce(AUTH_OK).mockRejectedValueOnce(new Error('socket hang up'));
    expect(await new LiveMmgProvider(CFG, down as any).transactionHistoryRows(QUERY)).toEqual({ outcome: 'error', reason: 'MMG history unreachable: socket hang up' });
    // What MMG UAT answered on 7 Oct to a date with no time (422) and to a query without both dates (400).
    const invalidDates = { transactionId: 'X', requestId: 'R', timestamp: 'T', statusCode: 422, message: 'Invalid dates', response: null };
    const problem = { type: 'about:blank', title: 'Bad Request', status: 400, detail: '', instance: '/x', properties: null };
    for (const [status, body] of [[422, invalidDates], [400, problem], [500, {}], [201, UAT_ANSWER]] as const) {
      const fetchMock = vi.fn().mockResolvedValueOnce(AUTH_OK).mockResolvedValueOnce(jsonRes(status, body));
      expect(await new LiveMmgProvider(CFG, fetchMock as any).transactionHistoryRows(QUERY)).toEqual({ outcome: 'error', reason: `MMG history HTTP ${status}` });
    }
    const notJson = vi.fn().mockResolvedValueOnce(AUTH_OK).mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } });
    expect(await new LiveMmgProvider(CFG, notJson as any).transactionHistoryRows(QUERY)).toMatchObject({ outcome: 'error' });
  });

  it.each(['history', 'authentication'])('bounds a stalled %s body and returns an error so the poll can continue', async (phase) => {
    vi.useFakeTimers();
    try {
      let stalledSignal: AbortSignal | null | undefined;
      const fetchMock = vi.fn(async (url: string, init?: Parameters<typeof fetch>[1]) => {
        const isAuth = url.includes('/e-commerce-login/mer');
        if (isAuth && phase === 'history') return AUTH_OK;
        stalledSignal = init?.signal;
        return { ok: true, status: 200, json: () => new Promise(() => {}) };
      });
      let result: unknown = 'pending';
      void new LiveMmgProvider(CFG, fetchMock as any).transactionHistoryRows(QUERY).then((answer) => { result = answer; });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(result).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toMatchObject({ outcome: 'error' });
      expect(stalledSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads the answer whole: a missing or non-list TransactionList, or any row that is not an object, is an error, never a shorter list', () => {
    expect(historyAnswerFrom(200, UAT_ANSWER)).toEqual({ outcome: 'rows', rows: [OTHER_ROW, UAT_ROW] });
    expect(historyAnswerFrom(200, { executionId: 'E', TransactionList: [] })).toEqual({ outcome: 'rows', rows: [] });
    for (const body of [null, [], 'x', { executionId: 'E' }, { TransactionList: {} }, { TransactionList: [UAT_ROW, null] }, { TransactionList: [UAT_ROW, 'x'] }, { TransactionList: [[UAT_ROW]] }]) {
      expect(historyAnswerFrom(200, body), JSON.stringify(body)).toMatchObject({ outcome: 'error' });
    }
  });

  it('reads one row exactly as sent: strings stay strings, the amount in exact minor units, anything unreadable null', () => {
    expect(historyRowFrom(UAT_ROW)).toEqual({
      transactionReference: '20402048536279', transactionReceipt: '20402048536279', statusText: 'completed',
      externalId: '1790883499', amountMinor: 50000, currencyCode: 'GYD', modificationDate: '2026-10-01T15:38:31.000Z',
    });
    expect(historyRowFrom({ ...UAT_ROW, amount: '500.00' }).amountMinor).toBe(50000);
    for (const external_id of [undefined, null, 1790883499, {}, []]) {
      expect(historyRowFrom({ ...UAT_ROW, external_id }).externalId).toBeNull();
    }
    expect(historyRowFrom({ transactionReference: 20402048536279, transactionReceipt: null, transactionStatus: 7, amount: 'five hundred', currency: 1, modificationDate: 1727811511000 }))
      .toEqual({ transactionReference: null, transactionReceipt: null, externalId: null, statusText: null, amountMinor: null, currencyCode: null, modificationDate: null });
  });

  it('the sandbox has no history for the checkout: it never answers "successful", so it is never asked', async () => {
    expect(await new SandboxMmgProvider().transactionHistoryRows(QUERY)).toEqual({ outcome: 'rows', rows: [] });
  });
});
