import { toProviderMinor } from '../../utils/currency-amount';
import { nanoid } from 'nanoid';
import { randomUUID } from 'node:crypto';
import { isProduction } from '../../utils/runtime-mode';
import { assertDisabledCardRailConfig } from '../../utils/card-rail';
import { AppError } from '../../utils/errors';

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
  /** A local refusal, not a processor decline. Billing must not dun on it. */
  code?: 'CARD_RAIL_DISABLED';
}

/** [M-01] The provider's truth about an instruction we sent, by our key. */
export interface ChargeLookup {
  status: 'succeeded' | 'failed' | 'not_found' | 'unknown';
  providerRef?: string;
  reason?: string;
  code?: 'CARD_RAIL_DISABLED';
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

/** No gateway, token storage, synthetic capture or network access. Lookup
 * cannot determine an earlier charge's outcome and must leave it unresolved. */
class DisabledPaymentProvider implements PaymentProvider {
  async tokenizeCard(_input: Parameters<PaymentProvider['tokenizeCard']>[0]): Promise<{ token: string }> {
    throw new AppError(503, 'CARD_RAIL_DISABLED', 'Card payments are disabled.');
  }

  async chargeToken(_input: Parameters<PaymentProvider['chargeToken']>[0]): Promise<ChargeResult> {
    return { status: 'failed', providerRef: '', code: 'CARD_RAIL_DISABLED', reason: 'Card payments are disabled.' };
  }

  async refund(_input: Parameters<PaymentProvider['refund']>[0]): Promise<ChargeResult> {
    return { status: 'failed', providerRef: '', code: 'CARD_RAIL_DISABLED', reason: 'Card payments are disabled.' };
  }

