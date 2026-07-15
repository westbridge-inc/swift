import { nanoid } from 'nanoid';

// ---------------------------------------------------------------------------
// MMG (Mobile Money Guyana) — Merchant-Initiated Payments.
// Docs: https://mmg.gy/developer/Merchant%20Initiated.html — the Swagger shell
// loads the real contract from https://mmg.gy/developer/openapi.yaml (OpenAPI
// 3.0.3, UAT server https://mwallet.mmgtest.net/olive/publisher/v1):
//   POST /e-commerce-login/mer                              Authentication
//   POST /e-merchant-initiated-transactions/payment          Initiate Payment
//   POST /e-merchant-initiated-transactions/reversal         Reverse (FULL only)
//   GET  /e-merchant-initiated-transactions/txn-history      Transaction History
//   GET  /e-merchant-initiated-transactions/lookup           Transaction Lookup
//   GET  /e-merchant-initiated-transactions/balance          Account Balance
//
// This is the SWAPPABLE seam (hard rule 4) for the "merchant-initiated" flow:
// the platform's OWN collection account pushes a payment request that the payer
// approves on their phone — used for (a) the platform-billing MMG rail's weekly
// fee, and (b) future marketplace auto-confirm. `MMG_DRIVER=sandbox` (default)
// until live credentials land. Marketplace order money never flows through Swift.
//
// Live methods on the money hot path NEVER throw — mirror the PaymentProvider
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

export interface LiveMmgConfig {
  /** UAT per the published OpenAPI; production URL arrives with onboarding. */
  baseUrl: string;
  /** `x-api-key` header + the auth form's `api_key`. */
  apiKey: string;
  /** Merchant MSISDN — auth `username`, `x-wss-mid`, `merchant_msisdn`, and the creditParty account. */
  merchantMsisdn: string;
  /** Auth form `password`. */
  password: string;
  /** `x-wss-mkey` header. */
  mkey: string;
  /** `x-wss-msecret` header (MMG-issued encrypted secret). */
  msecret: string;
}

export const MMG_UAT_URL = 'https://mwallet.mmgtest.net/olive/publisher/v1';
const CALL_TIMEOUT_MS = 15_000;
// access_token lives 120s (`expires_in`) — refresh with headroom.
const TOKEN_TTL_MS = 90_000;

/** MMG's transactionStatus vocabulary → ours. Unknown non-terminal words stay
 *  `pending` so a poller keeps polling until its own expiryTime gives up —
 *  never guess "approved". */
function mapMmgStatus(s: string | undefined): MmgTxStatus {
  const v = String(s ?? '').toLowerCase();
  if (v === 'successful' || v === 'completed') return 'approved';
  if (v === 'pending') return 'pending';
  if (v === 'reversed') return 'reversed';
  if (v === 'expired') return 'expired';
  if (v === 'failed' || v === 'declined' || v === 'rejected') return 'declined';
  return 'pending';
}

