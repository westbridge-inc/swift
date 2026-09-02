import { toProviderMinor } from '../../utils/currency-amount';
import { nanoid } from 'nanoid';
import { randomUUID } from 'node:crypto';
import { isProduction } from '../../utils/runtime-mode';

// ---------------------------------------------------------------------------
// PaymentProvider — hard rule 4: swappable interface. Nothing outside this
// module may know which processor exists. V1 only ever charges Swift's OWN
// subscription fee — order money is never processed (hard rule 2).
// ---------------------------------------------------------------------------

export interface ChargeResult {
  /** [M-02] 'unknown' = the instruction MAY have reached the processor (a
   *  timeout, a transport error, a 5xx): neither a capture nor a decline.
   *  Billing never duns on it and never issues a new instruction over it —
   *  it retrieves the truth by the same key first. */
  status: 'succeeded' | 'failed' | 'unknown';
  /** Provider-side charge reference */
  providerRef: string;
  reason?: string;
}

/** [M-01] The provider's truth about an instruction we sent, by our key. */
export interface ChargeLookup {
  status: 'succeeded' | 'failed' | 'not_found' | 'unknown';
  providerRef?: string;
  reason?: string;
}

export interface PaymentProvider {
  /** Exchange raw card data for a reusable token. Raw PAN is never stored. */
  tokenizeCard(input: {
    userId: string;
    cardNumber: string;
    expMonth: number;
    expYear: number;
    cvc: string;
  }): Promise<{ token: string }>;

  /** Charge a stored token. idempotencyKey must make retries safe provider-side. */
  chargeToken(input: {
    token: string;
    amount: number;
    currencyCode: string;
    idempotencyKey: string;
    description?: string;
  }): Promise<ChargeResult>;

  /** [M-36] A refund names its currency: the adapter scales by the registry exponent, never a bare × 100. */
  refund(input: { providerRef: string; amount: number; currencyCode: string; idempotencyKey: string }): Promise<ChargeResult>;
  /** [M-01] Retrieve the truth of an instruction by our idempotency key (and
   *  the provider's own id when known) BEFORE any retry. 'not_found' means the
   *  processor never received it; 'unknown' means the processor cannot say. */
  lookupCharge(input: { idempotencyKey: string; providerRef?: string }): Promise<ChargeLookup>;
}

/**
 * Sandbox adapter. Deterministic markers for tests:
 * a token containing "fail" always declines; everything else succeeds.
 */
export class SandboxPaymentProvider implements PaymentProvider {
  /** [M-01] What a real processor does with an idempotency key: the same key
   *  answers the same result and captures once. The lookup reads it back. */
  private readonly charges = new Map<string, ChargeResult>();

  async tokenizeCard(input: { userId: string; cardNumber: string }): Promise<{ token: string }> {
    // Card numbers ending 0002 produce an always-declining token (Stripe-style)
    const marker = input.cardNumber.endsWith('0002') ? 'fail_' : '';
    return { token: `tok_${marker}${nanoid(12)}` };
  }

  async chargeToken(input: { token: string; idempotencyKey: string }): Promise<ChargeResult> {
    const seen = this.charges.get(input.idempotencyKey);
    if (seen) return seen;
    const result: ChargeResult = input.token.includes('fail')
      ? { status: 'failed', providerRef: `ch_${nanoid(10)}`, reason: 'Card declined (sandbox)' }
      : { status: 'succeeded', providerRef: `ch_${nanoid(10)}` };
    this.charges.set(input.idempotencyKey, result);
    return result;
  }

  async refund(_input: { providerRef: string; amount: number; currencyCode: string; idempotencyKey: string }): Promise<ChargeResult> {
    return { status: 'succeeded', providerRef: `re_${nanoid(10)}` };
  }

  async lookupCharge(input: { idempotencyKey: string; providerRef?: string }): Promise<ChargeLookup> {
    const seen = this.charges.get(input.idempotencyKey);
    if (!seen) return { status: 'not_found' };
    return { status: seen.status === 'succeeded' ? 'succeeded' : 'failed', providerRef: seen.providerRef, reason: seen.reason };
  }
}

