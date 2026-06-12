import { nanoid } from 'nanoid';

// ---------------------------------------------------------------------------
// PaymentProvider — hard rule 4: swappable interface. A PowerTranz/WiPay-class
// adapter slots in later; nothing outside this module may know which
// processor exists. V1 only ever charges Swift's OWN subscription fee —
// order money is never processed (hard rule 2).
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

/** Provider selection is config, not code. */
export function getPaymentProvider(): PaymentProvider {
  const provider = process.env['PAYMENT_PROVIDER'] ?? 'sandbox';
  switch (provider) {
    case 'sandbox':
      return new SandboxPaymentProvider();
    default:
      throw new Error(`Unknown PAYMENT_PROVIDER: ${provider}`);
  }
}
