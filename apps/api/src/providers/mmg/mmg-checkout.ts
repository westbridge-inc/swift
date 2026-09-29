import {
  constants,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomInt,
  type KeyObject,
} from 'node:crypto';
import { TextDecoder } from 'node:util';
import { AppError } from '../../utils/errors';
import { MAJOR_AMOUNT_CEILING, type CurrencyAmount } from '../../utils/currency-amount';
import { isProduction } from '../../utils/runtime-mode';

// ---------------------------------------------------------------------------
// MMG hosted checkout — the partner pays the weekly fee on the MMG page.
//
// The source of truth is the MMG UAT package ONLY: the Checkout Flow demo
// (Python, pyca/cryptography) for the wire format, and the Initiate Flow
// Postman collection for endpoint and field NAMES. Nothing here is taken from
// a third-party integration, and no value from either file is in this repo.
// providers/mmg/CHECKOUT-CONTRACT.md lists what is confirmed and what is not.
//
//   request  JSON exactly as json.dumps(indent=4) writes it (ensure_ascii),
//            as ISO-8859-1 bytes, RSA-OAEP (SHA-256, MGF1-SHA-256, no label)
//            under MMG_CHECKOUT_PUBLIC_KEY, standard base64 with + → - and
//            / → _ and the '=' padding KEPT, placed raw in the page URL:
//            <page>?token=…&merchantId=…&X-Client-ID=…
//   reply    base64url (padding optional) → the same OAEP under
//            MMG_CHECKOUT_PRIVATE_KEY → UTF-8 → JSON. Its FIELD NAMES are
//            UNCONFIRMED, so this module returns the generic object and
//            describeShape() — never a parsed outcome.
//
// [I2] A decrypted reply is a HINT, never proof of payment. The UAT key pair
// is ONE pair shared with MMG, so anyone holding its public half can mint a
// reply that decrypts cleanly. Nothing credits a partner until the MMG lookup
// confirms the transaction (PR 2 of the checkout series). This module has no
// network access at all: it builds a URL and opens a token.
//
// The driver follows MMG_DRIVER, the same switch as the merchant-initiated
// rail, ON PURPOSE: the lookup that verifies a checkout runs on that rail, so
// a live checkout can never be verified by the sandbox lookup (which approves
// what it is told to).
// ---------------------------------------------------------------------------

/** MMG UAT hosted-checkout page (the Checkout Flow demo). The default OUTSIDE
 *  production only; production names its page explicitly — there is no live
 *  host default of any kind. */
export const MMG_CHECKOUT_UAT_URL = 'https://mmgpg.mmgtest.net/mmg-pg/web/payments';

/** Where the sandbox points: a reserved name (RFC 2606) that never resolves.
 *  A sandbox URL can never reach MMG, or anyone else. */
export const MMG_CHECKOUT_SANDBOX_URL = 'https://mmg-checkout.sandbox.invalid/mmg-pg/web/payments';

/** The productDescription of every checkout: the fee is the only thing sold. */
export const MMG_CHECKOUT_PRODUCT_DESCRIPTION = 'Swift weekly fee';

const SHA256_BYTES = 32;
/** Below this an RSA key is refused at boot, whoever issued it. */
const MIN_RSA_BITS = 2048;

/** RFC 8017 §7.1.1: RSA-OAEP carries at most k − 2·hLen − 2 bytes, k being
 *  the modulus length in bytes — k − 66 with SHA-256. Always derived from the
 *  CONFIGURED key; never an assumed key size. */
export function oaepSha256MaxPlaintextBytes(modulusBytes: number): number {
  return modulusBytes - 2 * SHA256_BYTES - 2;
}

export type MmgCheckoutErrorCode =
  | 'INVALID_REQUEST'
  | 'REQUEST_TOO_LARGE'
  | 'TOKEN_MALFORMED'
  | 'TOKEN_UNREADABLE'
  | 'RESULT_NOT_JSON'
  | 'RESULT_NOT_OBJECT';

/** Messages name the rule that failed — never a secret, a request byte or a token. */
export class MmgCheckoutError extends Error {
  override readonly name = 'MmgCheckoutError';
  constructor(readonly code: MmgCheckoutErrorCode, message: string) {
    super(message);
  }
}

