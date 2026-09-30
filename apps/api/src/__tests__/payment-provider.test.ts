import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SandboxPaymentProvider,
  PowerTranzPaymentProvider,
  StripePaymentProvider,
  getPaymentProvider,
  type PaymentProvider,
} from '../providers/payment/payment-provider';

/** Minimal fetch stub matching only what the provider reads (res.ok / res.json). */
function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

function mockMalformedJsonFetch(status: number) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => { throw new SyntaxError('Unexpected token'); },
  }));
}

const CHARGE = { token: 'tok_live_123', amount: 12000, currencyCode: 'GYD', idempotencyKey: 'prov:sub1:2026-06-17:a0' };

describe('getPaymentProvider', () => {
  afterEach(() => {
    delete process.env['PAYMENT_PROVIDER'];
    delete process.env['PAYMENT_GATEWAY_KEY'];
    delete process.env['PAYMENT_GATEWAY_SECRET'];
    delete process.env['POWERTRANZ_API_URL'];
    delete process.env['STRIPE_SECRET_KEY'];
    vi.unstubAllGlobals();
  });

  it('defaults to sandbox', () => {
    expect(getPaymentProvider()).toBeInstanceOf(SandboxPaymentProvider);
  });

  it('never permits the sandbox factory in production', () => {
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      delete process.env['PAYMENT_PROVIDER'];
      expect(() => getPaymentProvider()).toThrow(/sandbox.*forbidden/i);
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
  });

  it('throws on an unknown provider', () => {
    process.env['PAYMENT_PROVIDER'] = 'nope';
    expect(() => getPaymentProvider()).toThrow(/Unknown PAYMENT_PROVIDER/);
  });

  it('requires credentials when PAYMENT_PROVIDER=powertranz', () => {
    process.env['PAYMENT_PROVIDER'] = 'powertranz';
    expect(() => getPaymentProvider()).toThrow(/PAYMENT_GATEWAY_KEY/);
  });

  it('builds a StripePaymentProvider when configured (founder decision: billing target)', () => {
    process.env['PAYMENT_PROVIDER'] = 'stripe';
    expect(() => getPaymentProvider()).toThrow(/STRIPE_SECRET_KEY/);
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_x';
    expect(getPaymentProvider()).toBeInstanceOf(StripePaymentProvider);
    delete process.env['STRIPE_SECRET_KEY'];
  });

  it('builds a PowerTranzPaymentProvider when configured', () => {
    process.env['PAYMENT_PROVIDER'] = 'powertranz';
    process.env['PAYMENT_GATEWAY_KEY'] = 'pt-id';
    process.env['PAYMENT_GATEWAY_SECRET'] = 'pt-pass';
    expect(getPaymentProvider()).toBeInstanceOf(PowerTranzPaymentProvider);
  });
});

describe('explicitly disabled card provider', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('refuses enrollment, charge and refund with a typed code without contacting a provider', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAYMENT_PROVIDER', 'disabled');
    vi.stubEnv('CARD_RAIL_KILL', '1');
    const fetch = vi.fn(() => { throw new Error('Unexpected provider contact'); });
    vi.stubGlobal('fetch', fetch);
    const provider = getPaymentProvider();
    await expect(provider.tokenizeCard({ userId: 'synthetic', cardNumber: 'synthetic', expMonth: 1, expYear: 2030, cvc: 'synthetic' }))
      .rejects.toMatchObject({ statusCode: 503, code: 'CARD_RAIL_DISABLED' });
    await expect(provider.chargeToken(CHARGE)).resolves.toMatchObject({ status: 'failed', providerRef: '', code: 'CARD_RAIL_DISABLED' });
    await expect(provider.refund({ providerRef: 'synthetic', amount: 1, currencyCode: 'GYD', idempotencyKey: 'disabled-refund' }))
      .resolves.toMatchObject({ status: 'failed', providerRef: '', code: 'CARD_RAIL_DISABLED' });
    // Disabled is no evidence about an earlier charge: never fabricate a decline
    // or a not-found that could let billing reissue or expire an uncertain intent.
    await expect(provider.lookupCharge({ idempotencyKey: 'earlier-charge' }))
      .resolves.toMatchObject({ status: 'unknown', code: 'CARD_RAIL_DISABLED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '0', 'true'])('factory refuses disabled cards without the kill switch (%s)', (kill) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAYMENT_PROVIDER', 'disabled');
    vi.stubEnv('CARD_RAIL_KILL', kill);
    expect(() => getPaymentProvider()).toThrow(/CARD_RAIL_KILL/);
  });
});

