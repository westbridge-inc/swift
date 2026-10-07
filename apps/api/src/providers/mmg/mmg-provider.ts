import { fromMajor, fromMinor, toMajorString as majorStringOf } from '../../utils/currency-amount';
import { nanoid } from 'nanoid';
import { isProduction } from '../../utils/runtime-mode';

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
  /** The account(s) the money went to (a lookup's creditParty values). */
  creditParties?: string[];
}

/**
 * [MMG checkout 2/6] One transaction as the merchant lookup reports it, with
 * the three outcomes a verifier must tell apart: MMG answered with the
 * transaction, MMG does not know the id, or MMG could not be asked. Only a
 * `found` answer is evidence. Every field MMG did not send, or sent in a
 * form that cannot be read exactly, is null: never a default.
 */
export type MmgLookupDetail =
  | {
    outcome: 'found';
    transactionId: string;
    status: MmgTxStatus;
    /** transactionStatus exactly as MMG sent it ("successful" in UAT, 1 Oct), or null. */
    statusText: string | null;
    /** Exact minor units, or null when the amount was absent or unreadable. */
    amountMinor: number | null;
    currencyCode: string | null;
    /** creditParty values, or null when MMG sent none. */
    creditParties: string[] | null;
    /** The values of the creditParty entries whose key is exactly "accountid":
     *  the account the money went to (UAT, 1 Oct: Swift's merchant MSISDN).
     *  An entry with an empty or missing value is kept as '' [DS632]. Null
     *  when MMG sent no creditParty list. */
    creditAccounts: string[] | null;
    createdAt: string | null;
    /** transactionReference exactly as sent: MMG's ledger number for the
     *  payment, a DIFFERENT number from the checkout reply's transactionId
     *  (UAT, 1 Oct). Null when absent or not a string. */
    ledgerReference: string | null;
    /** [F1] What MMG's answer carries in the CONFIRMED reference field(s)
     *  (MMG_LOOKUP_REFERENCE_FIELDS), exactly as sent. Empty while no field is
     *  confirmed, and then nothing binds this transaction to a checkout. */
    echoedReferences: string[];
    /** The answer as MMG sent it, for the observation record. */
    raw: Record<string, unknown>;
  }
  | { outcome: 'not_found' }
  | { outcome: 'error'; reason: string };

/**
 * [MMG checkout F1] Which field of MMG's lookup answer echoes the merchant's
 * own transaction reference. NONE: MMG's UAT round trip (1 Oct) showed the
 * lookup carries neither our merchantTransactionId nor our description, so no
 * field is read by a guessed name. A checkout is tied to its payment by MMG's
 * own success answer for it instead (the owner's ruling of 1 Oct, in
 * mmg-checkout.service.ts); a value here only ever adds a contradiction check.
 * Each entry is an exact key path ('a.b'). A value counts only when it is a
 * string, compared whole: never a substring, never a number (an 18-digit
 * reference does not survive a JSON number).
 */
export const MMG_LOOKUP_REFERENCE_FIELDS: readonly string[] = [];

/**
 * [MMG checkout] One HTTP 200 lookup answer as the verifier reads it. Pure:
 * the live adapter and the tests read MMG's answer the same way. Fields MMG
 * did not send, or sent in a form that cannot be read exactly, are null.
 */
export function lookupDetailFrom(answer: Record<string, unknown>, transactionId: string): Extract<MmgLookupDetail, { outcome: 'found' }> {
  const creditParty = answer['creditParty'];
  const statusText = typeof answer['transactionStatus'] === 'string' ? answer['transactionStatus'] : null;
  const ledgerReference = typeof answer['transactionReference'] === 'string' ? answer['transactionReference'] : null;
  const party = (entry: unknown) => (entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : null);
  return {
    outcome: 'found',
    transactionId: ledgerReference ?? transactionId,
    status: mapMmgStatus(statusText ?? undefined),
    statusText,
    amountMinor: exactMinor(answer['amount']),
    currencyCode: typeof answer['currency'] === 'string' ? answer['currency'] : null,
    creditParties: Array.isArray(creditParty)
      ? creditParty.map((entry: unknown) => String(party(entry)?.['value'] ?? '')).filter(Boolean)
      : null,
    // [DS632] Every "accountid" entry is kept, an empty or missing value as
    // '': it is not our merchant, so the verifier holds the payment. Never dropped.
    creditAccounts: Array.isArray(creditParty)
      ? creditParty.filter((entry: unknown) => party(entry)?.['key'] === 'accountid').map((entry: unknown) => String(party(entry)?.['value'] ?? ''))
      : null,
    createdAt: typeof answer['creationDate'] === 'string' ? answer['creationDate'] : null,
    ledgerReference,
    echoedReferences: echoedReferencesFrom(answer),
    raw: answer,
  };
}

