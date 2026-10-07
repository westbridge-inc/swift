import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { isProduction } from '../../utils/runtime-mode';
import { currencyInfo, isKnownCurrency } from '../../utils/currency-amount';
import {
  assertBinding,
  rawDigest,
  type CardChargeOutcome,
  COMPLETION_CLAIM_WAIT_MS,
  type CardCompletionEvidence,
  type CardRailBinding,
  type CardRailEnvironment,
  type CardRailProvider,
  type CardRefundOutcome,
  type CardReturnObservation,
  type CardSessionOutcome,
  type CompletionClaim,
  type CreateCardSessionOutcome,
} from './card-provider';

// ---------------------------------------------------------------------------
// [PT-4] The card provider for real cards: PowerTranz, built ONLY from
// PowerTranz's own "Ecommerce API Guide v2.7 — Simplified 3DS Integration"
// (19 Sep 2023). Every path, field and code below cites its section ("sec.").
// Nothing here comes from a third-party SDK, plugin or forum.
//
// The flow (sec. 2.1, 2.2, Appendix 2), for a Pay now of the weekly fee:
//   1. createSession: a Sale with ThreeDSecure true and the hosted payment
//      page (HostedPage PageSet/PageName) -> IsoResponseCode "SP4",
//      RedirectData (a self-posting form) and an SpiToken (sec. 2.2 1.3-1.4,
//      7.2). Swift keeps both server-side; the partner gets Swift's own page,
//      which shows RedirectData inside an iframe (sec. 2.2 1.5, Appendix 2).
//      The card is typed ONLY on the provider's hosted page: no card number,
//      security code or PIN ever reaches Swift [C1].
//   2. The bank's 3-D Secure check runs in that iframe; the result comes back
//      THROUGH THE BROWSER to MerchantResponseUrl, Swift's public return (sec.
//      2.2 1.6). The guide gives the merchant no other channel for it before
//      completion, no signature on it, and no inquiry call (sec. 3 lists
//      none). So it is NEVER trusted: it is recorded as an observation and
//      may only STOP Swift from completing (a result that is not 3D0 with Y/A,
//      or that names another page) — it can never start money, mark anything
//      paid, or change the session [C5].
//   3. confirm: the merchant completes with POST /spi/payment and the SpiToken
//      (sec. 2.2 1.7, 7.3). Before that call "there has been no financial
//      authorization and no funds have been held" (sec. 7.3), and PowerTranz
//      itself refuses a completion whose authentication was N or R (sec. 8.3).
//      The answer to that server-to-server call is the ONLY money truth, and
//      Swift books it only when it is Approved with IsoResponseCode "00" for
//      THIS transaction AND its OWN 3-D Secure fields (RiskManagement.
//      ThreeDSecure, listed in sec. 6) show the payment
//      was authenticated (AuthenticationStatus Y or A, sec. 8.3; not a
//      failed / non-3DS ECI, sec. 8.4). An approval without that proof is
//      unknown: a person looks, nothing is booked, nothing is dropped. Swift
//      sends the completion at most ONCE per page (an atomic claim), and never
//      repeats it blindly: the guide documents no inquiry call and a
//      "Duplicate call received" error (Appendix 1, 787).
//   4. A Sale settles automatically (sec. 2.2 1.9, 7.4). Refund (sec. 5.2,
//      7.5) and void (sec. 5.2, 7.6) take the ORIGINAL TransactionIdentifier.
//
// What the guide does NOT document, so this provider does not do it:
//   - charging a saved card without the cardholder present: a token charge
//     still needs the browser for 3-D Secure (sec. 7.8). So `savesCards` is
//     false, no ENROLL page is made, and an off-session charge answers
//     requires_action (no penalty, "Confirm your card") without any call;
//   - a card's last 4 digits or expiry in any response (sec. 6);
//   - a transaction inquiry / retrieve call (sec. 3 lists none).
// Any answer the guide does not document is `unknown`, never success.
//
// Secrets (sec. 4 headers) come from the secrets store through the process
// environment and are never logged, echoed or put in an error message.
// ---------------------------------------------------------------------------

export const POWERTRANZ_PROVIDER = 'powertranz';
/** sec. 2.1 diagram ("base url"), sec. 2.3: the staging API root. Production's is "TBD — provided to merchant once
 *  staging tests are validated" (sec. 2.3), so production always names its own. */
export const POWERTRANZ_SANDBOX_ROOT = 'https://staging.ptranz.com';

/** sec. 3 endpoint table: <API Root>/api/... */
const PATH = {
  alive: '/api/alive',          // sec. 3: GET, non-financial
  sale: '/api/spi/sale',        // sec. 3; sec. 7.2 HPP example
  riskMgmt: '/api/spi/riskmgmt', // sec. 3: non-financial
  payment: '/api/spi/payment',  // sec. 3; sec. 7.3
  refund: '/api/refund',        // sec. 3; sec. 7.5
  void: '/api/void',            // sec. 3; sec. 7.6
} as const;

const REQUEST_TIMEOUT_MS = 15_000;
/** The completion goes on to the issuing bank (sec. 2.2 1.7): give it longer. */
const COMPLETION_TIMEOUT_MS = 30_000;
// [CARDS S2] A claimed completion is answering until its own deadline plus a
// margin to record the answer (card-provider.ts); never shorter than the call.
if (COMPLETION_CLAIM_WAIT_MS < COMPLETION_TIMEOUT_MS + 5_000) throw new Error('COMPLETION_CLAIM_WAIT_MS is shorter than the completion deadline');
/** sec. 2.2 1.7: "The payment completion needs to be sent within 5 minutes." */
export const SPI_TOKEN_LIFETIME_MS = 5 * 60_000;
/** A page's facts outlive it long enough for any reconciliation (as the simulator's). */
const RECORD_RETAIN_MS = 30 * 24 * 60 * 60_000;

/** ISO 4217 numeric codes (sec. 5.1 CurrencyCode "Must use numeric currency code (ISO 4217)"). */
export const CURRENCY_NUMERIC: Readonly<Record<string, string>> = {
  GYD: '328', USD: '840', TTD: '780', JMD: '388', BBD: '052', XCD: '951',
};
const CURRENCY_ALPHA: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(CURRENCY_NUMERIC).map(([a, n]) => [n, a]));

/** sec. 5.1 ExtendedData.ThreeDSecure.ChallengeWindowSize: 5 = 100% (the page fills the phone or the card frame). */
const CHALLENGE_WINDOW_FULL = 5;
/** sec. 5.1 ChallengeIndicator 01 = no preference (the issuer decides, sec. 9.3). */
const CHALLENGE_NO_PREFERENCE = '01';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PowerTranzConfig {
  /** Swift's label for the merchant account tokens and sessions are bound to [C2]. */
  account: string;
  environment: CardRailEnvironment;
  /** The <API Root> of sec. 3, with no path: https://staging.ptranz.com in the sandbox. */
  apiRoot: string;
  /** sec. 4 PowerTranz-PowerTranzId (M, AN 25). */
  powerTranzId: string;
  /** sec. 4 PowerTranz-PowerTranzPassword (M, AN 100). */
  password: string;
  /** sec. 4 PowerTranz-GatewayKey (C, GUID 36): "Do not send until value is provided by PowerTranz". */
  gatewayKey?: string;
  /** sec. 5.1 ExtendedData.HostedPage.PageSet / PageName (AN 50 each; portal pages carry the "PTZ/" prefix). */
  pageSet: string;
  pageName: string;
  /** Swift's public API origin: its hosted card page and MerchantResponseUrl live there. */
  publicBaseUrl: string;
}