describe('SandboxPaymentProvider', () => {
  it('declines tokens containing "fail", succeeds otherwise', async () => {
    const p: PaymentProvider = new SandboxPaymentProvider();
    expect((await p.chargeToken({ token: 'tok_fail_x', amount: 1, currencyCode: 'GYD', idempotencyKey: 'k-fail' })).status).toBe('failed');
    expect((await p.chargeToken({ token: 'tok_ok', amount: 1, currencyCode: 'GYD', idempotencyKey: 'k-ok' })).status).toBe('succeeded');
    // [M-01] Like a real processor: the same key answers the same result, and the lookup reads it back.
    const first = await p.chargeToken({ token: 'tok_ok', amount: 1, currencyCode: 'GYD', idempotencyKey: 'k-same' });
    expect(await p.chargeToken({ token: 'tok_ok', amount: 1, currencyCode: 'GYD', idempotencyKey: 'k-same' })).toEqual(first);
    expect(await p.lookupCharge({ idempotencyKey: 'k-same' })).toEqual({ status: 'succeeded', providerRef: first.providerRef, reason: undefined });
    expect(await p.lookupCharge({ idempotencyKey: 'k-never' })).toEqual({ status: 'not_found' });
  });
});

describe('PowerTranzPaymentProvider', () => {
  const p = new PowerTranzPaymentProvider('id', 'pass');
  afterEach(() => vi.unstubAllGlobals());

  it('charges a stored token — approved becomes succeeded with the txn ref', async () => {
    const f = mockFetch(200, { Approved: true, TransactionIdentifier: 'txn_1' });
    vi.stubGlobal('fetch', f);
    expect(await p.chargeToken(CHARGE)).toEqual({ status: 'succeeded', providerRef: 'txn_1' });

    const [url, init] = f.mock.calls[0] as unknown as [string, {
      method: string;
      headers: Record<string, string>;
      body: string;
    }];
    expect(url).toContain('/api/spi/Sale');
    expect(init.method).toBe('POST');
    expect(init.headers['PowerTranz-PowerTranzId']).toBe('id');
    expect(init.headers['PowerTranz-PowerTranzPassword']).toBe('pass');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      TotalAmount: CHARGE.amount,
      CurrencyCode: '328',
      ThreeDSecure: false,
      Source: CHARGE.token,
      OrderIdentifier: CHARGE.idempotencyKey,
    });
    expect(body['TransactionIdentifier']).toEqual(expect.any(String));
    expect(body).not.toHaveProperty('cardNumber');
    expect(body).not.toHaveProperty('cvc');
  });

  it('does not call an approval successful without a canonical transaction identifier', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { Approved: true }));
    expect(await p.chargeToken(CHARGE)).toMatchObject({ status: 'unknown', providerRef: '' });

    vi.stubGlobal('fetch', mockFetch(200, { Approved: true, TransactionIdentifier: '   ' }));
    expect(await p.chargeToken(CHARGE)).toMatchObject({ status: 'unknown', providerRef: '' });

    vi.stubGlobal('fetch', mockFetch(200, { Approved: true, TransactionIdentifier: 123 }));
    expect(await p.chargeToken(CHARGE)).toMatchObject({ status: 'unknown', providerRef: '' });
  });

  it('requires Approved to be the boolean true, not a truthy lookalike', async () => {
    for (const Approved of ['true', 1, {}, []]) {
      vi.stubGlobal('fetch', mockFetch(200, { Approved, TransactionIdentifier: 'txn_lookalike' }));
      await expect(p.chargeToken(CHARGE)).resolves.toMatchObject({
        status: 'unknown',
        providerRef: 'txn_lookalike',
      });
    }
  });

  it('requires a non-empty string transaction identifier for an approved refund', async () => {
    for (const TransactionIdentifier of [undefined, '', '   ', 123]) {
      vi.stubGlobal('fetch', mockFetch(200, { Approved: true, TransactionIdentifier }));
      await expect(p.refund({
        providerRef: 'sale_txn_1',
        amount: 500,
        currencyCode: 'GYD',
        idempotencyKey: `refund:missing-id:${String(TransactionIdentifier)}`,
      })).resolves.toMatchObject({ status: 'unknown', providerRef: '' });
    }
  });

  it('maps a declined sale to failed with the gateway reason', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { Approved: false, TransactionIdentifier: 'txn_2', ResponseMessage: 'Insufficient funds' }));
    const r = await p.chargeToken(CHARGE);
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('Insufficient funds');
  });

  it('never throws on a transport error — [M-02] UNKNOWN, not a decline: billing retrieves before it retries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    const r = await p.chargeToken(CHARGE);
    expect(r.status).toBe('unknown');
    expect(r.reason).toMatch(/unreachable/i);
  });

  it('treats 408, 429, and 5xx as UNKNOWN while preserving a definitive 4xx refusal', async () => {
    vi.stubGlobal('fetch', mockFetch(502, 'bad gateway'));
    const r = await p.chargeToken(CHARGE);
    expect(r.status).toBe('unknown');
    expect(r.reason).toMatch(/HTTP 502/);

    vi.stubGlobal('fetch', mockFetch(408, 'request timeout'));
    expect((await p.chargeToken(CHARGE)).status).toBe('unknown');

    vi.stubGlobal('fetch', mockFetch(429, 'rate limited'));
    expect((await p.chargeToken(CHARGE)).status).toBe('unknown');

    vi.stubGlobal('fetch', mockFetch(401, 'unauthorized'));
    expect((await p.chargeToken(CHARGE)).status).toBe('failed');
  });

  it('refunds by original transaction reference without sending card data', async () => {
    const f = mockFetch(200, { Approved: true, TransactionIdentifier: 'refund_txn_1' });
    vi.stubGlobal('fetch', f);
    const r = await p.refund({
      providerRef: 'sale_txn_1',
      amount: 500,
      currencyCode: 'GYD',
      idempotencyKey: 'refund:1',
    });
    expect(r).toEqual({ status: 'succeeded', providerRef: 'refund_txn_1' });

    const [url, init] = f.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toContain('/api/spi/Refund');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      OriginalTransactionIdentifier: 'sale_txn_1',
      TotalAmount: 500,
      OrderIdentifier: 'refund:1',
    });
    expect(body).not.toHaveProperty('Source');
    expect(body).not.toHaveProperty('cardNumber');
    expect(body).not.toHaveProperty('cvc');
  });

  it('fails an unsupported currency without calling the gateway', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const r = await p.chargeToken({ ...CHARGE, currencyCode: 'ZZZ' });
    expect(r.status).toBe('failed');
    expect(f).not.toHaveBeenCalled();
  });

  it('does not tokenize raw PAN server-side (hosted flow only)', async () => {
    await expect(
      p.tokenizeCard({ userId: 'u', cardNumber: '4111111111111111', expMonth: 1, expYear: 2030, cvc: '123' }),
    ).rejects.toThrow(/client-side|hosted|server-side/i);
  });
});

