import { nanoid } from 'nanoid';

// ---------------------------------------------------------------------------
// MMG (Mobile Money Guyana) — Merchant-Initiated Payments.
// Docs: https://mmg.gy/developer/Merchant%20Initiated.html
//   6 endpoints: Authentication · Initiate Payment · Reverse Transaction ·
//   Transaction History · Transaction Lookup · Account Balance.
//
// This is the SWAPPABLE seam (hard rule 4) for the "merchant-initiated" flow:
// the platform's OWN collection account pushes a payment request that the payer
// approves on their phone — used for (a) the platform-billing MMG rail's weekly
// fee, and (b) future marketplace auto-confirm. It is NOT wired into any money
// path yet; `MMG_DRIVER=sandbox` (default) until a live account + confirmed wire
// format land. Marketplace order money still never flows through Swift.
//
// Exact request/response field names + the auth/RSA scheme are `[CONFIRM WITH MMG]`
// (the doc sub-pages are JS-rendered; confirm with merchantservice@mmg.gy). Live
// methods on the money hot path must NEVER throw — mirror the PaymentProvider
// adapters: transport errors/timeouts/declines resolve to a status result so the
// billing retry/suspend cycle stays in control.
// ---------------------------------------------------------------------------

export type MmgTxStatus = 'pending' | 'approved' | 'declined' | 'reversed' | 'expired' | 'error';

export interface MmgInitiateRequest {
  /** The payer's MMG wallet id / MSISDN — they approve on their phone. [CONFIRM] */
  payerId: string;
  /** Amount in MINOR GYD units (integer, no floats). [CONFIRM] */
  amountMinor: number;
  currencyCode: string; // 'GYD'
  /** Our idempotent reference (order/invoice id) — makes retries safe. */
  reference: string;
  description?: string;
}

export interface MmgTxResult {
  status: MmgTxStatus;
  /** MMG's transaction reference (empty on immediate decline/error). */
  transactionId: string;
  reason?: string;
}

export interface MmgTransaction {
  transactionId: string;
  status: MmgTxStatus;
  amountMinor: number;
  currencyCode: string;
  reference?: string;
  createdAt?: string;
}

export interface MmgBalance {
  currencyCode: string;
  balanceMinor: number;
}

export interface MmgMerchantProvider {
  /** POST Authentication → a session token used by the other calls. */
  authenticate(): Promise<{ token: string; expiresAt?: Date }>;
  /** POST Initiate Payment → push a charge the payer approves on their phone.
   *  Typically returns `pending`; poll `transactionLookup` for the outcome. */
  initiatePayment(req: MmgInitiateRequest): Promise<MmgTxResult>;
  /** POST Reverse Transaction → reverse/refund a prior transaction. */
  reverseTransaction(req: { transactionId: string; reason?: string }): Promise<MmgTxResult>;
  /** GET Transaction Lookup → current status of one transaction. */
  transactionLookup(req: { transactionId: string }): Promise<MmgTransaction>;
  /** GET Transaction History. */
  transactionHistory(req?: { from?: Date; to?: Date; limit?: number }): Promise<MmgTransaction[]>;
  /** GET Account Balance (the collection account's balance). */
  accountBalance(): Promise<MmgBalance>;
}

/**
 * Deterministic sandbox — lets the billing/agent code and tests run the whole
 * merchant-initiated loop without a live MMG account. Markers:
 *   - a reference containing "decline" → the initiate is declined outright;
 *   - otherwise it returns `pending` with the eventual outcome encoded in the
 *     transactionId ("pending" stays pending on lookup, else it approves), so
 *     lookup is stateless yet deterministic.
 */
export class SandboxMmgProvider implements MmgMerchantProvider {
  async authenticate(): Promise<{ token: string; expiresAt?: Date }> {
    return { token: `mmg_sandbox_${nanoid(12)}`, expiresAt: new Date(Date.now() + 3_600_000) };
  }