/** The request object, in the order the demo writes it (Checkout Flow demo, lines 96–104). */
export interface MmgCheckoutRequest {
  secretKey: string;
  amount: string;
  merchantId: string;
  merchantTransactionId: string;
  productDescription: string;
  /** Unix SECONDS, an integer — the demo sends int(time.time()). */
  requestInitiationTime: number;
  merchantName: string;
}

// -- The three open points, one function each (CHECKOUT-CONTRACT.md) ---------

/**
 * [U4] The amount as MMG takes it: whole major units as a string of digits
 * ("1500"). Digits-only is confirmed by the shape of the MMG UAT config;
 * that the digits are MAJOR units is confirmed on the first sandbox run,
 * where the MMG page displays the amount. A GYD amount with cents is
 * REFUSED — never rounded — and an amount at the platform ceiling reads as
 * minor-scaled [M-36] and is refused rather than sent 100× too large.
 */
export function formatCheckoutAmount(amount: CurrencyAmount): string {
  if (amount.currency !== 'GYD') {
    throw new MmgCheckoutError('INVALID_REQUEST', `MMG checkout collects GYD only, not ${amount.currency}.`);
  }
  if (amount.minor <= 0n) throw new MmgCheckoutError('INVALID_REQUEST', 'A checkout amount must be positive.');
  const factor = 10n ** BigInt(amount.exponent);
  if (amount.minor % factor !== 0n) {
    throw new MmgCheckoutError('INVALID_REQUEST', 'MMG checkout takes whole dollars; an amount with cents is refused, never rounded.');
  }
  const major = amount.minor / factor;
  if (major >= BigInt(MAJOR_AMOUNT_CEILING)) {
    throw new MmgCheckoutError('INVALID_REQUEST', 'The checkout amount is at or above the platform ceiling and looks minor-scaled; refusing it.');
  }
  return major.toString();
}

/** [DEFAULT] Our merchantTransactionId: DIGITS ONLY, 18 of them — 13-digit
 *  unix milliseconds then 5 random digits. The demo sends a numeric string,
 *  and 18 digits fit a signed 64-bit column on the MMG side. Uniqueness is
 *  the job of the intent table (PR 2), never of chance. */
export const MERCHANT_TRANSACTION_ID_SHAPE = /^\d{18}$/;
export function newMerchantTransactionId(now: Date = new Date()): string {
  const millis = String(now.getTime());
  if (!/^\d{13}$/.test(millis)) {
    throw new MmgCheckoutError('INVALID_REQUEST', 'The clock is outside the 13-digit millisecond range.');
  }
  return `${millis}${String(randomInt(0, 100_000)).padStart(5, '0')}`;
}

/** [DEFAULT] The page: MMG_CHECKOUT_URL, else the UAT page outside production.
 *  Production requires an explicit https page that is not UAT. */
export function checkoutPageUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env['MMG_CHECKOUT_URL'];
  const production = isProduction(env);
  if (!raw) {
    if (production) {
      throw new Error('FATAL: MMG_CHECKOUT_URL must be set explicitly in production (an https MMG checkout page) — there is no live default. Refusing to start.');
    }
    return MMG_CHECKOUT_UAT_URL;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('FATAL: MMG_CHECKOUT_URL is not a URL. Refusing to start.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('FATAL: MMG_CHECKOUT_URL must be a plain https page address, with no query, fragment or credentials. Refusing to start.');
  }
  if (production && /mmgtest|\buat\b|sandbox/i.test(raw)) {
    throw new Error('FATAL: production MMG checkout requires a non-UAT MMG_CHECKOUT_URL. Refusing to start.');
  }
  return `${url.origin}${url.pathname}`;
}

/** Unix seconds, as the demo computes int(time.time()). */
export function requestInitiationTime(now: Date): number {
  return Math.floor(now.getTime() / 1000);
}

// -- The request ----------------------------------------------------------------

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const MERCHANT_MSISDN = /^\d{7,15}$/;

function shortAscii(value: string, what: string, max: number): string {
  if (!PRINTABLE_ASCII.test(value) || value.length > max || value.trim() !== value) {
    throw new MmgCheckoutError('INVALID_REQUEST', `${what} must be 1-${max} printable ASCII characters with no surrounding spaces.`);
  }
  return value;
}