const ACCOUNT_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The environment names this provider reads (the setup tool asks for exactly these). */
export const POWERTRANZ_ENV = {
  secrets: ['POWERTRANZ_ID', 'POWERTRANZ_PASSWORD', 'POWERTRANZ_GATEWAY_KEY'],
  settings: ['POWERTRANZ_API_URL', 'POWERTRANZ_PAGE_SET', 'POWERTRANZ_PAGE_NAME'],
} as const;

/** A configuration error names the setting, never its value. */
export class PowerTranzConfigError extends Error {
  override readonly name = 'PowerTranzConfigError';
}

function httpsOrigin(raw: string, what: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PowerTranzConfigError(`${what} must be an https:// origin`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new PowerTranzConfigError(`${what} must be a bare https:// origin (no path, query or credentials)`);
  }
  return url.origin;
}

/** Looks like a test system: never acceptable for live money. */
const TEST_HOST = /staging|sandbox|test|uat|dev\.|localhost/i;
/** [Review S4] The guide's API lives under ptranz.com (sec. 2.3: staging.ptranz.com, production <TBD>.ptranz.com). */
const PTRANZ_HOST = /^(?:[a-z0-9-]+\.)*ptranz\.com$/i;

export function powerTranzConfigFromEnv(env: Record<string, string | undefined> = process.env): PowerTranzConfig {
  const environment = env['CARD_RAIL_ENVIRONMENT'];
  if (environment !== 'sandbox' && environment !== 'live') {
    throw new PowerTranzConfigError('CARD_RAIL_ENVIRONMENT must be sandbox or live for the card provider');
  }
  if (isProduction(env) && environment !== 'live') {
    throw new PowerTranzConfigError('Production takes real cards only: CARD_RAIL_ENVIRONMENT must be live');
  }
  // [Review S3] Live cards run only on the production server: a test server
  // never charges real cards, whatever it is told.
  if (environment === 'live' && !isProduction(env)) {
    throw new PowerTranzConfigError('Live cards run only on the production server: CARD_RAIL_ENVIRONMENT must be sandbox here');
  }
  const account = env['CARD_RAIL_ACCOUNT'] ?? '';
  if (!ACCOUNT_LABEL.test(account)) {
    throw new PowerTranzConfigError('CARD_RAIL_ACCOUNT must be a short label (letters, digits, dot, dash, underscore; at most 64)');
  }
  const rawRoot = env['POWERTRANZ_API_URL'] || (environment === 'sandbox' ? POWERTRANZ_SANDBOX_ROOT : '');
  if (!rawRoot) throw new PowerTranzConfigError('POWERTRANZ_API_URL is required for live cards (the guide gives production its own address, sec. 2.3)');
  const apiRoot = httpsOrigin(rawRoot, 'POWERTRANZ_API_URL');
  if (!PTRANZ_HOST.test(new URL(apiRoot).hostname)) {
    throw new PowerTranzConfigError('POWERTRANZ_API_URL must be the card provider\'s own address (a ptranz.com host, sec. 2.3)');
  }
  if (environment === 'live' && TEST_HOST.test(apiRoot)) {
    throw new PowerTranzConfigError('POWERTRANZ_API_URL points at a test system, but CARD_RAIL_ENVIRONMENT is live');
  }
  if (environment === 'sandbox' && !TEST_HOST.test(apiRoot)) {
    throw new PowerTranzConfigError('CARD_RAIL_ENVIRONMENT is sandbox, but POWERTRANZ_API_URL is not a test system');
  }
  const powerTranzId = env['POWERTRANZ_ID'] ?? '';
  if (powerTranzId.length < 1 || powerTranzId.length > 25) throw new PowerTranzConfigError('POWERTRANZ_ID is missing or longer than 25 characters (sec. 4)');
  const password = env['POWERTRANZ_PASSWORD'] ?? '';
  if (password.length < 1 || password.length > 100) throw new PowerTranzConfigError('POWERTRANZ_PASSWORD is missing or longer than 100 characters (sec. 4)');
  const gatewayKey = env['POWERTRANZ_GATEWAY_KEY'] || undefined;
  if (gatewayKey !== undefined && !GUID.test(gatewayKey)) throw new PowerTranzConfigError('POWERTRANZ_GATEWAY_KEY must be the GUID PowerTranz provided (sec. 4), or unset');
  const pageSet = env['POWERTRANZ_PAGE_SET'] ?? '';
  const pageName = env['POWERTRANZ_PAGE_NAME'] ?? '';
  if (pageSet.length < 1 || pageSet.length > 50 || pageName.length < 1 || pageName.length > 50) {
    throw new PowerTranzConfigError('POWERTRANZ_PAGE_SET and POWERTRANZ_PAGE_NAME are required (sec. 5.1, at most 50 characters): cards are typed only on the hosted page');
  }
  const publicBaseUrl = httpsOrigin(env['API_PUBLIC_URL'] ?? '', 'API_PUBLIC_URL (where the bank sends the browser back)');
  return { account, environment, apiRoot, powerTranzId, password, ...(gatewayKey ? { gatewayKey } : {}), pageSet, pageName, publicBaseUrl };
}

// ---------------------------------------------------------------------------
// Pure readers (exported for the contract tests)
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Major units for TotalAmount (sec. 5.1 DEC 18,3), from Swift's minor units. */
export function totalAmountOf(amountMinor: number, currencyCode: string): number {
  const exponent = currencyInfo(currencyCode).exponent;
  return amountMinor / 10 ** exponent;
}

/** Minor units from a TotalAmount (sec. 6 DEC 18,3) — null unless it is exact in the currency's minor unit. */
export function minorOfTotalAmount(value: unknown, currencyCode: string): number | null {
  if (!isKnownCurrency(currencyCode)) return null;
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  const m = /^(\d{1,15})(?:\.(\d{1,3}))?$/.exec(text);
  if (!m) return null;
  const exponent = currencyInfo(currencyCode).exponent;
  const fraction = (m[2] ?? '').padEnd(3, '0');
  if (fraction.slice(exponent).replace(/0/g, '') !== '') return null; // finer than the currency's minor unit
  const minor = Number(m[1]) * 10 ** exponent + Number(fraction.slice(0, exponent) || '0');
  return Number.isSafeInteger(minor) ? minor : null;
}

