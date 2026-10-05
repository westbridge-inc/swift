import type { Prisma } from '@prisma/client';
import type { MmgCheckoutProvider } from '../../providers/mmg/mmg-checkout';

// ---------------------------------------------------------------------------
// What a reply from MMG's checkout page SAYS, before anything is done with it
// [mmg checkout 3/6]. MMG's own documentation page ("MMG Merchant Checkout",
// Checkout Response) lists the decrypted reply's fields — merchantTransactionId,
// transactionId, ResultCode, ResultMessage, htmlResponse — and eight result
// codes. MMG sends the outcome, success OR failure, to the same Response URL,
// so the handler reads the code and never assumes success from the path.
//
// A reply is a pointer, never evidence: no code here credits anything. Codes
// 0, 1, 2, 6 and 7 hand the reply to the service, which decides (#1393: only
// a 0 confirms, under the owner's six conditions; 1, 2 and 6 are MMG's own
// "not paid"; 7 waits for MMG's lookup when it names a transaction); codes 3,
// 4 and 5 mean MMG could not accept OUR request (secret key, merchant id,
// token) — a configuration or security problem for operators, on which
// nothing moves at all (mmg-checkout.routes.ts).
// ---------------------------------------------------------------------------

/** MMG's documented result codes, verbatim from its page. */
export const MMG_RESULT_CODES: Readonly<Record<string, string>> = {
  '0': 'Transaction Successful',
  '1': 'Agent Not Registered',
  '2': 'Payment Failed',
  '3': 'Invalid Secret Key',
  '4': 'Merchant ID Mismatch',
  '5': 'Token Decryption Failed',
  '6': 'Transaction Cancelled',
  '7': 'Request Timed Out',
};

/**
 * What MMG's documented code means. The routes act only on ALERT (MMG refused
 * our request; operators must look, and nothing is credited); every other
 * class goes to the service, which decides (#1393): PAID may confirm after the
 * lookup, NOT_PAID is MMG's own "not paid", TIMED_OUT is "not paid" unless the
 * lookup says paid, UNKNOWN (no code, or one MMG has not documented) decides
 * nothing.
 */
export type ReplyCodeClass = 'PAID' | 'NOT_PAID' | 'TIMED_OUT' | 'ALERT' | 'UNKNOWN';

/** The reply's ResultCode as MMG documents it (a string), tolerating a JSON number. */
export function resultCodeOf(reply: Record<string, unknown>): string | null {
  const key = Object.keys(reply).find((k) => k.toLowerCase() === 'resultcode');
  const raw = key === undefined ? undefined : reply[key];
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : null;
  if (typeof raw === 'string' && /^\s*\d{1,3}\s*$/.test(raw)) return String(Number(raw));
  return null;
}

export function replyCodeClass(code: string | null): ReplyCodeClass {
  switch (code) {
    case '0':
      return 'PAID';
    case '1':
    case '2':
    case '6':
      return 'NOT_PAID';
    case '7':
      return 'TIMED_OUT';
    case '3':
    case '4':
    case '5':
      return 'ALERT';
    default:
      return 'UNKNOWN';
  }
}

/** The web return page forwards at most this many values, each at most this long (MMG-CHECKOUT-API.md section 6). */
export const MAX_REPLY_VALUES = 16;
export const MAX_REPLY_VALUE_CHARS = 4096;

/** The values a reply may be carried in: every string, bounded in count and size. */
export function replyValues(params: unknown): string[] {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return [];
  return Object.values(params as Record<string, unknown>)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .slice(0, MAX_REPLY_VALUES)
    .filter((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_REPLY_VALUE_CHARS);
}

/** The first value that decrypts under our key is the reply; nothing else is. */
export function openReply(provider: MmgCheckoutProvider, params: unknown): Record<string, unknown> | null {
  for (const value of replyValues(params)) {
    try {
      return provider.decryptCheckoutResult(value);
    } catch {
      // not a token for us; try the next value
    }
  }
  return null;
}

/** The path the partner came back on, as a short hint; anything else is nothing. */
export function outcomeHint(outcome: unknown): string | null {
  const text = typeof outcome === 'string' ? outcome.toLowerCase() : '';
  return /^[a-z0-9_-]{1,32}$/.test(text) ? text : null;
}

/** Key names that may carry a secret: never stored. */
const SECRET_PATH = /secret|password|passwd|token|apikey|api_key|privatekey|private_key/i;
const REDACT_MAX_DEPTH = 4;
const REDACT_MAX_KEYS = 64;
const REDACT_MAX_CHARS = 512;

/** The reply as stored for a person: keys that may carry a secret are replaced, and size is bounded. */
export function redactReply(value: unknown, depth = 0): Prisma.InputJsonValue | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > REDACT_MAX_CHARS ? `${value.slice(0, REDACT_MAX_CHARS)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= REDACT_MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.slice(0, REDACT_MAX_KEYS).map((item) => redactReply(item, depth + 1) ?? null);
  if (typeof value === 'object') {
    const out: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, REDACT_MAX_KEYS)) {
      out[key] = SECRET_PATH.test(key) ? '[redacted]' : redactReply(child, depth + 1);
    }
    return out as Prisma.InputJsonValue;
  }
  return String(value);
}