/** Validates every field and returns them in the demo order. */
export function buildCheckoutRequest(input: MmgCheckoutRequest): MmgCheckoutRequest {
  if (!/^\d+$/.test(input.amount)) throw new MmgCheckoutError('INVALID_REQUEST', 'amount must be a string of digits.');
  if (!MERCHANT_MSISDN.test(input.merchantId)) {
    throw new MmgCheckoutError('INVALID_REQUEST', 'merchantId must be the merchant MSISDN, 7-15 digits.');
  }
  if (!MERCHANT_TRANSACTION_ID_SHAPE.test(input.merchantTransactionId)) {
    throw new MmgCheckoutError('INVALID_REQUEST', 'merchantTransactionId must be 18 digits (newMerchantTransactionId).');
  }
  if (!Number.isSafeInteger(input.requestInitiationTime) || input.requestInitiationTime <= 0) {
    throw new MmgCheckoutError('INVALID_REQUEST', 'requestInitiationTime must be a positive integer of unix seconds.');
  }
  return {
    secretKey: shortAscii(input.secretKey, 'The secret key', 256),
    amount: input.amount,
    merchantId: input.merchantId,
    merchantTransactionId: input.merchantTransactionId,
    productDescription: shortAscii(input.productDescription, 'productDescription', 64),
    requestInitiationTime: input.requestInitiationTime,
    merchantName: shortAscii(input.merchantName, 'merchantName', 64),
  };
}

/**
 * The plaintext bytes, exactly as the demo produces them:
 * json.dumps(obj, indent=4) — ensure_ascii on by default, so every UTF-16
 * code unit outside printable ASCII becomes a lowercase \uXXXX (DEL, 0x7f,
 * included; an astral character becomes its surrogate pair) — then
 * .encode("ISO-8859-1"). JSON.stringify already writes the same layout and
 * the same escapes below 0x20. The escaping leaves pure ASCII, so the Latin-1
 * encode is exact.
 */