/** sec. 6 CurrencyCode is numeric; Swift speaks ISO alpha. Unknown numeric -> null. */
export function alphaOfCurrency(value: unknown): string | null {
  const code = typeof value === 'number' ? String(value).padStart(3, '0') : str(value)?.trim();
  return code ? CURRENCY_ALPHA[code] ?? null : null;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** The fields a payload may carry that are tokens or personal data: digested, never kept in a digest's preimage in the clear. */
const BLINDED = new Set(['SpiToken', 'PanToken', 'RedirectData', 'BillingAddress', 'ShippingAddress', 'CardholderName', 'Cavv', 'Xid', 'FcDetails']);
/** The sha256 of a provider payload with its tokens and personal fields replaced by their own digests. */
export function blindedDigest(payload: unknown): string {
  const blind = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(blind);
    if (isObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, BLINDED.has(k) ? sha256(JSON.stringify(v ?? null)) : blind(v)]));
    }
    return value;
  };
  return rawDigest(blind(payload));
}

/**
 * The 3-D Secure authentication result the browser brought back (sec. 2.2 1.6,
 * Appendix 2: the iframe posts it "as Json"). It may arrive as top-level
 * fields, or as one field holding the JSON text; nested objects arrive as
 * JSON text (the return route flattens them). Null when nothing in the return
 * reads as an authentication response.
 */
export function authenticationResultOf(params: Readonly<Record<string, string>>): Record<string, unknown> | null {
  const parse = (text: string): Record<string, unknown> | null => {
    try {
      const value: unknown = JSON.parse(text);
      return isObject(value) ? value : null;
    } catch {
      return null;
    }
  };
  const looksLikeResult = (o: Record<string, unknown>) => 'IsoResponseCode' in o || 'SpiToken' in o || 'RiskManagement' in o;
  const top: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) top[k] = v;
  if (looksLikeResult(top)) {
    const rm = str(top['RiskManagement']);
    return { ...top, ...(rm !== undefined ? { RiskManagement: parse(rm) ?? rm } : {}) };
  }
  const nested = Object.values(params).map(parse).filter((o): o is Record<string, unknown> => o !== null && looksLikeResult(o));
  return nested.length === 1 ? nested[0]! : null;
}

export type AuthenticationDecision =
  | { proceed: true; note: string }
  | { proceed: false; note: string };

/**
 * Swift's decision on the browser's authentication result (sec. 2.2 1.7: "the
 * merchant determines if they want to proceed with payment completion"):
 *   - proceed ONLY when the 3-D Secure check completed (ResponseCode "3D0",
 *     sec. 8.1) with AuthenticationStatus Y (verified) or A (attempted) (sec. 8.3);
 *   - never when it is N or R (sec. 8.3: "payment completion will not be
 *     permitted"), U (could not be performed), 3D1 (3-D Secure not available
 *     for the card: sec. 9.1 lets the merchant choose; Swift declines — no
 *     liability shift without authentication), 3D3 (error), or anything else;
 *   - never when the result names another page: its SpiToken, transaction or
 *     order differ from the ones Swift holds.
 * The browser's result is untrusted (no signature, no server-side copy,
 * sec. 2.2 1.6, sec. 3): this decision can only make Swift DECLINE. A
 * "proceed" grants nothing — it lets Swift ask PowerTranz, server to server,
 * whose completion answer (with its own 3-D Secure proof) is the money truth.
 */
export function authenticationDecision(
  result: Record<string, unknown> | null,
  held: { spiToken?: string; txnId: string; orderId: string },
): AuthenticationDecision {
  if (!result) return { proceed: false, note: 'NO_AUTHENTICATION_RESULT' };
  const echoedToken = str(result['SpiToken']);
  if (echoedToken !== undefined && held.spiToken !== undefined && echoedToken !== held.spiToken) return { proceed: false, note: 'OTHER_PAGE_TOKEN' };
  const echoedTxn = str(result['TransactionIdentifier']);
  if (echoedTxn !== undefined && echoedTxn.toLowerCase() !== held.txnId.toLowerCase()) return { proceed: false, note: 'OTHER_TRANSACTION' };
  const echoedOrder = str(result['OrderIdentifier']);
  if (echoedOrder !== undefined && echoedOrder.trim() !== held.orderId) return { proceed: false, note: 'OTHER_ORDER' };
  const rm = isObject(result['RiskManagement']) ? result['RiskManagement'] : null;
  const tds = rm && isObject(rm['ThreeDSecure']) ? rm['ThreeDSecure'] : null;
  const code = str(tds?.['ResponseCode']) ?? str(result['IsoResponseCode']);
  const status = str(tds?.['AuthenticationStatus']);
  if (code === '3D0' && (status === 'Y' || status === 'A')) return { proceed: true, note: `3D0_${status}` };
  return { proceed: false, note: `NOT_AUTHENTICATED_${code ?? 'NONE'}_${status ?? 'NONE'}` };
}

/** sec. 8.4: ECI values that mean 3-D Secure failed or was not used (Visa/Amex 07; Mastercard 00; NPA N0). */
const UNAUTHENTICATED_ECI = new Set(['07', '00', 'N0']);

/**
 * The 3-D Secure proof carried by PowerTranz's OWN server-side answer (sec. 6:
 * RiskManagement.ThreeDSecure; the completion sample omits it): authenticated
 * only when AuthenticationStatus is Y or A (sec. 8.3) and the ECI, when given,
 * is not a failed / non-3DS value (sec. 8.4). Nothing the browser sent counts here.
 */
export function serverAuthentication(json: Record<string, unknown>): { authenticated: boolean; note: string } {
  const rm = isObject(json['RiskManagement']) ? json['RiskManagement'] : null;
  const tds = rm && isObject(rm['ThreeDSecure']) ? rm['ThreeDSecure'] : null;
  const status = str(tds?.['AuthenticationStatus']);
  // [Review S4] An ECI may arrive as a number (5) or text ("05").
  const rawEci = tds?.['Eci'];
  const eci = typeof rawEci === 'number' && Number.isInteger(rawEci) ? String(rawEci).padStart(2, '0') : str(rawEci)?.trim();
  if (status !== 'Y' && status !== 'A') return { authenticated: false, note: `SERVER_3DS_${status ?? 'ABSENT'}` };
  if (eci !== undefined && UNAUTHENTICATED_ECI.has(eci)) return { authenticated: false, note: `SERVER_ECI_${eci}` };
  return { authenticated: true, note: `SERVER_3DS_${status}` };
}

/** Appendix 1 numeric response codes that say an earlier identical call may have been taken. */
const DUPLICATE_CODES = new Set(['787', '788', '387']);
/** Payment ISO codes (Appendix 1) that do not say the bank declined: the money may or may not have moved. */
const AMBIGUOUS_ISO = new Set(['06', '09', '68', '91', '94', '96', '98', '99']);

function errorCodes(json: Record<string, unknown>): string[] {
  const errors = json['Errors'];
  if (!Array.isArray(errors)) return [];
  return errors.filter(isObject).map((e) => String(e['Code'] ?? '')).filter(Boolean);
}

export type CompletionReading =
  | { status: 'succeeded'; amountMinor: number; currencyCode: string; completionEvidence: CardCompletionEvidence }
  | { status: 'failed'; reason: string }
  /** [Review S2-2] Money may have been taken (an approval, or an answer that
   *  may be one) and Swift cannot book it: it is voided at once (sec. 5.2,
   *  7.6 — before the Sale settles, sec. 7.4), or held for a person. */
  | { status: 'unbookable'; reason: string };