// PowerTranz / First Atlantic Commerce — the spec's primary subscription
// billing rail. Caribbean acquirer.
const POWERTRANZ_TIMEOUT_MS = 15000;
// ISO 4217 numeric codes PowerTranz expects (alpha -> numeric). Guyana first,
// then the Caribbean expansion set.
const CURRENCY_NUMERIC: Record<string, string> = {
  GYD: '328',
  USD: '840',
  TTD: '780',
  JMD: '388',
  BBD: '052',
  XCD: '951',
};

interface PowerTranzResponse {
  Approved?: boolean;
  TransactionIdentifier?: string;
  IsoResponseCode?: string;
  ResponseMessage?: string;
  Errors?: Array<{ Message?: string }>;
}

/**
 * PowerTranz/FAC adapter. Only `chargeToken` is on the billing hot path
 * (recurring weekly fees on a stored card token), so — exactly like the
 * sandbox — it NEVER throws: transport errors, timeouts, non-OK responses and
 * declines all resolve to a ChargeResult, leaving the billing retry/suspend
 * logic in control (a transient gateway outage becomes a soft `failed`, which
 * the daily retry cycle absorbs before the 3-strike suspend).
 *
 * Card capture/tokenization is done through PowerTranz's hosted SPI/3-DS flow
 * (PCI) — raw PAN never touches our servers — so tokenizeCard is unsupported
 * here; the client stores the resulting token on the subscription.
 */
export class PowerTranzPaymentProvider implements PaymentProvider {
  constructor(
    private powerTranzId: string,
    private password: string,
    private baseUrl: string = process.env['POWERTRANZ_API_URL'] ?? 'https://staging.ptranz.com',
  ) {}

  async tokenizeCard(_input: {
    userId: string;
    cardNumber: string;
    expMonth: number;
    expYear: number;
    cvc: string;
  }): Promise<{ token: string }> {
    throw new Error(
      'PowerTranz tokenization is client-side (hosted SPI flow); raw PAN is never tokenized server-side',
    );
  }

  async chargeToken(input: {
    token: string;
    amount: number;
    currencyCode: string;
    idempotencyKey: string;
    description?: string;
  }): Promise<ChargeResult> {
    const currency = CURRENCY_NUMERIC[input.currencyCode.toUpperCase()];
    if (!currency) {
      return { status: 'failed', providerRef: '', reason: `Unsupported currency ${input.currencyCode}` };
    }

    // Merchant-initiated sale against a stored token; no 3-DS on recurring.
    return this.post('/api/spi/Sale', {
      TransactionIdentifier: randomUUID(),
      TotalAmount: Number(input.amount.toFixed(2)),
      CurrencyCode: currency,
      ThreeDSecure: false,
      Source: input.token,
      OrderIdentifier: input.idempotencyKey,
    });
  }

  async refund(input: { providerRef: string; amount: number; currencyCode: string; idempotencyKey: string }): Promise<ChargeResult> {
    return this.post('/api/spi/Refund', {
      TransactionIdentifier: randomUUID(),
      OriginalTransactionIdentifier: input.providerRef,
      TotalAmount: Number(input.amount.toFixed(2)),
      OrderIdentifier: input.idempotencyKey,
    });
  }