  async lookupCharge(_input: Parameters<PaymentProvider['lookupCharge']>[0]): Promise<ChargeLookup> {
    return { status: 'unknown', code: 'CARD_RAIL_DISABLED', reason: 'Card payments are disabled.' };
  }
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

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalProviderRef(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isAmbiguousHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isSuccessfulHttpStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function powerTranzDeclineReason(data: Record<string, unknown>): string {
  if (typeof data['ResponseMessage'] === 'string') return data['ResponseMessage'];
  const errors = data['Errors'];
  if (Array.isArray(errors) && isJsonObject(errors[0]) && typeof errors[0]['Message'] === 'string') {
    return errors[0]['Message'];
  }
  if (typeof data['IsoResponseCode'] === 'string') return data['IsoResponseCode'];
  return 'Declined';
}

function stripeChargeErrorReason(data: Record<string, unknown>): string | undefined {
  const error = data['error'];
  if (!isJsonObject(error)) return undefined;
  if (typeof error['decline_code'] === 'string') return error['decline_code'];
  if (typeof error['message'] === 'string') return error['message'];
  return undefined;
}

function stripeRefundErrorReason(data: Record<string, unknown>): string | undefined {
  const error = data['error'];
  if (!isJsonObject(error)) return undefined;
  return typeof error['message'] === 'string' ? error['message'] : undefined;
}

/**
 * PowerTranz/FAC adapter. Only `chargeToken` is on the billing hot path
 * (recurring weekly fees on a stored card token), so — exactly like the
 * sandbox — it NEVER throws: transport errors, timeouts, non-OK responses and
 * declines all resolve to a ChargeResult, leaving the billing retry/suspend
 * logic in control. Outcomes that may have taken effect at the gateway are
 * `unknown`, never declines: billing must reconcile them before another
 * instruction is issued.
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
        // [M-02] A timeout, rate limit, or 5xx is ambiguous — the instruction
        // MAY have been processed. Other 4xx responses are definitive refusal.
        const ambiguous = isAmbiguousHttpStatus(res.status);
        return { status: ambiguous ? 'unknown' : 'failed', providerRef: '', reason: `Gateway HTTP ${res.status}` };
      }
      const data: unknown = await res.json();
      if (!isJsonObject(data)) {
        return { status: 'unknown', providerRef: '', reason: 'Malformed gateway response' };
      }
      const providerRef = canonicalProviderRef(data['TransactionIdentifier']);
      if (data['Approved'] === true) {
        // Approval without the processor's canonical reference may represent a
        // real capture, but cannot be reconciled or safely refunded. Never
        // convert that ambiguous provider response into a booked success.
        if (!providerRef) {
          return { status: 'unknown', providerRef: '', reason: 'Approved response missing TransactionIdentifier' };
        }
        return { status: 'succeeded', providerRef };
      }
      if (data['Approved'] === false) {
        return { status: 'failed', providerRef, reason: powerTranzDeclineReason(data) };
      }
      return { status: 'unknown', providerRef, reason: 'Malformed Approved response' };
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

/**
 * Stripe adapter. Same contract as the others: `chargeToken` NEVER throws —
 * definitive declines resolve to `failed`; transport and server outcomes that
 * may have taken effect resolve to `unknown` for reconciliation.
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
    const response = await this.post('/v1/payment_intents', body, input.idempotencyKey);
    // [M-02] Unreachable / timed out — UNKNOWN, never a decline: Stripe may
    // have created and confirmed the intent. Billing retrieves before a retry.
    if (!response) return { status: 'unknown', providerRef: '', reason: 'Gateway unreachable' };
    const providerRef = isJsonObject(response.data)
      ? canonicalProviderRef(response.data['id'])
      : '';
    if (response.status === 409 || isAmbiguousHttpStatus(response.status)) {
      return { status: 'unknown', providerRef, reason: `Gateway HTTP ${response.status}` };
    }
    const data = response.data;
    if (!isJsonObject(data)) {
      return { status: 'unknown', providerRef: '', reason: 'Malformed gateway response' };
    }
    const status = typeof data['status'] === 'string' ? data['status'] : undefined;
    const errorReason = stripeChargeErrorReason(data);
    const terminalFailure = status === 'canceled' || status === 'requires_payment_method';
    if (!isSuccessfulHttpStatus(response.status)) {
      if (terminalFailure || (!status && errorReason)) {
        return { status: 'failed', providerRef, reason: errorReason ?? status ?? 'Declined' };
      }
      return { status: 'unknown', providerRef, reason: `Gateway HTTP ${response.status}` };
    }
    if (status === 'succeeded') {
      if (!providerRef) {
        return { status: 'unknown', providerRef: '', reason: 'Succeeded response missing PaymentIntent id' };
      }
      return { status: 'succeeded', providerRef };
    }
    if (terminalFailure) {
      return { status: 'failed', providerRef, reason: errorReason ?? status ?? 'Declined' };
    }
    return { status: 'unknown', providerRef, reason: status ?? 'Malformed gateway response' };
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
    const response = await this.post('/v1/refunds', body, input.idempotencyKey);
    // The refund may have reached Stripe even when transport fails or Stripe
    // returns a server error. A new instruction under a new key could refund
    // twice, so preserve ambiguity for reconciliation.
    if (!response) return { status: 'unknown', providerRef: '', reason: 'Gateway unreachable' };
    const providerRef = isJsonObject(response.data)
      ? canonicalProviderRef(response.data['id'])
      : '';
    if (response.status === 409 || isAmbiguousHttpStatus(response.status)) {
      return { status: 'unknown', providerRef, reason: `Gateway HTTP ${response.status}` };
    }
    const data = response.data;
    if (!isJsonObject(data)) {
      return { status: 'unknown', providerRef: '', reason: 'Malformed gateway response' };
    }
    const status = typeof data['status'] === 'string' ? data['status'] : undefined;
    const errorReason = stripeRefundErrorReason(data);
    if (!isSuccessfulHttpStatus(response.status)) {
      if (status === 'failed' || (!status && errorReason)) {
        return { status: 'failed', providerRef, reason: errorReason ?? status ?? 'Refund failed' };
      }
      return { status: 'unknown', providerRef, reason: `Gateway HTTP ${response.status}` };
    }
    if (status === 'succeeded') {
      if (!providerRef) {
        return { status: 'unknown', providerRef: '', reason: 'Successful response missing Refund id' };
      }
      return { status: 'succeeded', providerRef };
    }
    if (status === 'failed') {
      return { status: 'failed', providerRef, reason: errorReason ?? status ?? 'Refund failed' };
    }
    return { status: 'unknown', providerRef, reason: status ?? 'Malformed gateway response' };
  }

  /** Single form-encoded POST. Null means no trustworthy HTTP response was
   *  available; otherwise the status stays attached so callers cannot mistake
   *  a server error body for a definitive decline. */
  private async post(
    path: string,
    body: URLSearchParams,
    idempotencyKey: string,
  ): Promise<{ status: number; data: unknown } | null> {
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
      return { status: res.status, data: await res.json() };
    } catch {
      return null; // unreachable / timed out — ambiguous; reconcile before any retry
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
    case 'disabled':
      assertDisabledCardRailConfig(process.env);
      return new DisabledPaymentProvider();
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