  async initiatePayment(req: MmgInitiateRequest): Promise<MmgTxResult> {
    if (req.reference.toLowerCase().includes('decline')) {
      return { status: 'declined', transactionId: '', reason: 'Payer declined (sandbox)' };
    }
    const outcome = req.reference.toLowerCase().includes('pending') ? 'pending' : 'approved';
    return { status: 'pending', transactionId: `mmgtx_${outcome}_${nanoid(10)}` };
  }

  async reverseTransaction(req: { transactionId: string }): Promise<MmgTxResult> {
    return { status: 'reversed', transactionId: req.transactionId };
  }

  async transactionLookup(req: { transactionId: string }): Promise<MmgTransaction> {
    const status: MmgTxStatus = req.transactionId.includes('pending')
      ? 'pending'
      : req.transactionId.includes('reversed')
        ? 'reversed'
        : 'approved';
    return { transactionId: req.transactionId, status, amountMinor: 0, currencyCode: 'GYD' };
  }

  async transactionHistory(): Promise<MmgTransaction[]> {
    return [];
  }

  async accountBalance(): Promise<MmgBalance> {
    return { currencyCode: 'GYD', balanceMinor: 0 };
  }
}

/**
 * Live adapter — SCAFFOLD. The 6 endpoints and the never-throw money-path
 * contract are laid out; the wire format (paths, field names, RSA/token auth)
 * is `[CONFIRM WITH MMG]` before this can be enabled. Until then it fails safe
 * so nothing half-charges: money-path methods return an `error` result, reads
 * throw a clear "not configured".
 */
export class LiveMmgProvider implements MmgMerchantProvider {
  constructor(
    private merchantId: string,
    private apiKey: string,
    private baseUrl: string = process.env['MMG_API_URL'] ?? 'https://mmg.gy',
  ) {
    void this.merchantId;
    void this.apiKey;
    void this.baseUrl;
  }

  private notConfigured(): never {
    throw new Error('MMG live driver is not configured yet — [CONFIRM WITH MMG] the Merchant-Initiated wire format, then implement.');
  }

  async authenticate(): Promise<{ token: string; expiresAt?: Date }> {
    // POST {baseUrl}/…/Authentication  [CONFIRM WITH MMG]
    return this.notConfigured();
  }
  async initiatePayment(_req: MmgInitiateRequest): Promise<MmgTxResult> {
    // POST {baseUrl}/…/InitiatePayment  [CONFIRM WITH MMG]. Never throw when live:
    // map transport/timeout/decline to { status: 'error'|'declined', reason }.
    return { status: 'error', transactionId: '', reason: 'MMG live not configured' };
  }
  async reverseTransaction(_req: { transactionId: string; reason?: string }): Promise<MmgTxResult> {
    // POST {baseUrl}/…/ReverseTransaction  [CONFIRM WITH MMG]
    return { status: 'error', transactionId: '', reason: 'MMG live not configured' };
  }
  async transactionLookup(_req: { transactionId: string }): Promise<MmgTransaction> {
    // GET {baseUrl}/…/TransactionLookup  [CONFIRM WITH MMG]
    return this.notConfigured();
  }
  async transactionHistory(): Promise<MmgTransaction[]> {
    // GET {baseUrl}/…/TransactionHistory  [CONFIRM WITH MMG]
    return this.notConfigured();
  }
  async accountBalance(): Promise<MmgBalance> {
    // GET {baseUrl}/…/AccountBalance  [CONFIRM WITH MMG]
    return this.notConfigured();
  }
}

/** Driver selection is config, not code. Defaults to the sandbox. */
export function getMmgProvider(): MmgMerchantProvider {
  const driver = process.env['MMG_DRIVER'] ?? 'sandbox';
  switch (driver) {
    case 'sandbox':
      return new SandboxMmgProvider();
    case 'live': {
      const merchantId = process.env['MMG_MERCHANT_ID'];
      const apiKey = process.env['MMG_API_KEY'];
      if (!merchantId || !apiKey) {
        throw new Error('MMG_MERCHANT_ID and MMG_API_KEY are required when MMG_DRIVER=live');
      }
      return new LiveMmgProvider(merchantId, apiKey);
    }
    default:
      throw new Error(`Unknown MMG_DRIVER: ${driver}`);
  }
}
