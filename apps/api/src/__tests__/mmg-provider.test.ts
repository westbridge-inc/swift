import { describe, it, expect, vi } from 'vitest';
import { SandboxMmgProvider, LiveMmgProvider, getMmgProvider, MMG_UAT_URL, type LiveMmgConfig } from '../providers/mmg/mmg-provider';

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
      .mockResolvedValueOnce(jsonRes(200, { amount: '500', currency: 'GYD', transactionStatus: 'successful', transactionReference: '20373216965979', creationDate: '2025-11-01T22:52:21.253Z' }));
    const mmg = new LiveMmgProvider(CFG, fetchMock as any);
    const tx = await mmg.transactionLookup({ transactionId: '20373216965979' });
    expect(tx.status).toBe('approved');
    expect(tx.amountMinor).toBe(50000);
    expect(tx.transactionId).toBe('20373216965979');
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