export function serializeCheckoutRequest(request: MmgCheckoutRequest): Buffer {
  const ordered: MmgCheckoutRequest = {
    secretKey: request.secretKey,
    amount: request.amount,
    merchantId: request.merchantId,
    merchantTransactionId: request.merchantTransactionId,
    productDescription: request.productDescription,
    requestInitiationTime: request.requestInitiationTime,
    merchantName: request.merchantName,
  };
  const json = JSON.stringify(ordered, null, 4).replace(
    /[\u007f-\uffff]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return Buffer.from(json, 'latin1');
}

function rsaModulusBytes(key: KeyObject): number {
  const bits = key.asymmetricKeyDetails?.modulusLength;
  if (key.asymmetricKeyType !== 'rsa' || !bits) {
    throw new MmgCheckoutError('INVALID_REQUEST', 'An MMG checkout key must be an RSA key.');
  }
  return Math.ceil(bits / 8);
}

/** RSA-OAEP with SHA-256 for both the digest and MGF1 and an empty label — the
 *  demo padding.OAEP(mgf=MGF1(SHA256), algorithm=SHA256, label=None). Node
 *  applies oaepHash to MGF1 as well. Over the k − 66 limit is a clear refusal. */
export function encryptCheckoutRequest(plaintext: Buffer, mmgPublicKey: KeyObject): Buffer {
  const k = rsaModulusBytes(mmgPublicKey);
  const max = oaepSha256MaxPlaintextBytes(k);
  if (plaintext.length > max) {
    throw new MmgCheckoutError(
      'REQUEST_TOO_LARGE',
      `The checkout request is ${plaintext.length} bytes; RSA-OAEP-SHA256 under this ${k * 8}-bit key carries at most ${max} (k - 66). Shorten MMG_CHECKOUT_MERCHANT_NAME.`,
    );
  }
  return publicEncrypt({ key: mmgPublicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, plaintext);
}

/** base64.urlsafe_b64encode: the standard alphabet with + → - and / → _, and
 *  the '=' padding KEPT. (Buffer 'base64url' drops the padding; the demo does not.) */
export function toCheckoutToken(ciphertext: Buffer): string {
  return ciphertext.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

const TOKEN = /^[A-Za-z0-9_-]+={0,2}$/;

/** The demo URL, in its order. The token goes in RAW — its alphabet (and '=')
 *  is legal in a query — and the two ids are percent-encoded, which leaves an
 *  id made of unreserved characters byte-identical to the demo URL. */
export function buildCheckoutUrl(page: string, token: string, merchantId: string, clientId: string): string {
  if (!TOKEN.test(token)) throw new MmgCheckoutError('INVALID_REQUEST', 'A checkout token must be padded base64url.');
  return `${page}?token=${token}&merchantId=${encodeURIComponent(merchantId)}&X-Client-ID=${encodeURIComponent(clientId)}`;
}

// -- The reply ------------------------------------------------------------------

/**
 * base64url with the padding optional: a token may arrive with its '='
 * padding or without it (the demo re-pads before decoding). The re-padding is
 * to a multiple of four — never four '=' on an already-aligned token — and a
 * token that IS padded must be padded correctly. Any character outside the
 * base64url alphabet is refused, never skipped.
 */
export function decodeCheckoutToken(token: string): Buffer {
  const match = /^([A-Za-z0-9_-]+)(={0,2})$/.exec(token);
  if (!match) throw new MmgCheckoutError('TOKEN_MALFORMED', 'The MMG token is not base64url.');
  const body = match[1] as string;
  const padding = (match[2] as string).length;
  const leftover = body.length % 4;
  if (leftover === 1) throw new MmgCheckoutError('TOKEN_MALFORMED', 'The MMG token has an impossible base64 length.');
  const needed = (4 - leftover) % 4;
  if (padding !== 0 && padding !== needed) throw new MmgCheckoutError('TOKEN_MALFORMED', 'The MMG token is padded wrongly.');
  return Buffer.from(`${body.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat(needed)}`, 'base64');
}

/** Strict UTF-8 (the demo decodes with .decode()): an invalid byte is a
 *  refusal, never a replacement character, and a byte-order mark is kept, so
 *  JSON parsing refuses it exactly as json.loads does. */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Opens an MMG reply token into the generic object it carries. The field
 * names inside are UNCONFIRMED (CHECKOUT-CONTRACT.md U1–U3): read nothing
 * from it but describeShape() until MMG or the first sandbox run confirms
 * them — and even then it is a hint, never proof [I2].
 */
export function decryptCheckoutResultToken(token: string, resultPrivateKey: KeyObject): Record<string, unknown> {
  const k = rsaModulusBytes(resultPrivateKey);
  if (token.length > Math.ceil(k / 3) * 4) {
    throw new MmgCheckoutError('TOKEN_MALFORMED', 'The MMG token is longer than any ciphertext under this key.');
  }
  const ciphertext = decodeCheckoutToken(token);
  if (ciphertext.length !== k) {
    throw new MmgCheckoutError('TOKEN_MALFORMED', 'The MMG token is not one RSA block under this key.');
  }
  let plaintext: Buffer;
  try {
    plaintext = privateDecrypt({ key: resultPrivateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, ciphertext);
  } catch {
    // One refusal for every decryption failure: a caller learns nothing about
    // which OAEP check failed.
    throw new MmgCheckoutError('TOKEN_UNREADABLE', 'The MMG token does not decrypt under MMG_CHECKOUT_PRIVATE_KEY.');
  }
  let text: string;
  try {
    text = UTF8.decode(plaintext);
  } catch {
    throw new MmgCheckoutError('RESULT_NOT_JSON', 'The decrypted MMG reply is not UTF-8 text.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MmgCheckoutError('RESULT_NOT_JSON', 'The decrypted MMG reply is not JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MmgCheckoutError('RESULT_NOT_OBJECT', 'The decrypted MMG reply is not a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

const SHAPE_MAX_DEPTH = 6;
const SHAPE_MAX_PATHS = 200;

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) return 'number';
    // An integer JSON.parse could not hold exactly (beyond 2^53) must be read
    // from the raw text, never from this number.
    return Number.isSafeInteger(value) ? 'integer' : 'integer(unsafe)';
  }
  return typeof value;
}

/**
 * The SHAPE of a decrypted reply for a probe log: each key path and the JSON
 * type found there — never a value. Arrays report their elements under
 * `path[]`; a path seen with several types lists them all. Bounded in depth
 * and size, so a hostile reply cannot flood a log.
 */
export function describeShape(value: unknown): Record<string, string> {
  const types = new Map<string, Set<string>>();
  let truncated = false;
  const note = (path: string, type: string): boolean => {
    if (!types.has(path)) {
      if (types.size >= SHAPE_MAX_PATHS) {
        truncated = true;
        return false;
      }
      types.set(path, new Set());
    }
    types.get(path)?.add(type);
    return true;
  };
  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > SHAPE_MAX_DEPTH) {
      truncated = true;
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        if (note(`${path}[]`, jsonType(item))) walk(item, `${path}[]`, depth + 1);
      }
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      const segment = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? (path ? `.${key}` : key) : `[${JSON.stringify(key)}]`;
      if (note(`${path}${segment}`, jsonType(child))) walk(child, `${path}${segment}`, depth + 1);
    }
  };
  if (value === null || typeof value !== 'object') {
    note('(root)', jsonType(value));
  } else {
    walk(value, '', 0);
  }
  const out: Record<string, string> = {};
  for (const [path, seen] of [...types.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    out[path] = [...seen].sort().join('|');
  }
  if (truncated) out['(truncated)'] = `more than ${SHAPE_MAX_PATHS} paths or ${SHAPE_MAX_DEPTH} levels`;
  return out;
}

// -- Configuration --------------------------------------------------------------

export interface MmgCheckoutConfig {
  /** The MMG hosted-checkout page (checkoutPageUrl). */
  checkoutPage: string;
  /** The merchant MSISDN: the token merchantId and the URL merchantId. */
  merchantId: string;
  /** The URL X-Client-ID. */
  clientId: string;
  /** The merchant name registered with MMG. */
  merchantName: string;
  /** The web origin whose /pay/mmg URLs are registered with MMG as the return. */
  returnOrigin: string;
  /** Carried inside the encrypted token. */
  secretKey: string;
  /** MMG_CHECKOUT_PUBLIC_KEY — what requests are encrypted to. */
  requestPublicKey: KeyObject;
  /** MMG_CHECKOUT_PRIVATE_KEY — what replies are decrypted with. */
  resultPrivateKey: KeyObject;
}

/** On only at exactly '1'. The boot guard refuses any other non-zero spelling. */
export function mmgCheckoutEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['MMG_CHECKOUT_ENABLED'] === '1';
}

/** A PEM from configuration: real newlines, or the literal \n an env file forces. */
function pemFrom(raw: string): string {
  return raw.replace(/\\n/g, '\n').trim();
}

function isPrivateKeyText(text: string): boolean {
  try {
    createPrivateKey(text);
    return true;
  } catch {
    return false;
  }
}

function strongRsa(key: KeyObject, name: string): KeyObject {
  if (key.asymmetricKeyType !== 'rsa') throw new Error(`FATAL: ${name} must be an RSA key. Refusing to start.`);
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_RSA_BITS) {
    throw new Error(`FATAL: ${name} is a ${bits}-bit key; at least ${MIN_RSA_BITS} bits are required. Refusing to start.`);
  }
  return key;
}

function requestPublicKeyFrom(raw: string | undefined): KeyObject {
  if (!raw) throw new Error('FATAL: MMG_CHECKOUT_PUBLIC_KEY is required when MMG_CHECKOUT_ENABLED=1 with MMG_DRIVER=live. Refusing to start.');
  const pem = pemFrom(raw);
  // createPublicKey would quietly DERIVE a public key from a private one. A
  // private key in plain configuration is a leak, so it is refused, not used.
  if (isPrivateKeyText(pem)) {
    throw new Error('FATAL: MMG_CHECKOUT_PUBLIC_KEY holds a PRIVATE key. A private key belongs only in the secret file MMG_CHECKOUT_PRIVATE_KEY. Refusing to start.');
  }
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new Error('FATAL: MMG_CHECKOUT_PUBLIC_KEY is not a readable RSA public key (PEM). Refusing to start.');
  }
  return strongRsa(key, 'MMG_CHECKOUT_PUBLIC_KEY');
}