/** MMG sends amounts as MAJOR-unit strings ("500.00") — we hold minor ints. */
function toMajorString(amountMinor: number): string {
  return (amountMinor / 100).toFixed(2);
}
function toMinor(major: string | undefined): number {
  const n = Number.parseFloat(String(major ?? '0'));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/**
 * Live adapter over the published Merchant-Initiated OpenAPI (see header).
 * Money-path methods (initiate/reverse) NEVER throw — transport errors,
 * timeouts and declines resolve to a status result so the billing
 * retry/suspend cycle stays in control. Reads throw with a clear message.
 */
export class LiveMmgProvider implements MmgMerchantProvider {
  private cachedToken: { token: string; fetchedAt: number } | null = null;

  constructor(
    private cfg: LiveMmgConfig,
    /** Injectable for tests. */
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async call(path: string, init: NonNullable<Parameters<typeof fetch>[1]>): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS);
    try {
      return await this.fetchFn(`${this.cfg.baseUrl}${path}`, { ...init, signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST /e-commerce-login/mer (form-encoded) → 120s bearer token. */
  async authenticate(): Promise<{ token: string; expiresAt?: Date }> {
    const form = new URLSearchParams({
      grant_type: 'password',
      api_key: this.cfg.apiKey,
      username: this.cfg.merchantMsisdn,
      password: this.cfg.password,
    });
    const res = await this.call('/e-commerce-login/mer', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`MMG auth failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('MMG auth returned no access_token');
    this.cachedToken = { token: body.access_token, fetchedAt: Date.now() };
    return { token: body.access_token, expiresAt: new Date(Date.now() + (body.expires_in ?? 120) * 1000) };
  }

  private async token(): Promise<string> {
    if (this.cachedToken && Date.now() - this.cachedToken.fetchedAt < TOKEN_TTL_MS) {
      return this.cachedToken.token;
    }
    return (await this.authenticate()).token;
  }

  /** The x-wss-* header block every transaction call carries. */
  private async wssHeaders(correlationId: string): Promise<Record<string, string>> {
    return {
      'x-wss-token': await this.token(),
      'x-wss-mid': this.cfg.merchantMsisdn,
      'x-wss-mkey': this.cfg.mkey,
      'x-api-key': this.cfg.apiKey,
      'x-wss-msecret': this.cfg.msecret,
      'x-wss-correlationid': correlationId,
    };
  }

  /** POST /payment — push the charge; payer approves on their phone.
   *  Correlation id = our reference, so a blind retry carries the same id. */
  async initiatePayment(req: MmgInitiateRequest): Promise<MmgTxResult> {
    try {
      const headers = await this.wssHeaders(req.reference);
      const res = await this.call(
        `/e-merchant-initiated-transactions/payment?merchant_msisdn=${encodeURIComponent(this.cfg.merchantMsisdn)}`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            amount: toMajorString(req.amountMinor),
            currency: req.currencyCode,
            subType: 'merinipmt',
            type: 'transfer',
            debitParty: [{ key: 'accountid', value: req.payerId }],
            creditParty: [{ key: 'accountid', value: this.cfg.merchantMsisdn }],
          }),
        },
      );
      if (res.status === 422) {
        // Terminal business rejection (e.g. INVALID_* / limit codes).
        const body: any = await res.json().catch(() => ({}));
        return { status: 'declined', transactionId: String(body?.transactionId ?? ''), reason: String(body?.message ?? 'MMG rejected the payment') };
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { status: 'error', transactionId: '', reason: `MMG payment HTTP ${res.status}: ${detail.slice(0, 200)}` };
      }
      // 200 → { status: "pending", pendingReason: "approvalrequired",
      //         notificationMethod: "polling", executionId, expiryTime }
      const body: any = await res.json();
      return {
        status: mapMmgStatus(body?.status),
        transactionId: String(body?.executionId ?? body?.objectReference ?? ''),
        ...(body?.pendingReason ? { reason: String(body.pendingReason) } : {}),
      };
    } catch (err) {
      return { status: 'error', transactionId: '', reason: `MMG payment unreachable: ${(err as Error).message}` };
    }
  }

  /** POST /reversal — FULL refunds only, per MMG. Never throws. */
  async reverseTransaction(req: { transactionId: string; reason?: string }): Promise<MmgTxResult> {
    try {
      const headers = await this.wssHeaders(`rev-${req.transactionId}`);
      const res = await this.call(
        `/e-merchant-initiated-transactions/reversal?merchant_msisdn=${encodeURIComponent(this.cfg.merchantMsisdn)}&transactionId=${encodeURIComponent(req.transactionId)}`,
        { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' },
      );
      if (res.status === 422) {
        const body: any = await res.json().catch(() => ({}));
        return { status: 'error', transactionId: req.transactionId, reason: String(body?.message ?? 'MMG reversal rejected') };
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { status: 'error', transactionId: req.transactionId, reason: `MMG reversal HTTP ${res.status}: ${detail.slice(0, 200)}` };
      }
      const body: any = await res.json();
      const mmgStatus = String(body?.transactionStatus ?? '').toLowerCase();
      return {
        // A 200 means MMG accepted the reversal; "pending" is it working
        // through — report in-flight honestly, 'reversed' once terminal.
        status: mmgStatus === 'pending' ? 'pending' : 'reversed',
        transactionId: String(body?.transactionReference ?? req.transactionId),
      };
    } catch (err) {
      return { status: 'error', transactionId: req.transactionId, reason: `MMG reversal unreachable: ${(err as Error).message}` };
    }
  }

  /** GET /lookup — poll target for the initiate flow. Throws on transport. */
  async transactionLookup(req: { transactionId: string }): Promise<MmgTransaction> {
    const headers = await this.wssHeaders(`lkp-${req.transactionId}`);
    const res = await this.call(
      `/e-merchant-initiated-transactions/lookup?transactionId=${encodeURIComponent(req.transactionId)}`,
      { method: 'GET', headers },
    );
    if (!res.ok) throw new Error(`MMG lookup failed (HTTP ${res.status})`);
    const body: any = await res.json();
    return {
      transactionId: String(body?.transactionReference ?? req.transactionId),
      status: mapMmgStatus(body?.transactionStatus),
      amountMinor: toMinor(body?.amount),
      currencyCode: String(body?.currency ?? 'GYD'),
      reference: body?.metadata?.find?.((m: any) => m?.key === 'description')?.value || undefined,
      createdAt: body?.creationDate,
    };
  }

  /** GET /txn-history. Throws on transport. */
  async transactionHistory(req?: { from?: Date; to?: Date; limit?: number }): Promise<MmgTransaction[]> {
    const now = new Date();
    const from = req?.from ?? new Date(now.getTime() - 7 * 24 * 3_600_000);
    const to = req?.to ?? now;
    const headers = await this.wssHeaders(`hist-${from.getTime()}`);
    const qs = new URLSearchParams({
      offset: '1',
      fromdate: from.toISOString(),
      todate: to.toISOString(),
      msisdn: this.cfg.merchantMsisdn,
    });
    const res = await this.call(`/e-merchant-initiated-transactions/txn-history?${qs}`, { method: 'GET', headers });
    if (!res.ok) throw new Error(`MMG history failed (HTTP ${res.status})`);
    const body: any = await res.json();
    const list: any[] = Array.isArray(body?.TransactionList) ? body.TransactionList : [];
    const mapped = list.map((t) => ({
      transactionId: String(t?.transactionReference ?? ''),
      status: mapMmgStatus(t?.transactionStatus),
      amountMinor: toMinor(t?.amount),
      currencyCode: String(t?.currency ?? 'GYD'),
      reference: t?.external_id ? String(t.external_id) : undefined,
      createdAt: t?.modificationDate,
    }));
    return req?.limit ? mapped.slice(0, req.limit) : mapped;
  }

  /** GET /balance — the collection account's available balance. Throws on transport. */
  async accountBalance(): Promise<MmgBalance> {
    const headers = await this.wssHeaders(`bal-${this.cfg.merchantMsisdn}`);
    const res = await this.call(
      `/e-merchant-initiated-transactions/balance?merchant_msisdn=${encodeURIComponent(this.cfg.merchantMsisdn)}`,
      { method: 'GET', headers },
    );
    if (!res.ok) throw new Error(`MMG balance failed (HTTP ${res.status})`);
    const body: any = await res.json();
    const wallet = Array.isArray(body?.accounts) ? body.accounts[0] : null;
    return {
      currencyCode: String(wallet?.accountBalance?.currency ?? 'GYD'),
      balanceMinor: toMinor(wallet?.accountBalance?.availableBalance),
    };
  }
}

/** Driver selection is config, not code. Defaults to the sandbox. */
export function getMmgProvider(): MmgMerchantProvider {
  const driver = process.env['MMG_DRIVER'] ?? 'sandbox';
  switch (driver) {
    case 'sandbox':
      return new SandboxMmgProvider();
    case 'live': {
      const cfg: LiveMmgConfig = {
        baseUrl: process.env['MMG_API_URL'] ?? MMG_UAT_URL,
        apiKey: process.env['MMG_API_KEY'] ?? '',
        merchantMsisdn: process.env['MMG_MERCHANT_ID'] ?? '',
        password: process.env['MMG_PASSWORD'] ?? '',
        mkey: process.env['MMG_MKEY'] ?? '',
        msecret: process.env['MMG_MSECRET'] ?? '',
      };
      const missing = (['apiKey', 'merchantMsisdn', 'password', 'mkey', 'msecret'] as const).filter((k) => !cfg[k]);
      if (missing.length > 0) {
        throw new Error(
          'MMG_DRIVER=live needs MMG_API_KEY, MMG_MERCHANT_ID, MMG_PASSWORD, MMG_MKEY and MMG_MSECRET ' +
            `(missing: ${missing.join(', ')})`,
        );
      }
      return new LiveMmgProvider(cfg);
    }
    default:
      throw new Error(`Unknown MMG_DRIVER: ${driver}`);
  }
}