/** The string values at exactly these key paths of a lookup answer. */
export function echoedReferencesFrom(raw: unknown, fields: readonly string[] = MMG_LOOKUP_REFERENCE_FIELDS): string[] {
  const out: string[] = [];
  for (const field of fields) {
    let node: unknown = raw;
    for (const part of field.split('.')) {
      node = node && typeof node === 'object' && !Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, part)
        ? (node as Record<string, unknown>)[part]
        : undefined;
    }
    if (typeof node === 'string') out.push(node);
  }
  return out;
}

// ---------------------------------------------------------------------------
// [MMG checkout · 7 Oct] Transaction History, read for condition (5).
// MMG (7 Oct): the lookup's creationDate is the moment of the LOOKUP;
// history's modificationDate is when the transaction was performed. What
// MMG UAT answered Swift's merchant credentials on 7 Oct (read-only probe):
// - GET /e-merchant-initiated-transactions/txn-history?msisdn=<merchant>
//   &offset=<n>&fromdate=<stamp>&todate=<stamp>, the lookup's x-wss headers;
// - fromdate and todate are both required (400 without them) and read like
//   MMG's own stamps (Guyana wall clock written with a "Z"); a date with no
//   time is refused (422 "Invalid dates");
// - `offset` is the NUMBER of rows answered, oldest first, not a page;
// - {executionId, TransactionList: [...]}: each row names the checkout's
//   transactionId in BOTH transactionReference and transactionReceipt;
//   transactionStatus "completed"; amount a major-unit string; currency;
//   modificationDate; displayType; descriptionText; debitParty/creditParty
//   [{key, value}] (keys accountid, accountcategory); external_id.
// ---------------------------------------------------------------------------

/** The history query, its dates already written as MMG reads them. `rows` is MMG's `offset`: how many rows to answer. */
export interface MmgHistoryQuery {
  fromdate: string;
  todate: string;
  rows: number;
}

/** MMG's history answer: every row as MMG sent it, or why there is none.
 *  Only an HTTP 200 object whose TransactionList is a list of objects is an
 *  answer; anything else is an error to retry, never a shorter list. */
export type MmgHistoryAnswer =
  | { outcome: 'rows'; rows: Record<string, unknown>[] }
  | { outcome: 'error'; reason: string };

/** One HTTP answer to the history call, read whole. Pure: the live adapter and the tests read it the same way. */
export function historyAnswerFrom(status: number, body: unknown): MmgHistoryAnswer {
  if (status !== 200) return { outcome: 'error', reason: `MMG history HTTP ${status}` };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { outcome: 'error', reason: 'MMG history answered with no object' };
  const list = (body as Record<string, unknown>)['TransactionList'];
  if (!Array.isArray(list)) return { outcome: 'error', reason: 'MMG history answered with no TransactionList' };
  if (!list.every((row: unknown) => !!row && typeof row === 'object' && !Array.isArray(row))) {
    return { outcome: 'error', reason: 'MMG history answered a row that is not an object' };
  }
  return { outcome: 'rows', rows: list as Record<string, unknown>[] };
}

/** One history row as condition (5) reads it. Every field MMG did not send,
 *  or sent in a form that cannot be read exactly, is null: never a default. */