function resultPrivateKeyFrom(raw: string | undefined): KeyObject {
  if (!raw) {
    throw new Error('FATAL: MMG_CHECKOUT_PRIVATE_KEY (a secret file, MMG_CHECKOUT_PRIVATE_KEY_FILE) is required when MMG_CHECKOUT_ENABLED=1 with MMG_DRIVER=live. Refusing to start.');
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(pemFrom(raw));
  } catch {
    throw new Error('FATAL: MMG_CHECKOUT_PRIVATE_KEY is not a readable, unencrypted RSA private key (PEM). Refusing to start.');
  }
  return strongRsa(key, 'MMG_CHECKOUT_PRIVATE_KEY');
}

function returnOriginFrom(raw: string | undefined, production: boolean): string {
  if (!raw) throw new Error('FATAL: MMG_CHECKOUT_RETURN_ORIGIN is required when MMG_CHECKOUT_ENABLED=1 with MMG_DRIVER=live. Refusing to start.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('FATAL: MMG_CHECKOUT_RETURN_ORIGIN is not a URL. Refusing to start.');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const schemeOk = url.protocol === 'https:' || (!production && local && url.protocol === 'http:');
  if (!schemeOk) {
    throw new Error('FATAL: MMG_CHECKOUT_RETURN_ORIGIN must be an https origin (plain http only for localhost outside production). Refusing to start.');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('FATAL: MMG_CHECKOUT_RETURN_ORIGIN must be an origin only: scheme and host, with no path, query or credentials. Refusing to start.');
  }
  return url.origin;
}

function configValue(raw: string | undefined, name: string, rule: RegExp, what: string): string {
  if (!raw) throw new Error(`FATAL: ${name} is required when MMG_CHECKOUT_ENABLED=1 with MMG_DRIVER=live. Refusing to start.`);
  if (!rule.test(raw) || raw.trim() !== raw) throw new Error(`FATAL: ${name} must be ${what}. Refusing to start.`);
  return raw;
}

/**
 * Every value the live checkout needs, validated — or a refusal that names
 * the variable and never its value. Ends with a dry run: the widest request
 * this configuration can produce must fit the configured MMG key, so a key
 * too small for the request fails the deploy, not the first partner.
 */
export function loadMmgCheckoutConfig(env: Record<string, string | undefined> = process.env): MmgCheckoutConfig {
  const production = isProduction(env);
  const checkoutPage = checkoutPageUrl(env);
  const merchantId = configValue(env['MMG_CHECKOUT_MERCHANT_ID'], 'MMG_CHECKOUT_MERCHANT_ID', MERCHANT_MSISDN, 'the merchant MSISDN, 7-15 digits');
  const clientId = configValue(env['MMG_CHECKOUT_CLIENT_ID'], 'MMG_CHECKOUT_CLIENT_ID', /^[\x21-\x7e]{1,128}$/, '1-128 printable ASCII characters with no spaces');
  const merchantName = configValue(env['MMG_CHECKOUT_MERCHANT_NAME'], 'MMG_CHECKOUT_MERCHANT_NAME', /^[\x20-\x7e]{1,64}$/, 'the merchant name registered with MMG: 1-64 printable ASCII characters with no surrounding spaces');
  const secretKey = configValue(env['MMG_CHECKOUT_SECRET_KEY'], 'MMG_CHECKOUT_SECRET_KEY', /^[\x20-\x7e]{1,256}$/, '1-256 printable ASCII characters with no surrounding spaces');
  const returnOrigin = returnOriginFrom(env['MMG_CHECKOUT_RETURN_ORIGIN'], production);
  const requestPublicKey = requestPublicKeyFrom(env['MMG_CHECKOUT_PUBLIC_KEY']);
  const resultPrivateKey = resultPrivateKeyFrom(env['MMG_CHECKOUT_PRIVATE_KEY']);

  const widest = serializeCheckoutRequest(buildCheckoutRequest({
    secretKey,
    amount: String(MAJOR_AMOUNT_CEILING - 1),
    merchantId,
    merchantTransactionId: '9'.repeat(18),
    productDescription: MMG_CHECKOUT_PRODUCT_DESCRIPTION,
    requestInitiationTime: 9_999_999_999,
    merchantName,
  }));
  const k = rsaModulusBytes(requestPublicKey);
  const max = oaepSha256MaxPlaintextBytes(k);
  if (widest.length > max) {
    throw new Error(
      `FATAL: MMG_CHECKOUT_PUBLIC_KEY is a ${k * 8}-bit key, and RSA-OAEP-SHA256 under it carries at most ${max} bytes, ` +
        `but a checkout request for this merchant can reach ${widest.length}. Shorten MMG_CHECKOUT_MERCHANT_NAME or use the key MMG issued. Refusing to start.`,
    );
  }
  return { checkoutPage, merchantId, clientId, merchantName, returnOrigin, secretKey, requestPublicKey, resultPrivateKey };
}

/**
 * The boot guard (called by assertSafeBootConfig in EVERY mode — staging runs
 * in development mode against MMG UAT). The flag is exactly 0 or 1; once on,
 * the live driver needs its whole configuration, and production never runs
 * the sandbox or a UAT page.
 */
export function assertMmgCheckoutConfig(env: Record<string, string | undefined> = process.env): void {
  const flag = env['MMG_CHECKOUT_ENABLED'];
  if (flag !== undefined && flag !== '' && flag !== '0' && flag !== '1') {
    throw new Error('FATAL: MMG_CHECKOUT_ENABLED must be exactly 0 or 1 — a misspelled switch is not guessed at. Refusing to start.');
  }
  if (flag !== '1') return;
  const driver = env['MMG_DRIVER'] ?? 'sandbox';
  if (driver === 'sandbox') {
    if (isProduction(env)) {
      throw new Error('FATAL: MMG_CHECKOUT_ENABLED=1 in production needs MMG_DRIVER=live — the sandbox checkout settles nothing real. Refusing to start.');
    }
    return; // the sandbox plays both sides with in-memory keys
  }
  if (driver !== 'live') {
    throw new Error('FATAL: MMG_CHECKOUT_ENABLED=1 needs MMG_DRIVER to be sandbox or live. Refusing to start.');
  }
  loadMmgCheckoutConfig(env);
}

// -- The provider seam --------------------------------------------------------

export interface MmgCheckoutSession {
  /** Where the partner goes to pay: the MMG page with our encrypted token. */
  checkoutUrl: string;
  merchantTransactionId: string;
  requestInitiationTime: number;
  /** The amount exactly as sent (formatCheckoutAmount). */
  amount: string;
}

export interface MmgCheckoutCreate {
  amount: CurrencyAmount;
  /** From newMerchantTransactionId, persisted by the caller BEFORE the URL exists. */
  merchantTransactionId: string;
  now?: Date;
}

export interface MmgCheckoutProvider {
  readonly driver: 'disabled' | 'sandbox' | 'live';
  /** Builds the MMG page URL for one attempt. Local only: no network. */
  createCheckout(input: MmgCheckoutCreate): MmgCheckoutSession;
  /** Opens a reply token into its generic object. A hint, never proof [I2]. */
  decryptCheckoutResult(token: string): Record<string, unknown>;
}

interface CheckoutParties {
  checkoutPage: string;
  merchantId: string;
  clientId: string;
  merchantName: string;
  secretKey: string;
  requestPublicKey: KeyObject;
}

function createCheckoutWith(parties: CheckoutParties, input: MmgCheckoutCreate): MmgCheckoutSession {
  const request = buildCheckoutRequest({
    secretKey: parties.secretKey,
    amount: formatCheckoutAmount(input.amount),
    merchantId: parties.merchantId,
    merchantTransactionId: input.merchantTransactionId,
    productDescription: MMG_CHECKOUT_PRODUCT_DESCRIPTION,
    requestInitiationTime: requestInitiationTime(input.now ?? new Date()),
    merchantName: parties.merchantName,
  });
  const token = toCheckoutToken(encryptCheckoutRequest(serializeCheckoutRequest(request), parties.requestPublicKey));
  return {
    checkoutUrl: buildCheckoutUrl(parties.checkoutPage, token, parties.merchantId, parties.clientId),
    merchantTransactionId: request.merchantTransactionId,
    requestInitiationTime: request.requestInitiationTime,
    amount: request.amount,
  };
}

/** The flag is off: every door refuses, like the disabled card rail. */
class DisabledMmgCheckoutProvider implements MmgCheckoutProvider {
  readonly driver = 'disabled' as const;
  createCheckout(_input: MmgCheckoutCreate): MmgCheckoutSession {
    throw new AppError(503, 'MMG_CHECKOUT_DISABLED', 'Paying on the MMG checkout page is not available.');
  }
  decryptCheckoutResult(_token: string): Record<string, unknown> {
    throw new AppError(503, 'MMG_CHECKOUT_DISABLED', 'Paying on the MMG checkout page is not available.');
  }
}

export class LiveMmgCheckoutProvider implements MmgCheckoutProvider {
  readonly driver = 'live' as const;
  constructor(private readonly config: MmgCheckoutConfig) {}
  createCheckout(input: MmgCheckoutCreate): MmgCheckoutSession {
    return createCheckoutWith(this.config, input);
  }
  decryptCheckoutResult(token: string): Record<string, unknown> {
    return decryptCheckoutResultToken(token, this.config.resultPrivateKey);
  }
}

export interface SandboxCheckoutKeys {
  /** Stands in for MMG_CHECKOUT_PUBLIC_KEY; its private half lets the sandbox read what was sent. */
  request: { publicKey: KeyObject; privateKey: KeyObject };
  /** Stands in for MMG_CHECKOUT_PRIVATE_KEY; its public half lets the sandbox write a reply. */
  result: { publicKey: KeyObject; privateKey: KeyObject };
}

/** One 4096-bit pair for both directions, as MMG UAT issues it — generated in
 *  memory once per process, on first use. */
function oneSharedPair(): SandboxCheckoutKeys {
  const pair = generateKeyPairSync('rsa', { modulusLength: 4096 });
  return { request: pair, result: pair };
}

/**
 * Deterministic sandbox for tests and development. It runs the REAL request
 * and reply code under in-memory keys and plays MMG itself: it can read the
 * request inside a checkout URL and write a reply token. Its URLs point at a
 * reserved name that never resolves, so nothing leaves the process.
 */
export class SandboxMmgCheckoutProvider implements MmgCheckoutProvider {
  readonly driver = 'sandbox' as const;
  private generated: SandboxCheckoutKeys | null = null;

  /** Keys are made on first use (a 4096-bit pair takes a moment), unless given. */
  constructor(private readonly given?: SandboxCheckoutKeys) {}

  private keys(): SandboxCheckoutKeys {
    if (this.given) return this.given;
    this.generated ??= oneSharedPair();
    return this.generated;
  }

  createCheckout(input: MmgCheckoutCreate): MmgCheckoutSession {
    return createCheckoutWith({
      checkoutPage: MMG_CHECKOUT_SANDBOX_URL,
      merchantId: '0000000000',
      clientId: 'sandbox',
      merchantName: 'Swift Sandbox',
      secretKey: 'sandbox',
      requestPublicKey: this.keys().request.publicKey,
    }, input);
  }

  decryptCheckoutResult(token: string): Record<string, unknown> {
    return decryptCheckoutResultToken(token, this.keys().result.privateKey);
  }

  /** Plays MMG receiving the partner: the request object inside a checkout URL. */
  sandboxReadRequest(checkoutUrl: string): Record<string, unknown> {
    const token = /[?&]token=([^&]*)/.exec(checkoutUrl)?.[1] ?? '';
    const plaintext = privateDecrypt(
      { key: this.keys().request.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      decodeCheckoutToken(token),
    );
    return JSON.parse(plaintext.toString('latin1')) as Record<string, unknown>;
  }

  /** Plays the MMG return: a reply token carrying whatever object the caller
   *  chooses (the real field names are UNCONFIRMED), as UTF-8 JSON. */
  sandboxReplyToken(reply: Record<string, unknown>, options: { padded?: boolean } = {}): string {
    const token = toCheckoutToken(publicEncrypt(
      { key: this.keys().result.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(JSON.stringify(reply), 'utf8'),
    ));
    return options.padded === false ? token.replace(/=+$/, '') : token;
  }
}

let sandboxProvider: SandboxMmgCheckoutProvider | null = null;

/** Driver selection is config, not code: off unless MMG_CHECKOUT_ENABLED=1,
 *  then the MMG_DRIVER world (see the header for why it is shared). */
export function getMmgCheckoutProvider(env: Record<string, string | undefined> = process.env): MmgCheckoutProvider {
  if (!mmgCheckoutEnabled(env)) return new DisabledMmgCheckoutProvider();
  const driver = env['MMG_DRIVER'] ?? 'sandbox';
  if (isProduction(env) && driver === 'sandbox') {
    throw new Error('MMG_DRIVER=sandbox is forbidden in production');
  }
  switch (driver) {
    case 'sandbox':
      sandboxProvider ??= new SandboxMmgCheckoutProvider();
      return sandboxProvider;
    case 'live':
      return new LiveMmgCheckoutProvider(loadMmgCheckoutConfig(env));
    default:
      throw new Error(`Unknown MMG_DRIVER: ${driver}`);
  }
}
