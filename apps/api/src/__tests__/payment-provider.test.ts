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

const CHARGE = { token: 'tok_live_123', amount: 12000, currencyCode: 'GYD', idempotencyKey: 'prov:sub1:2026-06-17:a0' };

describe('getPaymentProvider', () => {
  afterEach(() => {
    delete process.env['PAYMENT_PROVIDER'];
    delete process.env['PAYMENT_GATEWAY_KEY'];
    delete process.env['PAYMENT_GATEWAY_SECRET'];
    vi.unstubAllGlobals();
  });

  it('defaults to sandbox', () => {
    expect(getPaymentProvider()).toBeInstanceOf(SandboxPaymentProvider);
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

describe('SandboxPaymentProvider', () => {
  it('declines tokens containing "fail", succeeds otherwise', async () => {
    const p: PaymentProvider = new SandboxPaymentProvider();
    expect((await p.chargeToken({ token: 'tok_fail_x', amount: 1, currencyCode: 'GYD', idempotencyKey: 'k' })).status).toBe('failed');
    expect((await p.chargeToken({ token: 'tok_ok', amount: 1, currencyCode: 'GYD', idempotencyKey: 'k' })).status).toBe('succeeded');
  });
});

describe('PowerTranzPaymentProvider', () => {
  const p = new PowerTranzPaymentProvider('id', 'pass');
  afterEach(() => vi.unstubAllGlobals());

  it('charges a stored token — approved becomes succeeded with the txn ref', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { Approved: true, TransactionIdentifier: 'txn_1' }));
    expect(await p.chargeToken(CHARGE)).toEqual({ status: 'succeeded', providerRef: 'txn_1' });
  });

  it('maps a declined sale to failed with the gateway reason', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { Approved: false, TransactionIdentifier: 'txn_2', ResponseMessage: 'Insufficient funds' }));
    const r = await p.chargeToken(CHARGE);
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('Insufficient funds');
  });

  it('never throws on a transport error — soft failure so billing can retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    const r = await p.chargeToken(CHARGE);
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(/unreachable/i);
  });

  it('treats a non-OK HTTP status as a soft failure', async () => {
    vi.stubGlobal('fetch', mockFetch(502, 'bad gateway'));
    const r = await p.chargeToken(CHARGE);
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(/HTTP 502/);
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
  });

  it('maps a decline to failed with Stripe’s reason', async () => {
    vi.stubGlobal('fetch', mockFetch(402, {
      error: { message: 'Your card was declined.', decline_code: 'insufficient_funds' },
    }));
    const r = await p.chargeToken(CHARGE);
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('insufficient_funds');
  });

  it('treats requires_action (3-DS challenge on a recurring charge) as failed', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { id: 'pi_2', status: 'requires_action' }));
    const r = await p.chargeToken(CHARGE);
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('requires_action');
  });

  it('never throws on a transport error — soft failure so billing can retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ETIMEDOUT'); }));
    const r = await p.chargeToken(CHARGE);
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(/unreachable/i);
  });

  it('refunds by payment intent in minor units', async () => {
    const f = mockFetch(200, { id: 're_1', status: 'succeeded' });
    vi.stubGlobal('fetch', f);
    const r = await p.refund({ providerRef: 'pi_1', amount: 500, idempotencyKey: 'ref:1' });
    expect(r).toEqual({ status: 'succeeded', providerRef: 're_1' });
    const [url, init] = f.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toContain('/v1/refunds');
    const body = new URLSearchParams(init.body);
    expect(body.get('payment_intent')).toBe('pi_1');
    expect(body.get('amount')).toBe('50000');
  });

  it('does not tokenize raw PAN server-side (SetupIntent flow only)', async () => {
    await expect(
      p.tokenizeCard({ userId: 'u', cardNumber: '4242424242424242', expMonth: 1, expYear: 2030, cvc: '123' }),
    ).rejects.toThrow(/client-side|server-side/i);
  });
});