export interface MmgHistoryRow {
  /** Swift checkout reference from MMG history; never a coerced or trimmed value. */
  externalId: string | null;
  transactionReference: string | null;
  transactionReceipt: string | null;
  /** transactionStatus exactly as sent ("completed" in UAT, 7 Oct). */
  statusText: string | null;
  /** Exact minor units, or null. */
  amountMinor: number | null;
  currencyCode: string | null;
  /** When MMG performed the transaction, exactly as sent. */
  modificationDate: string | null;
}
export function historyRowFrom(row: Record<string, unknown>): MmgHistoryRow {
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  return {
    externalId: text(row['external_id']),
    transactionReference: text(row['transactionReference']),
    transactionReceipt: text(row['transactionReceipt']),
    statusText: text(row['transactionStatus']),
    amountMinor: exactMinor(row['amount']),
    currencyCode: text(row['currency']),
    modificationDate: text(row['modificationDate']),
  };
}

/** The calls the checkout verifier makes. */
export interface MmgLookupClient {
  transactionLookupDetail(transactionId: string): Promise<MmgLookupDetail>;
  /** [7 Oct] GET txn-history for condition (5). Never throws. */
  transactionHistoryRows(query: MmgHistoryQuery): Promise<MmgHistoryAnswer>;
}

/**
 * The published initiate contract accepts Swift's reference in a correlation
 * header, while the published lookup/history examples expose separate response
 * fields. Swift does not assume MMG maps between them: sandbox UAT must prove
 * this exact round-trip before the live factory is enabled.
 */
export const MMG_REFERENCE_WIRE_CONTRACT = Object.freeze({
  outbound: Object.freeze({ carrier: 'header', field: 'x-wss-correlationid' }),
  lookup: Object.freeze({ carrier: 'json', field: 'metadata[].description' }),
  history: Object.freeze({ carrier: 'json', field: 'TransactionList[].external_id' }),
  activationEnv: 'MMG_REFERENCE_ROUNDTRIP_VERIFIED',
});

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
 *   - a reference containing "initerror" → the initiate dies transport-shaped
 *     (status `error`, no transaction id) — the UNKNOWN-intent path;
 *   - otherwise it returns `pending` with the eventual outcome encoded in the
 *     transactionId ("pending" stays pending on lookup, "expired" expires,
 *     "mismatch" approves with a wrong amount), so lookup is stateless yet
 *     deterministic.
 * For flows whose outcome must CHANGE over time (pending → approved), tests
 * script the sandbox per-transaction via sandboxSetTxStatus / and can plant
 * history rows for the UNKNOWN-adoption path via sandboxAddHistory — the
 * scriptable-mock seam [tollgate PART 10], reset with sandboxResetMmg().
 */
const txStatusOverrides = new Map<string, MmgTxStatus>();
const historyRows: MmgTransaction[] = [];
const initiatedRows = new Map<string, Pick<MmgTransaction, 'amountMinor' | 'currencyCode' | 'reference'>>();

/** Test control: force a transaction's lookup status (wins over markers). */
export function sandboxSetTxStatus(transactionId: string, status: MmgTxStatus): void {
  txStatusOverrides.set(transactionId, status);
}
/** Test control: plant a row the sandbox's transactionHistory will return. */
export function sandboxAddHistory(row: MmgTransaction): void {
  historyRows.push(row);
}
/** Test control: wipe all sandbox scripting. */
export function sandboxResetMmg(): void {
  txStatusOverrides.clear();
  historyRows.length = 0;
  initiatedRows.clear();
}

export class SandboxMmgProvider implements MmgMerchantProvider {
  async authenticate(): Promise<{ token: string; expiresAt?: Date }> {
    return { token: `mmg_sandbox_${nanoid(12)}`, expiresAt: new Date(Date.now() + 3_600_000) };
  }

  async initiatePayment(req: MmgInitiateRequest): Promise<MmgTxResult> {
    if (req.reference.toLowerCase().includes('decline')) {
      return { status: 'declined', transactionId: '', reason: 'Payer declined (sandbox)' };
    }
    if (req.reference.toLowerCase().includes('initerror') || req.payerId.includes('initerror')) {
      return { status: 'error', transactionId: '', reason: 'Gateway timeout (sandbox)' };
    }
    const outcome = req.reference.toLowerCase().includes('pending') ? 'pending' : 'approved';
    // Encode the requested amount so the stateless lookup can echo provider
    // truth exactly. A synthetic zero must never exercise a settlement bypass.
    const transactionId = `mmgtx_${outcome}_amt${req.amountMinor}_${nanoid(10)}`;
    initiatedRows.set(transactionId, {
      amountMinor: req.amountMinor,
      currencyCode: req.currencyCode,
      reference: req.reference,
    });
    return { status: 'pending', transactionId };
  }