  /** Single POST + parse. Never throws — every outcome maps to a ChargeResult. */
  private async post(path: string, body: Record<string, unknown>): Promise<ChargeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POWERTRANZ_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'PowerTranz-PowerTranzId': this.powerTranzId,
          'PowerTranz-PowerTranzPassword': this.password,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // [M-02] A 5xx is ambiguous — the sale MAY have been processed; a 4xx
        // was refused before processing.
        return { status: res.status >= 500 ? 'unknown' : 'failed', providerRef: '', reason: `Gateway HTTP ${res.status}` };
      }
      const data = (await res.json()) as PowerTranzResponse;
      if (data.Approved) {
        return { status: 'succeeded', providerRef: data.TransactionIdentifier ?? '' };
      }
      const reason = data.ResponseMessage ?? data.Errors?.[0]?.Message ?? data.IsoResponseCode ?? 'Declined';
      return { status: 'failed', providerRef: data.TransactionIdentifier ?? '', reason };
    } catch {
      // [M-02] Unreachable / timed out — UNKNOWN, never a decline: the sale
      // may have gone through. Billing retrieves before it ever retries.
      return { status: 'unknown', providerRef: '', reason: 'Gateway unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** [M-01] PowerTranz exposes no query by merchant reference in this
   *  integration: an ambiguous sale stays UNKNOWN until reconciled against the
   *  acquirer statement by a person. Saying so is safer than guessing. */
  async lookupCharge(_input: { idempotencyKey: string; providerRef?: string }): Promise<ChargeLookup> {
    return { status: 'unknown', reason: 'PowerTranz: no query by merchant reference — reconcile against the acquirer statement' };
  }
}

// Stripe (via the Delaware LLC) — founder decision 2026-07-02: the billing
// target when card subscriptions go live (card billing itself is post-V1).
// PowerTranz stays available as the regional alternate behind the same seam.
const STRIPE_TIMEOUT_MS = 15000;

interface StripeErrorBody {
  error?: { message?: string; code?: string; decline_code?: string };
}
interface StripePaymentIntent extends StripeErrorBody {
  id?: string;
  status?: string; // 'succeeded' | 'requires_action' | 'requires_payment_method' | …
}
interface StripeRefund extends StripeErrorBody {
  id?: string;
  status?: string; // 'succeeded' | 'pending' | 'failed'
}

/**
 * Stripe adapter. Same contract as the others: `chargeToken` NEVER throws —
 * declines, gateway errors and timeouts all resolve to a soft `failed` that
 * the billing retry/3-strike-suspend cycle absorbs.
 *
 * Card capture is client-side (Stripe.js / mobile SDK → SetupIntent →
 * PaymentMethod attached to a Customer); raw PAN never touches our servers,
 * so tokenizeCard is unsupported here. The stored token is the PaymentMethod
 * id, charged off-session with Stripe's native Idempotency-Key.
 */
export class StripePaymentProvider implements PaymentProvider {
  constructor(
    private secretKey: string,
    private baseUrl: string = process.env['STRIPE_API_URL'] ?? 'https://api.stripe.com',
  ) {}

  async tokenizeCard(_input: {
    userId: string;
    cardNumber: string;
    expMonth: number;
    expYear: number;
    cvc: string;
  }): Promise<{ token: string }> {
    throw new Error(
      'Stripe tokenization is client-side (Stripe.js/SDK SetupIntent flow); raw PAN is never tokenized server-side',
    );
  }

  async chargeToken(input: {
    token: string;
    amount: number;
    currencyCode: string;
    idempotencyKey: string;
    description?: string;
  }): Promise<ChargeResult> {
    // Stripe amounts are MINOR units. [M-36] The exponent comes from the
    // currency registry — the ONLY place a major amount becomes minor — and
    // a major amount that already looks minor-scaled is refused, not sent 100× too large.
    const body = new URLSearchParams({
      amount: String(toProviderMinor(input.amount, input.currencyCode, 'stripe.charge')),
      currency: input.currencyCode.toLowerCase(),
      payment_method: input.token,
      confirm: 'true',
      off_session: 'true', // merchant-initiated recurring — no 3-DS challenge
      ...(input.description ? { description: input.description } : {}),
    });
    const data = await this.post<StripePaymentIntent>('/v1/payment_intents', body, input.idempotencyKey);
    // [M-02] Unreachable / timed out — UNKNOWN, never a decline: Stripe may
    // have created and confirmed the intent. Billing retrieves before a retry.
    if (!data) return { status: 'unknown', providerRef: '', reason: 'Gateway unreachable' };
    if (data.status === 'succeeded') {
      return { status: 'succeeded', providerRef: data.id ?? '' };
    }
    const reason = data.error?.decline_code ?? data.error?.message ?? data.status ?? 'Declined';
    return { status: 'failed', providerRef: data.id ?? '', reason };
  }

  /** [M-01] The truth of an instruction: by the PaymentIntent id when we have
   *  it. Without an id there is nothing to retrieve by — UNKNOWN, for the
   *  reconciler and a person. */
  async lookupCharge(input: { idempotencyKey: string; providerRef?: string }): Promise<ChargeLookup> {
    if (!input.providerRef) return { status: 'unknown', reason: 'Stripe: no PaymentIntent id was recorded for this key' };
    const data = await this.get<StripePaymentIntent>(`/v1/payment_intents/${encodeURIComponent(input.providerRef)}`);
    if (!data) return { status: 'unknown', reason: 'Gateway unreachable' };
    if (data.error?.code === 'resource_missing') return { status: 'not_found' };
    if (data.status === 'succeeded') return { status: 'succeeded', providerRef: data.id };
    if (data.status === 'canceled' || data.status === 'requires_payment_method') {
      return { status: 'failed', providerRef: data.id, reason: data.error?.decline_code ?? data.error?.message ?? data.status };
    }
    return { status: 'unknown', providerRef: data.id, reason: data.status };
  }

  private async get<T>(path: string): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STRIPE_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        signal: controller.signal,
        headers: { authorization: `Bearer ${this.secretKey}` },
      });
      return (await res.json()) as T;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async refund(input: { providerRef: string; amount: number; currencyCode: string; idempotencyKey: string }): Promise<ChargeResult> {
    const body = new URLSearchParams({
      payment_intent: input.providerRef,
      amount: String(toProviderMinor(input.amount, input.currencyCode, 'stripe.refund')),
    });
    const data = await this.post<StripeRefund>('/v1/refunds', body, input.idempotencyKey);
    if (!data) return { status: 'failed', providerRef: '', reason: 'Gateway unreachable' };
    if (data.status === 'succeeded' || data.status === 'pending') {
      return { status: 'succeeded', providerRef: data.id ?? '' };
    }
    return { status: 'failed', providerRef: data.id ?? '', reason: data.error?.message ?? data.status ?? 'Refund failed' };
  }

  /** Single form-encoded POST. Null only on transport failure; HTTP error
   *  bodies are returned so the caller can surface Stripe's reason. */
  private async post<T>(path: string, body: URLSearchParams, idempotencyKey: string): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STRIPE_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          'idempotency-key': idempotencyKey,
        },
        body: body.toString(),
      });
      return (await res.json()) as T;
    } catch {
      return null; // unreachable / timed out — soft failure, next cycle retries
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Provider selection is config, not code. */
export function getPaymentProvider(): PaymentProvider {
  const provider = process.env['PAYMENT_PROVIDER'] ?? 'sandbox';
  if (isProduction() && provider === 'sandbox') {
    throw new Error('PAYMENT_PROVIDER=sandbox is forbidden in production');
  }
  switch (provider) {
    case 'sandbox':
      return new SandboxPaymentProvider();
    case 'stripe': {
      const key = process.env['STRIPE_SECRET_KEY'];
      if (!key) {
        throw new Error('STRIPE_SECRET_KEY is required when PAYMENT_PROVIDER=stripe');
      }
      if (isProduction() && !key.startsWith('sk_live_')) {
        throw new Error('A live STRIPE_SECRET_KEY is required in production');
      }
      return new StripePaymentProvider(key);
    }
    case 'powertranz': {
      const id = process.env['PAYMENT_GATEWAY_KEY'];
      const password = process.env['PAYMENT_GATEWAY_SECRET'];
      if (!id || !password) {
        throw new Error(
          'PAYMENT_GATEWAY_KEY and PAYMENT_GATEWAY_SECRET are required when PAYMENT_PROVIDER=powertranz',
        );
      }
      if (isProduction()) {
        const url = process.env['POWERTRANZ_API_URL'];
        if (!url || !/^https:\/\//i.test(url) || /staging|sandbox|test/i.test(url)) {
          throw new Error('An explicit non-staging HTTPS POWERTRANZ_API_URL is required in production');
        }
      }
      return new PowerTranzPaymentProvider(id, password);
    }
    default:
      throw new Error(`Unknown PAYMENT_PROVIDER: ${provider}`);
  }
}