describe('StripePaymentProvider', () => {
  const p = new StripePaymentProvider('sk_test_key');
  afterEach(() => vi.unstubAllGlobals());

  it('charges off-session in MINOR units with the native idempotency key', async () => {
    const f = mockFetch(200, { id: 'pi_1', status: 'succeeded' });
    vi.stubGlobal('fetch', f);
    const r = await p.chargeToken(CHARGE);
    expect(r).toEqual({ status: 'succeeded', providerRef: 'pi_1' });

    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toContain('/v1/payment_intents');
    expect(init.headers['idempotency-key']).toBe(CHARGE.idempotencyKey);
    expect(init.headers['authorization']).toBe('Bearer sk_test_key');
    const body = new URLSearchParams(init.body);
    expect(body.get('amount')).toBe('1200000'); // 12,000.00 GYD → minor units
    expect(body.get('currency')).toBe('gyd');
    expect(body.get('payment_method')).toBe(CHARGE.token);
    expect(body.get('off_session')).toBe('true');
    expect(body.get('confirm')).toBe('true');
    expect(body.has('card_number')).toBe(false);
    expect(body.has('cvc')).toBe(false);
  });

  it('maps a decline to failed with Stripe’s reason', async () => {
    vi.stubGlobal('fetch', mockFetch(402, {
      error: { message: 'Your card was declined.', decline_code: 'insufficient_funds' },
    }));
    const r = await p.chargeToken(CHARGE);
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('insufficient_funds');
  });

  it('treats an HTTP 5xx charge response as UNKNOWN rather than a decline', async () => {
    vi.stubGlobal('fetch', mockFetch(503, { error: { message: 'temporarily unavailable' } }));
    const r = await p.chargeToken(CHARGE);
    expect(r.status).toBe('unknown');
    expect(r.reason).toMatch(/HTTP 503/);
  });

  it('treats HTTP 408 and 429 charge responses as ambiguous UNKNOWN even with decline-shaped JSON', async () => {
    for (const status of [408, 429]) {
      vi.stubGlobal('fetch', mockFetch(status, {
        error: { message: 'request not completed', decline_code: 'do_not_honor' },
      }));
      await expect(p.chargeToken(CHARGE)).resolves.toMatchObject({
        status: 'unknown',
        reason: `Gateway HTTP ${status}`,
      });
    }
  });

  it('never throws on null or malformed Stripe charge JSON and returns UNKNOWN', async () => {
    vi.stubGlobal('fetch', mockFetch(200, null));
    await expect(p.chargeToken(CHARGE)).resolves.toMatchObject({ status: 'unknown', providerRef: '' });

    vi.stubGlobal('fetch', mockMalformedJsonFetch(200));
    await expect(p.chargeToken(CHARGE)).resolves.toMatchObject({ status: 'unknown', providerRef: '' });
  });

  it('does not call a Stripe charge successful without a non-empty canonical id', async () => {
    for (const id of [undefined, '', '   ', 123]) {
      vi.stubGlobal('fetch', mockFetch(200, { id, status: 'succeeded' }));
      await expect(p.chargeToken(CHARGE)).resolves.toMatchObject({ status: 'unknown', providerRef: '' });
    }
  });

  it('treats nonterminal and unrecognized charge states as UNKNOWN', async () => {
    for (const status of ['requires_action', 'processing', 'requires_capture', 'provider_added_state']) {
      vi.stubGlobal('fetch', mockFetch(200, { id: 'pi_nonterminal', status }));
      await expect(p.chargeToken(CHARGE)).resolves.toMatchObject({
        status: 'unknown',
        providerRef: 'pi_nonterminal',
      });
    }
  });

  it('preserves only proven terminal charge failures', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { id: 'pi_2', status: 'requires_action' }));
    expect((await p.chargeToken(CHARGE)).status).toBe('unknown');

    vi.stubGlobal('fetch', mockFetch(200, { id: 'pi_3', status: 'requires_payment_method' }));
    expect(await p.chargeToken(CHARGE)).toMatchObject({
      status: 'failed',
      providerRef: 'pi_3',
      reason: 'requires_payment_method',
    });

    vi.stubGlobal('fetch', mockFetch(200, { id: 'pi_4', status: 'canceled' }));
    expect(await p.chargeToken(CHARGE)).toMatchObject({
      status: 'failed',
      providerRef: 'pi_4',
      reason: 'canceled',
    });
  });

  it('treats an HTTP 409 idempotency conflict as UNKNOWN, not a decline', async () => {
    vi.stubGlobal('fetch', mockFetch(409, {
      error: {
        code: 'idempotency_key_in_use',
        message: 'Another request with this key is still processing',
      },
    }));
    await expect(p.chargeToken(CHARGE)).resolves.toMatchObject({
      status: 'unknown',
      providerRef: '',
      reason: 'Gateway HTTP 409',
    });
  });

  it('never accepts a charge success body from an unsuccessful HTTP response', async () => {
    vi.stubGlobal('fetch', mockFetch(400, { id: 'pi_false_success', status: 'succeeded' }));
    await expect(p.chargeToken(CHARGE)).resolves.toMatchObject({
      status: 'unknown',
      providerRef: 'pi_false_success',
    });
  });

  it('never throws on a transport error — [M-02] UNKNOWN, not a decline: billing retrieves before it retries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ETIMEDOUT'); }));
    const r = await p.chargeToken(CHARGE);
    expect(r.status).toBe('unknown');
    expect(r.reason).toMatch(/unreachable/i);
  });

  it('refunds by payment intent in minor units', async () => {
    const f = mockFetch(200, { id: 're_1', status: 'succeeded' });
    vi.stubGlobal('fetch', f);
    const r = await p.refund({ providerRef: 'pi_1', amount: 500, currencyCode: 'GYD', idempotencyKey: 'ref:1' });
    expect(r).toEqual({ status: 'succeeded', providerRef: 're_1' });
    const [url, init] = f.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toContain('/v1/refunds');
    const body = new URLSearchParams(init.body);
    expect(body.get('payment_intent')).toBe('pi_1');
    expect(body.get('amount')).toBe('50000');
    expect(body.has('card_number')).toBe(false);
    expect(body.has('cvc')).toBe(false);
  });

  it('treats Stripe refund transport and HTTP 5xx outcomes as UNKNOWN', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    expect(await p.refund({
      providerRef: 'pi_1',
      amount: 500,
      currencyCode: 'GYD',
      idempotencyKey: 'ref:transport',
    })).toMatchObject({ status: 'unknown', providerRef: '' });

    vi.stubGlobal('fetch', mockFetch(502, { error: { message: 'bad gateway' } }));
    const response = await p.refund({
      providerRef: 'pi_1',
      amount: 500,
      currencyCode: 'GYD',
      idempotencyKey: 'ref:http-502',
    });
    expect(response.status).toBe('unknown');
    expect(response.reason).toMatch(/HTTP 502/);

    vi.stubGlobal('fetch', mockFetch(400, { error: { message: 'invalid refund request' } }));
    expect((await p.refund({
      providerRef: 'pi_1',
      amount: 500,
      currencyCode: 'GYD',
      idempotencyKey: 'ref:http-400',
    })).status).toBe('failed');
  });

  it('treats HTTP 408 and 429 refund responses as ambiguous UNKNOWN even with failure-shaped JSON', async () => {
    for (const status of [408, 429]) {
      vi.stubGlobal('fetch', mockFetch(status, {
        id: 're_ambiguous',
        status: 'failed',
        error: { message: 'request not completed' },
      }));
      await expect(p.refund({
        providerRef: 'pi_1',
        amount: 500,
        currencyCode: 'GYD',
        idempotencyKey: `ref:http-${status}`,
      })).resolves.toMatchObject({
        status: 'unknown',
        providerRef: 're_ambiguous',
        reason: `Gateway HTTP ${status}`,
      });
    }
  });

  it('treats an HTTP 409 refund idempotency conflict as UNKNOWN, not a failure', async () => {
    vi.stubGlobal('fetch', mockFetch(409, {
      error: {
        code: 'idempotency_key_in_use',
        message: 'Another refund with this key is still processing',
      },
    }));
    await expect(p.refund({
      providerRef: 'pi_1',
      amount: 500,
      currencyCode: 'GYD',
      idempotencyKey: 'ref:http-409',
    })).resolves.toMatchObject({
      status: 'unknown',
      providerRef: '',
      reason: 'Gateway HTTP 409',
    });
  });

  it('never accepts a refund success body from an unsuccessful HTTP response', async () => {
    vi.stubGlobal('fetch', mockFetch(400, { id: 're_false_success', status: 'succeeded' }));
    await expect(p.refund({
      providerRef: 'pi_1',
      amount: 500,
      currencyCode: 'GYD',
      idempotencyKey: 'ref:false-success',
    })).resolves.toMatchObject({
      status: 'unknown',
      providerRef: 're_false_success',
    });
  });

  it('treats pending and unrecognized refund states as UNKNOWN', async () => {
    for (const status of ['pending', 'requires_action', 'provider_added_state']) {
      vi.stubGlobal('fetch', mockFetch(200, { id: 're_nonterminal', status }));
      await expect(p.refund({
        providerRef: 'pi_1',
        amount: 500,
        currencyCode: 'GYD',
        idempotencyKey: `ref:nonterminal:${status}`,
      })).resolves.toMatchObject({
        status: 'unknown',
        providerRef: 're_nonterminal',
      });
    }
  });

  it('never throws on null or malformed Stripe refund JSON and returns UNKNOWN', async () => {
    vi.stubGlobal('fetch', mockFetch(200, null));
    await expect(p.refund({
      providerRef: 'pi_1',
      amount: 500,
      currencyCode: 'GYD',
      idempotencyKey: 'ref:null-json',
    })).resolves.toMatchObject({ status: 'unknown', providerRef: '' });

    vi.stubGlobal('fetch', mockMalformedJsonFetch(200));
    await expect(p.refund({
      providerRef: 'pi_1',
      amount: 500,
      currencyCode: 'GYD',
      idempotencyKey: 'ref:malformed-json',
    })).resolves.toMatchObject({ status: 'unknown', providerRef: '' });
  });

  it('does not call a Stripe refund successful without a non-empty canonical id', async () => {
    for (const status of ['succeeded', 'pending']) {
      for (const id of [undefined, '', '   ', 123]) {
        vi.stubGlobal('fetch', mockFetch(200, { id, status }));
        await expect(p.refund({
          providerRef: 'pi_1',
          amount: 500,
          currencyCode: 'GYD',
          idempotencyKey: `ref:missing-id:${status}:${String(id)}`,
        })).resolves.toMatchObject({ status: 'unknown', providerRef: '' });
      }
    }
  });

  it('does not tokenize raw PAN server-side (SetupIntent flow only)', async () => {
    await expect(
      p.tokenizeCard({ userId: 'u', cardNumber: '4242424242424242', expMonth: 1, expYear: 2030, cvc: '123' }),
    ).rejects.toThrow(/client-side|server-side/i);
  });
});