  async reverseTransaction(req: { transactionId: string }): Promise<MmgTxResult> {
    return { status: 'reversed', transactionId: req.transactionId };
  }

  async transactionLookup(req: { transactionId: string }): Promise<MmgTransaction> {
    const scripted = txStatusOverrides.get(req.transactionId);
    const status: MmgTxStatus =
      scripted ??
      (req.transactionId.includes('pending')
        ? 'pending'
        : req.transactionId.includes('reversed')
          ? 'reversed'
          : req.transactionId.includes('expired')
            ? 'expired'
            : 'approved');
    const stored = initiatedRows.get(req.transactionId)
      ?? historyRows.find((row) => row.transactionId === req.transactionId);
    const encodedAmount = /_amt(\d+)_/.exec(req.transactionId)?.[1];
    const amountMinor = req.transactionId.includes('mismatch') && status === 'approved'
      ? 99_900
      : Number(stored?.amountMinor ?? encodedAmount ?? 0);
    return {
      transactionId: req.transactionId,
      status,
      amountMinor,
      currencyCode: stored?.currencyCode ?? 'GYD',
      ...(stored?.reference ? { reference: stored.reference } : {}),
    };
  }

  async transactionHistory(): Promise<MmgTransaction[]> {
    return [...historyRows];
  }

  async accountBalance(): Promise<MmgBalance> {
    return { currencyCode: 'GYD', balanceMinor: 0 };
  }

  /** [MMG checkout 2/6] Only a transaction this sandbox initiated or was told
   *  about (sandboxAddHistory) is found; any other id is not_found. A stateless
   *  "approved" for an unknown id would be the synthetic proof of payment the
   *  checkout verifier exists to refuse. */
  async transactionLookupDetail(transactionId: string): Promise<MmgLookupDetail> {
    const planted = historyRows.find((row) => row.transactionId === transactionId);
    const initiated = initiatedRows.get(transactionId);
    if (!planted && !initiated) return { outcome: 'not_found' };
    const status = txStatusOverrides.get(transactionId) ?? planted?.status ?? 'approved';
    const amountMinor = planted?.amountMinor ?? initiated?.amountMinor ?? null;
    const currencyCode = planted?.currencyCode ?? initiated?.currencyCode ?? null;
    const creditParties = planted?.creditParties ?? null;
    const raw: Record<string, unknown> = {
      transactionReference: transactionId,
      transactionStatus: status,
      ...(amountMinor === null ? {} : { amount: toMajorString(amountMinor) }),
      ...(currencyCode === null ? {} : { currency: currencyCode }),
      ...(creditParties === null ? {} : { creditParty: creditParties.map((value) => ({ key: 'accountid', value })) }),
    };
    return {
      outcome: 'found',
      transactionId,
      status,
      // The sandbox speaks Swift's own status words, never MMG's "successful",
      // so a sandbox checkout is never confirmed automatically.
      statusText: status,
      amountMinor,
      currencyCode,
      creditParties,
      creditAccounts: creditParties,
      createdAt: planted?.createdAt ?? null,
      ledgerReference: transactionId,
      echoedReferences: echoedReferencesFrom(raw),
      raw,
    };
  }