/** What Swift asked for, to check an approval against. */
export interface HeldCompletion { txnId: string; orderId: string; amountMinor: number; currencyCode: string }

/**
 * The completion answer (sec. 6, 7.3, Appendix 1), read for money:
 *   - succeeded ONLY on Approved true AND IsoResponseCode "00" AND naming THIS
 *     page (its TransactionIdentifier — ours or as the original —, its
 *     OrderIdentifier SWIFT-<session>, and TransactionType 2, a Sale, sec. 6)
 *     AND its own 3-D Secure proof (serverAuthentication) AND exactly the
 *     amount and currency Swift asked for;
 *   - any other approval, a contradictory answer (Approved false with "00"),
 *     a possible duplicate (787 / 788 / 387), a code that is not the bank's
 *     answer (timeouts, system errors), or no Approved flag at all: money may
 *     have been taken that cannot be booked — unbookable (void it);
 *   - Approved false with any other code: the bank declined — failed.
 */
export function readCompletion(json: unknown, held: HeldCompletion): CompletionReading {
  const unbookable = (reason: string): CompletionReading => ({ status: 'unbookable', reason });
  if (!isObject(json)) return unbookable('COMPLETION_UNREADABLE');
  const approved = json['Approved'];
  const iso = str(json['IsoResponseCode']) ?? '';
  const codes = errorCodes(json);
  if (approved === true) {
    if (iso !== '00') return unbookable(`APPROVED_WITH_${iso || 'NO_CODE'}`);
    const mine = held.txnId.toLowerCase();
    const txn = str(json['TransactionIdentifier'])?.toLowerCase();
    const original = str(json['OriginalTrxnIdentifier'])?.toLowerCase();
    if (txn !== mine && original !== mine) return unbookable('APPROVAL_DOES_NOT_NAME_THIS_TRANSACTION');
    if (str(json['OrderIdentifier'])?.trim() !== held.orderId) return unbookable('APPROVAL_DOES_NOT_NAME_THIS_ORDER');
    if (String(json['TransactionType'] ?? '') !== '2') return unbookable('APPROVAL_IS_NOT_A_SALE');
    const auth = serverAuthentication(json);
    if (!auth.authenticated) return unbookable(`APPROVED_UNAUTHENTICATED_${auth.note}`);
    const currencyCode = alphaOfCurrency(json['CurrencyCode']);
    const amountMinor = currencyCode ? minorOfTotalAmount(json['TotalAmount'], currencyCode) : null;
    if (!currencyCode || amountMinor === null) return unbookable('APPROVED_AMOUNT_UNREADABLE');
    if (amountMinor !== held.amountMinor || currencyCode !== held.currencyCode) return unbookable('APPROVED_AMOUNT_MISMATCH');
    const tds = (json['RiskManagement'] as { ThreeDSecure: Record<string, unknown> }).ThreeDSecure;
    const eci = typeof tds['Eci'] === 'number' ? String(tds['Eci']).padStart(2, '0') : str(tds['Eci']);
    return { status: 'succeeded', amountMinor, currencyCode, completionEvidence: {
      Approved: true, IsoResponseCode: '00', TransactionType: 2,
      TransactionIdentifier: held.txnId, OrderIdentifier: held.orderId,
      TotalAmount: totalAmountOf(amountMinor, currencyCode), CurrencyCode: CURRENCY_NUMERIC[currencyCode]!,
      RiskManagement: { ThreeDSecure: { AuthenticationStatus: String(tds['AuthenticationStatus']), ...(eci === undefined ? {} : { Eci: eci }) } },
    } };
  }
  if (approved === false) {
    if (iso === '00') return unbookable('DECLINED_WITH_APPROVAL_CODE');
    if (codes.some((c) => DUPLICATE_CODES.has(c))) return unbookable(`POSSIBLE_DUPLICATE_${codes.join('_')}`);
    if (AMBIGUOUS_ISO.has(iso)) return unbookable(`NOT_THE_BANKS_ANSWER_${iso}`);
    return { status: 'failed', reason: `DECLINED_${iso || 'NO_CODE'}${codes.length ? `_${codes.join('_')}` : ''}` };
  }
  return unbookable('NO_APPROVED_FLAG');
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

type HttpAnswer =
  | { shape: 'json'; status: number; json: unknown }
  | { shape: 'http'; status: number }
  | { shape: 'transport'; reason: 'timeout' | 'network' };

export interface PowerTranzDeps {
  /** The HTTP client (tests pass a fake that speaks the guide's examples). */
  fetch?: typeof fetch;
  now?: () => Date;
  /** Redis namespace: `ptz:` (default) or `ptz:<name>:` for a test run. */
  keyPrefix?: string;
}

const KEY_PREFIX_SHAPE = /^ptz:(?:[A-Za-z0-9_-]{1,64}:)?$/;
const REF_SHAPE = /^ptz_[0-9a-f]{24}$/;

export interface PowerTranzHostedPage {
  redirectData: string;
  amountMinor: number;
  currencyCode: string;
  expired: boolean;
  finished: boolean;
  sandbox: boolean;
}

export class PowerTranzCardRailProvider implements CardRailProvider {
  readonly simulator = false;
  /** The guide documents no charge without the cardholder (sec. 7.8) and no last 4 / expiry (sec. 6). */
  readonly savesCards = false;
  readonly binding: CardRailBinding;
  readonly keyPrefix: string;
  private readonly http: typeof fetch;
  private readonly now: () => Date;
  private readonly key = {
    session: (ref: string) => `${this.keyPrefix}s:${ref}`,
    refund: (idempotencyKey: string) => `${this.keyPrefix}r:${this.binding.account}:${idempotencyKey}`,
  };

  constructor(private readonly redis: Redis, private readonly config: PowerTranzConfig, deps: PowerTranzDeps = {}) {
    this.binding = { provider: POWERTRANZ_PROVIDER, environment: config.environment, account: config.account };
    this.http = deps.fetch ?? fetch;
    this.now = deps.now ?? (() => new Date());
    const keyPrefix = deps.keyPrefix ?? 'ptz:';
    if (!KEY_PREFIX_SHAPE.test(keyPrefix)) throw new PowerTranzConfigError('The card provider key prefix is ptz: or ptz:<name>:');
    this.keyPrefix = keyPrefix;
  }

  /** Swift's page that hosts the bank's card form (served by card-rail.routes.ts). */
  hostedUrlFor(providerSessionRef: string): string {
    return `${this.config.publicBaseUrl}/api/v1/billing/card/pay/${providerSessionRef}`;
  }

  // -------------------------------------------------------------------------
  // HTTP (sec. 4: JSON over HTTPS; credentials in headers; never logged)
  // -------------------------------------------------------------------------

  private headers(withCredentials: boolean): Record<string, string> {
    return {
      'content-type': 'application/json; charset=utf-8',
      accept: 'application/json',
      ...(withCredentials ? {
        'PowerTranz-PowerTranzId': this.config.powerTranzId,
        'PowerTranz-PowerTranzPassword': this.config.password,
        ...(this.config.gatewayKey ? { 'PowerTranz-GatewayKey': this.config.gatewayKey } : {}),
      } : {}),
    };
  }

  private async call(path: string, init: { method: 'GET' | 'POST'; body?: string; headers: Record<string, string>; timeoutMs?: number }): Promise<HttpAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS);
    try {
      const res = await this.http(`${this.config.apiRoot}${path}`, {
        method: init.method, headers: init.headers, signal: controller.signal, redirect: 'error',
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
      const text = await res.text();
      try {
        return { shape: 'json', status: res.status, json: text ? JSON.parse(text) : null };
      } catch {
        return { shape: 'http', status: res.status };
      }
    } catch (err) {
      return { shape: 'transport', reason: (err as Error)?.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // createSession — sec. 2.2 1.3-1.4, 5.1, 7.2
  // -------------------------------------------------------------------------

  async createSession(input: Parameters<CardRailProvider['createSession']>[0]): Promise<CreateCardSessionOutcome> {
    assertBinding(this.binding, input.binding);
    // Every "no page" below is definitive: without Swift's completion call no
    // money can move (sec. 7.3), and the SpiToken it would need never reached Swift.
    const refuse = (reason: string): CreateCardSessionOutcome => ({ status: 'failed', reason, rawSha256: rawDigest({ refused: reason }) });
    if (input.purpose !== 'PAY_NOW') return refuse('SAVING_CARDS_NOT_OFFERED');
    const currencyCode = input.currencyCode ?? '';
    const numeric = CURRENCY_NUMERIC[currencyCode];
    if (!numeric || !isKnownCurrency(currencyCode)) return refuse('CURRENCY_NOT_SUPPORTED');
    if (!Number.isSafeInteger(input.amountMinor) || (input.amountMinor ?? 0) <= 0) return refuse('AMOUNT_INVALID');
    // sec. 5.1 MerchantResponseURL: M, AN 255.
    if (!input.returnUrl.startsWith('https://') || input.returnUrl.length > 255) return refuse('RETURN_URL_INVALID');

    const providerSessionRef = `ptz_${randomBytes(12).toString('hex')}`;
    const txnId = randomUUID(); // sec. 5.1 TransactionIdentifier (M, GUID); sec. 9.2 unique
    const orderId = `SWIFT-${input.sessionRef}`; // sec. 5.1 OrderIdentifier (M, AN 255); sec. 9.2 unique per approved transaction
    const body = {
      TransactionIdentifier: txnId,
      TotalAmount: totalAmountOf(input.amountMinor!, currencyCode), // sec. 5.1 M, DEC 18,3
      CurrencyCode: numeric,                                        // sec. 5.1 M, ISO 4217 numeric
      ThreeDSecure: true,                                           // sec. 5.1 M; sec. 2: a 3-D Secure request
      Source: {},                                                   // sec. 7.2: with the hosted page the card is typed there, never here [C1]
      OrderIdentifier: orderId,
      BillingAddress: {},                                           // sec. 5.1 nested object; the hosted page collects the cardholder's details
      AddressMatch: false,                                          // sec. 5.1 O, as sec. 7.2
      ExtendedData: {                                               // sec. 5.1 M
        ThreeDSecure: { ChallengeWindowSize: CHALLENGE_WINDOW_FULL, ChallengeIndicator: CHALLENGE_NO_PREFERENCE },
        MerchantResponseUrl: input.returnUrl,                       // sec. 5.1 M; Appendix 2 step 2
        HostedPage: { PageSet: this.config.pageSet, PageName: this.config.pageName }, // sec. 5.1, 7.2
      },
    };
    const answer = await this.call(PATH.sale, { method: 'POST', headers: this.headers(true), body: JSON.stringify(body) });
    if (answer.shape !== 'json' || !isObject(answer.json)) {
      return { status: 'failed', reason: answer.shape === 'transport' ? `NO_ANSWER_${answer.reason}` : `HTTP_${answer.status}`, rawSha256: rawDigest({ createFailed: answer.shape, status: 'status' in answer ? answer.status : null }) };
    }
    const json = answer.json;
    const rawSha256 = blindedDigest(json);
    const redirectData = str(json['RedirectData']);
    const spiToken = str(json['SpiToken']);
    const echoed = str(json['TransactionIdentifier']);
    // sec. 2.2 1.4: "An IsoResponseCode of SP4 is returned if the request passes basic validation."
    if (str(json['IsoResponseCode']) !== 'SP4' || !redirectData || !spiToken || (echoed !== undefined && echoed.toLowerCase() !== txnId.toLowerCase())) {
      return { status: 'failed', reason: `NOT_PREPROCESSED_${str(json['IsoResponseCode']) ?? 'NO_CODE'}${errorCodes(json).length ? `_${errorCodes(json).join('_')}` : ''}`, rawSha256 };
    }
    const k = this.key.session(providerSessionRef);
    try {
      await this.redis.hset(k, {
        sessionRef: input.sessionRef, purpose: input.purpose, txnId, orderId,
        amountMinor: String(input.amountMinor), currencyCode,
        expiresAtMs: String(input.expiresAt.getTime()), createdAtMs: String(this.now().getTime()),
        spiToken, redirectData,
      });
      await this.redis.pexpireat(k, input.expiresAt.getTime() + RECORD_RETAIN_MS);
    } catch {
      // [Review S4] The page could not be kept: its SpiToken is gone, so Swift
      // can never send the completion — and until it does, nothing is
      // authorized and no funds are held (sec. 7.3). Definitively no page.
      await this.redis.del(k).catch(() => 0);
      return { status: 'failed', reason: 'PAGE_NOT_KEPT', rawSha256 };
    }
    return { status: 'succeeded', providerSessionRef, hostedUrl: this.hostedUrlFor(providerSessionRef), rawSha256 };
  }

  /** What Swift's hosted page shows for one session: the bank's form and the server's price. Null when unknown. */
  async hostedPageFor(providerSessionRef: string): Promise<PowerTranzHostedPage | null> {
    if (!REF_SHAPE.test(providerSessionRef)) return null;
    const rec = await this.redis.hgetall(this.key.session(providerSessionRef));
    if (!rec['sessionRef'] || rec['purpose'] !== 'PAY_NOW') return null;
    const now = this.now().getTime();
    return {
      redirectData: rec['redirectData'] ?? '',
      amountMinor: Number(rec['amountMinor']),
      currencyCode: rec['currencyCode'] ?? '',
      expired: now > Number(rec['expiresAtMs']),
      finished: Boolean(rec['returnedAtMs'] || rec['completion']) || !rec['redirectData'],
      sandbox: this.binding.environment === 'sandbox',
    };
  }

  // -------------------------------------------------------------------------
  // The browser comes back — sec. 2.2 1.6 (not a financial result)
  // -------------------------------------------------------------------------

  parseReturn(params: Readonly<Record<string, string>>): CardReturnObservation {
    const result = authenticationResultOf(params);
    const rawSha256 = blindedDigest(result ?? params);
    if (!result) return { rawSha256, claimedStatus: 'invalid' };
    // Pure: no held facts here, so the echo checks wait for noteReturn.
    const decision = authenticationDecision(result, { txnId: str(result['TransactionIdentifier']) ?? '', orderId: str(result['OrderIdentifier'])?.trim() ?? '' });
    return { rawSha256, claimedStatus: decision.proceed ? 'pending' : 'failed' };
  }

  /**
   * [PT-4] Called by the service for the session's FIRST VALID return only
   * (the one-use state already checked). Keeps Swift's completion decision
   * beside the page's facts; the first decision stands. Moves no money.
   */
  async noteReturn(input: { binding: CardRailBinding; providerSessionRef: string; params: Readonly<Record<string, string>> }): Promise<void> {
    assertBinding(this.binding, input.binding);
    const k = this.key.session(input.providerSessionRef);
    const rec = await this.redis.hgetall(k);
    if (!rec['sessionRef']) return;
    const decision = authenticationDecision(authenticationResultOf(input.params), {
      ...(rec['spiToken'] ? { spiToken: rec['spiToken'] } : {}), txnId: rec['txnId'] ?? '', orderId: rec['orderId'] ?? '',
    });
    await this.redis.eval(NOTE_ONCE, 1, k, String(this.now().getTime()), decision.proceed ? 'proceed' : 'refused', decision.note);
  }

  // -------------------------------------------------------------------------
  // confirm — sec. 2.2 1.7-1.8, 7.3: the completion, at most once
  // -------------------------------------------------------------------------

  async confirm(input: Parameters<CardRailProvider['confirm']>[0]): Promise<CardSessionOutcome> {
    assertBinding(this.binding, input.binding);
    if (input.purpose !== 'PAY_NOW') return { status: 'failed', reason: 'SAVING_CARDS_NOT_OFFERED', rawSha256: rawDigest({ refused: 'enroll' }) };
    const k = this.key.session(input.providerSessionRef);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const rec = await this.redis.hgetall(k);
      const digest = (extra: Record<string, unknown>) => rawDigest({ ref: input.providerSessionRef, ...extra });
      if (!rec['sessionRef']) return { status: 'unknown', reason: 'NO_RECORD_OF_THIS_PAGE', rawSha256: digest({ missing: true }) };
      if (rec['purpose'] !== input.purpose) return { status: 'failed', reason: 'PURPOSE_MISMATCH', rawSha256: digest({ purpose: rec['purpose'] }) };
      if (rec['completion'] === 'done') return this.outcomeOf(rec);
      if (rec['completion'] === 'sending') {
        const claimedAt = Number(rec['completionClaimedAtMs']);
        if (Number.isFinite(claimedAt) && this.now().getTime() <= claimedAt + COMPLETION_CLAIM_WAIT_MS) {
          return { status: 'pending', rawSha256: digest({ completion: 'sending', claimedAt }) };
        }
        // Only past the deadline + persistence margin is an answer lost.
        // Legacy claims without a timestamp are uncertain too; never resend.
        return { status: 'unknown', reason: 'COMPLETION_SENT_ANSWER_LOST', voidable: { providerRef: rec['txnId'] ?? '' }, rawSha256: digest({ completion: 'sending' }) };
      }
      if (rec['completion'] === 'abandoned') return { status: 'failed', reason: rec['abandonReason'] || 'NOT_COMPLETED', rawSha256: digest({ completion: 'abandoned', why: rec['abandonReason'] }) };

      const now = this.now().getTime();
      if (!rec['returnedAtMs']) {
        // The partner has not finished on the bank's page (or the browser never came back).
        if (now <= Number(rec['expiresAtMs'])) return { status: 'pending', rawSha256: digest({ waiting: true }) };
        if (await this.abandon(k, 'PAGE_NOT_FINISHED')) {
          return { status: 'failed', reason: 'PAGE_NOT_FINISHED', rawSha256: digest({ completion: 'abandoned', why: 'PAGE_NOT_FINISHED' }) };
        }
        continue; // another process decided first: read its decision
      }
      // [Review S4] sec. 2.2 1.7: the completion must be sent within 5 minutes,
      // after which the SpiToken is unavailable: never sent late.
      if (now - Number(rec['returnedAtMs']) > SPI_TOKEN_LIFETIME_MS) {
        if (await this.abandon(k, 'SPI_TOKEN_EXPIRED')) return { status: 'failed', reason: 'SPI_TOKEN_EXPIRED', rawSha256: digest({ completion: 'abandoned', why: 'SPI_TOKEN_EXPIRED' }) };
        continue;
      }
      if (rec['authDecision'] !== 'proceed') {
        const why = `NOT_AUTHENTICATED:${rec['authNote'] ?? ''}`;
        if (await this.abandon(k, why)) return { status: 'failed', reason: why, rawSha256: digest({ completion: 'abandoned', why }) };
        continue;
      }
      // Claim the one completion this page may ever have (timestamped [CARDS S2]).
      if (Number(await this.redis.eval(CLAIM_COMPLETION, 1, k, String(now))) !== 1) continue;
      // [CARDS S1] Claim it durably on the session, immediately before asking
      // the bank: finance never closes a session whose completion is claimed.
      let claim: CompletionClaim = 'send';
      try {
        if (input.beforeCompletion) claim = await input.beforeCompletion(rec['txnId'] ?? '');
      } catch (err) {
        // Nothing was sent, and it never will be for this page.
        await this.notSent(k, 'COMPLETION_CLAIM_FAILED');
        throw err;
      }
      if (claim === 'closed') {
        // The session closed first: the completion is never sent; nothing was taken.
        await this.notSent(k, 'SESSION_CLOSED_BEFORE_COMPLETION');
        return { status: 'failed', reason: 'SESSION_CLOSED_BEFORE_COMPLETION', rawSha256: digest({ completion: 'abandoned', why: 'SESSION_CLOSED_BEFORE_COMPLETION' }) };
      }
      // [race audit] The durable claim may have waited on a lock: the five
      // minutes (sec. 2.2 1.7) are checked again right before sending.
      if (claim === 'send' && this.now().getTime() - Number(rec['returnedAtMs']) > SPI_TOKEN_LIFETIME_MS) {
        await this.notSent(k, 'SPI_TOKEN_EXPIRED');
        return { status: 'failed', reason: 'SPI_TOKEN_EXPIRED', rawSha256: digest({ completion: 'abandoned', why: 'SPI_TOKEN_EXPIRED' }) };
      }
      if (claim === 'claimed') {
        // A durable claim already exists (this store lost its own): a completion
        // may already have been sent. Never sent again; voided by the service.
        await this.redis.hset(k, { completion: 'done', result: JSON.stringify({ status: 'unbookable', reason: 'COMPLETION_ALREADY_CLAIMED', rawSha256: digest({ completion: 'not-resent' }) }) });
        await this.redis.hdel(k, 'spiToken', 'redirectData');
        return this.outcomeOf(await this.redis.hgetall(k));
      }
      return this.complete(k, rec);
    }
    return { status: 'unknown', reason: 'COMPLETION_STATE_CHANGING', rawSha256: rawDigest({ ref: input.providerSessionRef, racing: true }) };
  }

  /** [CARDS S1] This process holds the page's completion claim and never sent
   *  it: the page is closed as not completed (the SpiToken is dropped). */
  private async notSent(k: string, why: string): Promise<void> {
    await this.redis.hset(k, { completion: 'abandoned', abandonReason: why });
    await this.redis.hdel(k, 'spiToken', 'redirectData');
  }

  private async abandon(k: string, why: string): Promise<boolean> {
    const claimed = Number(await this.redis.hsetnx(k, 'completion', 'abandoned')) === 1;
    if (claimed) {
      await this.redis.hset(k, 'abandonReason', why);
      await this.redis.hdel(k, 'spiToken', 'redirectData');
    }
    return claimed;
  }

  /** sec. 7.3: POST /spi/payment, the body "simply the SpiToken value and not Json" (the example sends it quoted),
   *  and no PowerTranzId / Password headers. */
  private async complete(k: string, rec: Record<string, string>): Promise<CardSessionOutcome> {
    const spiToken = rec['spiToken'] ?? '';
    const answer = await this.call(PATH.payment, {
      method: 'POST',
      headers: { 'content-type': 'application/json-patch+json', accept: 'application/json, text/plain' },
      body: JSON.stringify(spiToken),
      timeoutMs: COMPLETION_TIMEOUT_MS,
    });
    let reading: CompletionReading;
    let rawSha256: string;
    const held: HeldCompletion = {
      txnId: rec['txnId'] ?? '', orderId: rec['orderId'] ?? '', amountMinor: Number(rec['amountMinor']), currencyCode: rec['currencyCode'] ?? '',
    };
    if (answer.shape === 'json') {
      rawSha256 = blindedDigest(answer.json);
      reading = answer.status >= 500 || answer.status === 408 || answer.status === 429
        ? { status: 'unbookable', reason: `COMPLETION_HTTP_${answer.status}` }
        : answer.status >= 400 && !isObject(answer.json)
          ? { status: 'failed', reason: `HTTP_${answer.status}` }
          : readCompletion(answer.json, held);
    } else if (answer.shape === 'http' && answer.status >= 400 && answer.status < 500 && answer.status !== 408 && answer.status !== 429) {
      rawSha256 = rawDigest({ completionHttp: answer.status });
      reading = { status: 'failed', reason: `HTTP_${answer.status}` };
    } else {
      // No answer, or an answer that cannot be read: the bank may have taken
      // it. Never repeated; recorded so every later read asks for the void.
      rawSha256 = rawDigest({ completion: answer.shape });
      reading = { status: 'unbookable', reason: answer.shape === 'transport' ? `COMPLETION_${answer.reason.toUpperCase()}` : 'COMPLETION_UNREADABLE' };
    }
    await this.redis.hset(k, { completion: 'done', result: JSON.stringify({ ...reading, rawSha256 }), completedAtMs: String(this.now().getTime()) });
    await this.redis.hdel(k, 'spiToken', 'redirectData');
    return this.outcomeOf(await this.redis.hgetall(k));
  }

  private outcomeOf(rec: Record<string, string>): CardSessionOutcome {
    let stored: (CompletionReading & { rawSha256?: string }) | null = null;
    try {
      stored = JSON.parse(rec['result'] ?? 'null') as CompletionReading & { rawSha256?: string };
    } catch {
      stored = null;
    }
    const rawSha256 = stored?.rawSha256 ?? rawDigest({ result: rec['result'] ?? null });
    if (!stored) return { status: 'unknown', reason: 'COMPLETION_RECORD_UNREADABLE', rawSha256 };
    switch (stored.status) {
      case 'succeeded': {
        // Old cached success markers without the provider's proof cannot
        // restore booking authority. Re-validate the stored completion.
        const verified = readCompletion(stored.completionEvidence, {
          txnId: rec['txnId'] ?? '', orderId: rec['orderId'] ?? '', amountMinor: Number(rec['amountMinor']), currencyCode: rec['currencyCode'] ?? '',
        });
        if (verified.status !== 'succeeded') return { status: 'unknown', reason: 'COMPLETION_EVIDENCE_UNVERIFIED', voidable: { providerRef: rec['txnId'] ?? '' }, rawSha256 };
        return { status: 'succeeded', purpose: 'PAY_NOW', providerRef: rec['txnId'] ?? '', amountMinor: verified.amountMinor, currencyCode: verified.currencyCode, completionEvidence: verified.completionEvidence, rawSha256 };
      }
      case 'failed':
        return { status: 'failed', reason: stored.reason, rawSha256 };
      case 'unbookable':
        return { status: 'unknown', reason: stored.reason, voidable: { providerRef: rec['txnId'] ?? '' }, rawSha256 };
      default:
        return { status: 'unknown', reason: (stored as { reason?: string }).reason ?? 'COMPLETION_RECORD_UNREADABLE', rawSha256 };
    }
  }

  // -------------------------------------------------------------------------
  // Off-session — not documented (sec. 7.8), so never attempted
  // -------------------------------------------------------------------------

  async chargeInstrument(input: Parameters<CardRailProvider['chargeInstrument']>[0]): Promise<CardChargeOutcome> {
    assertBinding(this.binding, input.binding);
    // No call is made: a token charge still needs the cardholder's browser for
    // 3-D Secure (sec. 7.8). The partner is asked to confirm with Pay now — no penalty [C4].
    return { status: 'requires_action', reason: 'CARDHOLDER_MUST_CONFIRM', rawSha256: rawDigest({ offSession: 'not-documented' }) };
  }

  async retrieve(input: { binding: CardRailBinding; idempotencyKey: string; providerRef?: string }): Promise<CardChargeOutcome> {
    assertBinding(this.binding, input.binding);
    // chargeInstrument never sends anything, so no off-session instruction exists to look up.
    return { status: 'unknown', reason: 'NO_OFF_SESSION_INSTRUCTION_IS_EVER_SENT', absent: true, rawSha256: rawDigest({ retrieve: input.idempotencyKey }) };
  }

  // -------------------------------------------------------------------------
  // Refund and void — sec. 5.2, 7.5, 7.6; at most one call per key
  // -------------------------------------------------------------------------

  async refund(input: Parameters<CardRailProvider['refund']>[0]): Promise<CardRefundOutcome> {
    assertBinding(this.binding, input.binding);
    if (!CURRENCY_NUMERIC[input.currencyCode] || !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || !GUID.test(input.providerRef)) {
      return { status: 'failed', reason: 'REFUND_REQUEST_INVALID', rawSha256: rawDigest({ refused: 'refund' }) };
    }
    return this.adjust('refund', input.idempotencyKey, {
      Refund: true,                                                      // sec. 5.2: mandatory for refunds, true
      TransactionIdentifier: input.providerRef,                          // sec. 5.2: of the ORIGINAL transaction
      TotalAmount: totalAmountOf(input.amountMinor, input.currencyCode), // sec. 5.2: required for refund
      CurrencyCode: CURRENCY_NUMERIC[input.currencyCode],                // sec. 7.5 example
    }, { ref: input.providerRef, amountMinor: input.amountMinor, currencyCode: input.currencyCode });
  }

  /** sec. 5.2, 7.6: cancel an approved payment before it settles — the whole amount only ("partial voids are not supported"). */
  async voidPayment(input: { binding: CardRailBinding; providerRef: string; idempotencyKey: string }): Promise<CardRefundOutcome> {
    assertBinding(this.binding, input.binding);
    if (!GUID.test(input.providerRef)) return { status: 'failed', reason: 'VOID_REQUEST_INVALID', rawSha256: rawDigest({ refused: 'void' }) };
    return this.adjust('void', input.idempotencyKey, { TransactionIdentifier: input.providerRef }, { ref: input.providerRef });
  }

  /**
   * One void or refund call per key. [Review S2-2 · S3] An approval counts
   * only when it is about THIS transaction: the answer names it (as the
   * original, or as itself — sec. 6 OriginalTrxnIdentifier / sec. 7.6), its
   * TransactionType is a Void (4) or a Refund (5) (sec. 6), and a refund's
   * TotalAmount is the amount asked. Anything else is unknown, never done:
   * a void that "succeeded" closes the payment as not taken.
   */
  private async adjust(
    action: 'refund' | 'void',
    idempotencyKey: string,
    body: Record<string, unknown>,
    expect: { ref: string; amountMinor?: number; currencyCode?: string },
  ): Promise<CardRefundOutcome> {
    const k = this.key.refund(`${action}:${idempotencyKey}`);
    if (Number(await this.redis.hsetnx(k, 'state', 'sending')) !== 1) {
      const rec = await this.redis.hgetall(k);
      if (rec['state'] === 'done' && rec['result']) return JSON.parse(rec['result']) as CardRefundOutcome;
      // Sent once already and its answer never arrived: never sent again blindly (no inquiry call, sec. 3).
      return { status: 'unknown', reason: `${action.toUpperCase()}_SENT_ANSWER_LOST`, rawSha256: rawDigest({ [action]: idempotencyKey }) };
    }
    await this.redis.pexpire(k, RECORD_RETAIN_MS);
    const answer = await this.call(action === 'refund' ? PATH.refund : PATH.void, { method: 'POST', headers: this.headers(true), body: JSON.stringify(body) });
    let outcome: CardRefundOutcome;
    if (answer.shape === 'json' && isObject(answer.json) && answer.status < 500) {
      const json = answer.json;
      const rawSha256 = blindedDigest(json);
      const iso = str(json['IsoResponseCode']) ?? '';
      const codes = errorCodes(json);
      if (json['Approved'] === true && iso === '00') {
        const mine = expect.ref.toLowerCase();
        const namesIt = str(json['OriginalTrxnIdentifier'])?.toLowerCase() === mine || str(json['TransactionIdentifier'])?.toLowerCase() === mine;
        const typeIt = String(json['TransactionType'] ?? '') === (action === 'void' ? '4' : '5');
        const amountIt = action === 'void' || (expect.currencyCode !== undefined
          && alphaOfCurrency(json['CurrencyCode']) === expect.currencyCode
          && minorOfTotalAmount(json['TotalAmount'], expect.currencyCode) === expect.amountMinor);
        outcome = namesIt && typeIt && amountIt
          ? { status: 'succeeded', providerRef: str(json['TransactionIdentifier']) ?? '', rawSha256 }
          : { status: 'unknown', reason: `${action.toUpperCase()}_APPROVAL_NOT_FOR_THIS_${!namesIt ? 'TRANSACTION' : !typeIt ? 'TYPE' : 'AMOUNT'}`, rawSha256 };
      } else if (json['Approved'] === false && !AMBIGUOUS_ISO.has(iso) && !codes.some((c) => DUPLICATE_CODES.has(c))) {
        outcome = { status: 'failed', reason: `${action.toUpperCase()}_REFUSED_${iso || 'NO_CODE'}${codes.length ? `_${codes.join('_')}` : ''}`, rawSha256 };
      } else {
        outcome = { status: 'unknown', reason: `${action.toUpperCase()}_UNCLEAR_${iso || 'NO_CODE'}`, rawSha256 };
      }
    } else if (answer.shape !== 'transport' && answer.status >= 400 && answer.status < 500 && answer.status !== 408 && answer.status !== 429) {
      outcome = { status: 'failed', reason: `${action.toUpperCase()}_HTTP_${answer.status}`, rawSha256: rawDigest({ [action]: answer.status }) };
    } else {
      // Leave the claim in place: the answer is lost, and a second call could refund twice.
      return { status: 'unknown', reason: `${action.toUpperCase()}_NO_ANSWER`, rawSha256: rawDigest({ [action]: 'no-answer' }) };
    }
    await this.redis.hset(k, { state: 'done', result: JSON.stringify(outcome) });
    return outcome;
  }

  // -------------------------------------------------------------------------
  // The owner's self-check (PT-5): OK / FAIL only, never a value
  // -------------------------------------------------------------------------

  /**
   * - alive: GET /api/alive answers (sec. 3);
   * - credentials: a request the gateway must authenticate (sec. 2.2 1.4) is
   *   not refused as "Invalid credentials" (Appendix 1: 89 / 312). It carries
   *   no card and no amount and fails validation by design — nothing is created;
   * - hostedPage (sandbox only, `preprocess`): a Sale for the smallest amount
   *   is preprocessed (SP4) with this PageSet/PageName. Preprocessing is no
   *   authorization (sec. 7.3) and Swift never completes it: no money moves.
   */
  async selfCheck(opts: { preprocess: boolean; returnUrl: string }): Promise<Array<{ check: string; ok: boolean }>> {
    const out: Array<{ check: string; ok: boolean }> = [];
    const alive = await this.call(PATH.alive, { method: 'GET', headers: { accept: 'application/json' } });
    out.push({ check: 'gateway reachable', ok: alive.shape !== 'transport' && alive.status >= 200 && alive.status < 300 });
    const probe = await this.call(PATH.riskMgmt, { method: 'POST', headers: this.headers(true), body: '{}' });
    const refusedCredentials = probe.shape === 'transport'
      || probe.status === 401 || probe.status === 403
      || (probe.shape === 'json' && isObject(probe.json) && (str(probe.json['IsoResponseCode']) === '89' || errorCodes(probe.json).includes('312')));
    out.push({ check: 'credentials accepted', ok: !refusedCredentials });
    if (opts.preprocess && this.binding.environment === 'sandbox') {
      const created = await this.createSession({
        binding: this.binding, sessionRef: `selfcheck-${randomBytes(6).toString('hex')}`, purpose: 'PAY_NOW',
        returnUrl: opts.returnUrl, expiresAt: new Date(this.now().getTime() + 60_000), amountMinor: 100, currencyCode: 'GYD',
      });
      out.push({ check: 'hosted payment page set up', ok: created.status === 'succeeded' });
      if (created.status === 'succeeded') await this.abandon(this.key.session(created.providerSessionRef), 'SELF_CHECK');
    }
    return out;
  }
}

/** The first accepted return's decision stands: written once, never rewritten. */
const CLAIM_COMPLETION = `
if redis.call('HEXISTS', KEYS[1], 'completion') == 1 then return 0 end
redis.call('HSET', KEYS[1], 'completion', 'sending', 'completionClaimedAtMs', ARGV[1])
return 1
`;

const NOTE_ONCE = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if redis.call('HSETNX', KEYS[1], 'returnedAtMs', ARGV[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'authDecision', ARGV[2], 'authNote', ARGV[3])
return 1`;
