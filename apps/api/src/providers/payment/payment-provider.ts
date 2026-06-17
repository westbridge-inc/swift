import { nanoid } from 'nanoid';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// PaymentProvider — hard rule 4: swappable interface. Nothing outside this
// module may know which processor exists. V1 only ever charges Swift's OWN
// subscription fee — order money is never processed (hard rule 2).
// ---------------------------------------------------------------------------

export interface ChargeResult {
  status: 'succeeded' | 'failed';
  /** Provider-side charge reference */
  providerRef: string;
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

  refund(input: { providerRef: string; amount: number; idempotencyKey: string }): Promise<ChargeResult>;
}

/**
 * Sandbox adapter. Deterministic markers for tests:
 * a token containing "fail" always declines; everything else succeeds.
 */
export class SandboxPaymentProvider implements PaymentProvider {
  async tokenizeCard(input: { userId: string; cardNumber: string }): Promise<{ token: string }> {
    // Card numbers ending 0002 produce an always-declining token (Stripe-style)
    const marker = input.cardNumber.endsWith('0002') ? 'fail_' : '';
    return { token: `tok_${marker}${nanoid(12)}` };
  }

  async chargeToken(input: { token: string; idempotencyKey: string }): Promise<ChargeResult> {
    if (input.token.includes('fail')) {
      return { status: 'failed', providerRef: `ch_${nanoid(10)}`, reason: 'Card declined (sandbox)' };
    }
    return { status: 'succeeded', providerRef: `ch_${nanoid(10)}` };
  }

  async refund(_input: { providerRef: string; amount: number; idempotencyKey: string }): Promise<ChargeResult> {
    return { status: 'succeeded', providerRef: `re_${nanoid(10)}` };
  }
}

// PowerTranz / First Atlantic Commerce — the spec's primary subscription
// billing rail (docs/SWIFT-MASTER-SPEC.md §billing). Caribbean acquirer.
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

  async refund(input: { providerRef: string; amount: number; idempotencyKey: string }): Promise<ChargeResult> {
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
        return { status: 'failed', providerRef: '', reason: `Gateway HTTP ${res.status}` };
      }
      const data = (await res.json()) as PowerTranzResponse;
      if (data.Approved) {
        return { status: 'succeeded', providerRef: data.TransactionIdentifier ?? '' };
      }
      const reason = data.ResponseMessage ?? data.Errors?.[0]?.Message ?? data.IsoResponseCode ?? 'Declined';
      return { status: 'failed', providerRef: data.TransactionIdentifier ?? '', reason };
    } catch {
      // Unreachable / timed out — soft failure; billing retries on the next cycle.
      return { status: 'failed', providerRef: '', reason: 'Gateway unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Provider selection is config, not code. */
export function getPaymentProvider(): PaymentProvider {
  const provider = process.env['PAYMENT_PROVIDER'] ?? 'sandbox';
  switch (provider) {
    case 'sandbox':
      return new SandboxPaymentProvider();
    case 'powertranz': {
      const id = process.env['PAYMENT_GATEWAY_KEY'];
      const password = process.env['PAYMENT_GATEWAY_SECRET'];
      if (!id || !password) {
        throw new Error(
          'PAYMENT_GATEWAY_KEY and PAYMENT_GATEWAY_SECRET are required when PAYMENT_PROVIDER=powertranz',
        );
      }
      return new PowerTranzPaymentProvider(id, password);
    }
    default:
      throw new Error(`Unknown PAYMENT_PROVIDER: ${provider}`);
  }
}