  /** [7 Oct] No history for the checkout: the sandbox never answers MMG's
   *  "successful", so the verifier never asks it, and nothing here confirms. */
  async transactionHistoryRows(_query: MmgHistoryQuery): Promise<MmgHistoryAnswer> {
    return { outcome: 'rows', rows: [] };
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

/** MMG sends amounts as MAJOR-unit strings ("500.00") — we hold minor ints.
 *  [M-36] Both directions go through the currency registry (MMG bills in
 *  GYD, declared once here), never a bare × 100. */
const MMG_CURRENCY = 'GYD';
function toMajorString(amountMinor: number): string {
  return majorStringOf(fromMinor(Math.round(amountMinor), MMG_CURRENCY));
}
function toMinor(major: string | undefined): number {
  try {
    return Number(fromMajor(String(major ?? '0'), MMG_CURRENCY).minor);
  } catch {
    return 0;
  }
}
/** The exact minor amount of what MMG sent, or null. Never 0 for "unreadable":
 *  a verifier compares this to what was asked for. */
function exactMinor(major: unknown): number | null {
  if (typeof major !== 'string' && typeof major !== 'number') return null;
  try {
    const minor = fromMajor(String(major), MMG_CURRENCY).minor;
    return minor >= 0n && minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
  } catch {
    return null;
  }
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
    return this.callReading(path, init, async (response) => response);
  }

  /** Keep the deadline active through the response body, including transports
   * that do not settle their body promise when the signal is aborted. */
  private async callReading<T>(path: string, init: NonNullable<Parameters<typeof fetch>[1]>, read: (response: Response) => Promise<T>): Promise<T> {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new Error('MMG request timed out'));
      }, CALL_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        this.fetchFn(`${this.cfg.baseUrl}${path}`, { ...init, signal: ac.signal }).then(read),
        deadline,
      ]);
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
    const body = await this.callReading('/e-commerce-login/mer', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    }, async (res) => {
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`MMG auth failed (${res.status}): ${detail.slice(0, 200)}`);
      }
      return await res.json() as { access_token?: string; expires_in?: number };
    });
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
      // A successful response without a usable provider id is still an
      // affirmative observation. The billing intent must hold it for history
      // reconciliation, never look up a coerced object or whitespace token.
      const transactionId = [body?.executionId, body?.objectReference]
        .find((value: unknown): value is string => typeof value === 'string'
          && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) ?? '';
      return {
        status: mapMmgStatus(body?.status),
        transactionId,
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
      // Settlement evidence must be exactly what MMG returned on the wire.
      // Falling back to our request id or the platform currency would turn an
      // incomplete provider response into apparent proof of payment.
      transactionId: typeof body?.transactionReference === 'string' ? body.transactionReference : '',
      status: mapMmgStatus(body?.transactionStatus),
      amountMinor: toMinor(body?.amount),
      currencyCode: typeof body?.currency === 'string' ? body.currency : '',
      reference: body?.metadata?.find?.((m: any) => m?.key === 'description')?.value || undefined,
      createdAt: body?.creationDate,
    };
  }

  /** [MMG checkout 2/6] GET /lookup for the checkout verifier. Never throws:
   *  400/404/422 mean MMG does not know the id; only an HTTP 200 object is an
   *  answer (owner, 1 Oct); anything else is an error to retry, never a verdict. */
  async transactionLookupDetail(transactionId: string): Promise<MmgLookupDetail> {
    let res: Response;
    try {
      const headers = await this.wssHeaders(`lkp-${transactionId}`);
      res = await this.call(
        `/e-merchant-initiated-transactions/lookup?transactionId=${encodeURIComponent(transactionId)}`,
        { method: 'GET', headers },
      );
    } catch (err) {
      return { outcome: 'error', reason: `MMG lookup unreachable: ${(err as Error).message}` };
    }
    if (res.status === 400 || res.status === 404 || res.status === 422) return { outcome: 'not_found' };
    if (res.status !== 200) return { outcome: 'error', reason: `MMG lookup HTTP ${res.status}` };
    const body: unknown = await res.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { outcome: 'error', reason: 'MMG lookup answered with no object' };
    return lookupDetailFrom(body as Record<string, unknown>, transactionId);
  }

  /** [7 Oct] GET /txn-history for condition (5), exactly the dates and row
   *  count asked. Never throws: MMG unreachable, or any answer other than an
   *  HTTP 200 list of objects, is an error to retry, never evidence. */
  async transactionHistoryRows(query: MmgHistoryQuery): Promise<MmgHistoryAnswer> {
    try {
      const headers = await this.wssHeaders(`hist-${Date.now()}`);
      const qs = new URLSearchParams({ msisdn: this.cfg.merchantMsisdn, offset: String(query.rows), fromdate: query.fromdate, todate: query.todate });
      return await this.callReading(`/e-merchant-initiated-transactions/txn-history?${qs}`, { method: 'GET', headers }, async (res) => {
        const body: unknown = res.status === 200 ? await res.json().catch(() => null) : null;
        return historyAnswerFrom(res.status, body);
      });
    } catch (err) {
      return { outcome: 'error', reason: `MMG history unreachable: ${(err as Error).message}` };
    }
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

/** The live merchant credentials, or a refusal naming what is missing. */
function readLiveMmgConfig(env: Record<string, string | undefined>): LiveMmgConfig {
  const cfg: LiveMmgConfig = {
    baseUrl: env['MMG_API_URL'] ?? MMG_UAT_URL,
    apiKey: env['MMG_API_KEY'] ?? '',
    merchantMsisdn: env['MMG_MERCHANT_ID'] ?? '',
    password: env['MMG_PASSWORD'] ?? '',
    mkey: env['MMG_MKEY'] ?? '',
    msecret: env['MMG_MSECRET'] ?? '',
  };
  const missing = (['apiKey', 'merchantMsisdn', 'password', 'mkey', 'msecret'] as const).filter((k) => !cfg[k]);
  if (missing.length > 0) {
    throw new Error(
      'MMG_DRIVER=live needs MMG_API_KEY, MMG_MERCHANT_ID, MMG_PASSWORD, MMG_MKEY and MMG_MSECRET ' +
        `(missing: ${missing.join(', ')})`,
    );
  }
  return cfg;
}

/**
 * [MMG checkout 2/6] The lookup the checkout verifier uses: the same driver
 * and credentials as the merchant-initiated rail, WITHOUT that rail's
 * MMG_REFERENCE_ROUNDTRIP_VERIFIED gate. That gate proves the push rail can
 * find its own requests by OUR reference in lookup and history; the checkout
 * looks up MMG's own transaction id and depends on no such round trip.
 */
export function getMmgLookupProvider(env: Record<string, string | undefined> = process.env): MmgLookupClient {
  const driver = env['MMG_DRIVER'] ?? 'sandbox';
  if (isProduction(env) && driver === 'sandbox') {
    throw new Error('MMG_DRIVER=sandbox is forbidden in production');
  }
  switch (driver) {
    case 'sandbox':
      return new SandboxMmgProvider();
    case 'live': {
      const cfg = readLiveMmgConfig(env);
      if (isProduction(env) && /mmgtest|\buat\b|sandbox/i.test(cfg.baseUrl)) {
        throw new Error('A non-UAT MMG_API_URL is required in production');
      }
      return new LiveMmgProvider(cfg);
    }
    default:
      throw new Error(`Unknown MMG_DRIVER: ${driver}`);
  }
}

/** Driver selection is config, not code. Defaults to the sandbox. */
export function getMmgProvider(): MmgMerchantProvider {
  const driver = process.env['MMG_DRIVER'] ?? 'sandbox';
  if (isProduction() && driver === 'sandbox') {
    throw new Error('MMG_DRIVER=sandbox is forbidden in production');
  }
  switch (driver) {
    case 'sandbox':
      return new SandboxMmgProvider();
    case 'live': {
      const cfg = readLiveMmgConfig(process.env);
      if (process.env['MMG_REFERENCE_ROUNDTRIP_VERIFIED'] !== '1') {
        throw new Error(
          'MMG_DRIVER=live requires MMG_REFERENCE_ROUNDTRIP_VERIFIED=1 after sandbox UAT proves ' +
          'x-wss-correlationid -> lookup metadata.description and history external_id round-trip',
        );
      }
      if (isProduction() && /mmgtest|\buat\b|sandbox/i.test(cfg.baseUrl)) {
        throw new Error('A non-UAT MMG_API_URL is required in production');
      }
      return new LiveMmgProvider(cfg);
    }
    default:
      throw new Error(`Unknown MMG_DRIVER: ${driver}`);
  }
}
