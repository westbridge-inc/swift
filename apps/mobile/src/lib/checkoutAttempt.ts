/**
 * [TA-S1-001 / MOB-020] One checkout INTENT = one idempotency key.
 *
 * The server side has been right for a long time: with an `Idempotency-Key`
 * the first `/customer/checkout` claims the key for 24 h, a concurrent twin is
 * refused (409 DUPLICATE_REQUEST), a later replay gets the STORED order back
 * (the receipt row written inside the order's own transaction), and the same
 * key with a DIFFERENT body is refused (422 IDEMPOTENCY_KEY_REUSED).
 *
 * The first fix (#990) gave the key the lifetime of an attempt. This one gives
 * the attempt the shape of an INTENT, so the key follows what the person means:
 *
 *   principal   the signed-in account and its login generation — a persisted
 *               intent from another principal (a shared device) is never reused
 *   bodyHash    the canonical hash of what will be sent — payment method,
 *               fulfillment, tip, promo, schedule, appointments
 *   state       open  = minted, or answered with a definitive failure: the
 *                       same key may be retried, a changed body supersedes it
 *               sent  = on the wire with the outcome UNKNOWN (a timeout, a lost
 *                       response, an app killed mid-request): the same body
 *                       replays it; a DIFFERENT body must first ask the server
 *                       what became of it (the receipt probe) — never place a
 *                       second order over an unresolved first one
 *
 * It is persisted (checkoutAttemptStore.ts — the encrypted MMKV behind every
 * persisted store) so an app killed mid-request replays the same intent when
 * it comes back. Persistence is best-effort and fails OPEN to memory: a
 * storage fault must never stop someone ordering dinner, and memory alone
 * still ends the double tap. This module is pure so it can be proved without a
 * native store.
 */

export const CHECKOUT_ATTEMPT_STORAGE_KEY = 'swift.checkout.attempt.v2';
/** The #990 record: a bare key. Read once, treated as an unresolved intent of unknown body. */
export const LEGACY_CHECKOUT_ATTEMPT_STORAGE_KEY = 'swift.checkout.attemptKey.v1';
export const UNKNOWN_BODY_HASH = 'unknown';

export interface CheckoutKeyStore {
  get(): string | null;
  set(key: string): void;
  clear(): void;
}

export interface CheckoutPrincipal {
  userId: string;
  generation: number;
}

export type CheckoutIntentState = 'open' | 'sent';

export interface CheckoutIntent {
  key: string;
  principal: CheckoutPrincipal;
  bodyHash: string;
  state: CheckoutIntentState;
  createdAt: number;
  sentAt?: number;
}

export type BeginOutcome =
  /** No intent, a foreign principal's, or an open one for a different body: a fresh key. */
  | { kind: 'new'; key: string }
  /** The same principal and the same body: the same key, whatever its state. */
  | { kind: 'reused'; key: string; state: CheckoutIntentState }
  /** An intent is on the wire with the outcome unknown, and this body differs: ask the server first. */
  | { kind: 'ambiguous'; key: null; pending: CheckoutIntent };

/** `chk_<base36 ms>_<10 base36 chars>` — inside the server's 8–128 window. */
export function mintCheckoutKey(now: number = Date.now(), random: () => number = Math.random): string {
  const tail = random().toString(36).slice(2, 12).padEnd(10, '0');
  return `chk_${now.toString(36)}_${tail}`;
}

/** A stable fingerprint of the request body: canonical JSON (sorted keys), FNV-1a over two 32-bit lanes. Pure, synchronous. */
export function stableBodyHash(body: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  const text = JSON.stringify(canonical(body ?? {}));
  let a = 0x811c9dc5; let b = 0x01000193 ^ 0x9747b28c;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

const validKey = (k: unknown): k is string => typeof k === 'string' && k.length >= 8 && k.length <= 128;

function decodeIntent(raw: string | null): CheckoutIntent | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<CheckoutIntent>;
    if (!validKey(v.key)) return null;
    if (!v.principal || typeof v.principal.userId !== 'string' || !v.principal.userId || !Number.isSafeInteger(v.principal.generation)) return null;
    if (typeof v.bodyHash !== 'string' || !v.bodyHash) return null;
    if (v.state !== 'open' && v.state !== 'sent') return null;
    if (!Number.isFinite(v.createdAt)) return null;
    return { key: v.key, principal: { userId: v.principal.userId, generation: v.principal.generation }, bodyHash: v.bodyHash, state: v.state, createdAt: v.createdAt as number, ...(Number.isFinite(v.sentAt) ? { sentAt: v.sentAt as number } : {}) };
  } catch {
    return null;
  }
}

export function createCheckoutAttempt(
  store: CheckoutKeyStore,
  mint: () => string = mintCheckoutKey,
  now: () => number = Date.now,
  legacy: Pick<CheckoutKeyStore, 'get' | 'clear'> | null = null,
) {
  let memory: CheckoutIntent | null = null;
  let legacyRead = false;

  const persist = (intent: CheckoutIntent | null) => {
    memory = intent;
    try {
      if (intent) store.set(JSON.stringify(intent));
      else store.clear();
    } catch {
      // Memory holds it; the double tap is still one attempt.
    }
  };

  /** The #990 bare key, adopted ONCE as an unresolved intent of unknown body for whoever asks first. */
  const adoptLegacy = (principal: CheckoutPrincipal): CheckoutIntent | null => {
    if (legacyRead || !legacy) return null;
    legacyRead = true;
    let raw: string | null = null;
    try { raw = legacy.get(); } catch { raw = null; }
    try { legacy.clear(); } catch { /* best effort */ }
    if (!validKey(raw)) return null;
    const intent: CheckoutIntent = { key: raw, principal, bodyHash: UNKNOWN_BODY_HASH, state: 'sent', createdAt: now(), sentAt: now() };
    persist(intent);
    return intent;
  };

  const read = (): CheckoutIntent | null => {
    if (memory) return memory;
    try {
      memory = decodeIntent(store.get());
    } catch {
      memory = null;
    }
    return memory;
  };

  const samePrincipal = (a: CheckoutPrincipal, b: CheckoutPrincipal) => a.userId === b.userId && a.generation === b.generation;

  return {
    /** The intent this process holds, whoever it belongs to (the hook filters by principal). */
    current(): CheckoutIntent | null {
      return read();
    },
    /** The open intent for THIS principal, or null. */
    currentFor(principal: CheckoutPrincipal): CheckoutIntent | null {
      const intent = read() ?? adoptLegacy(principal);
      return intent && samePrincipal(intent.principal, principal) ? intent : null;
    },
    /** Reuse, supersede, mint — or refuse to decide while a sent intent with another body is unresolved. Never throws. */
    begin(input: { principal: CheckoutPrincipal; bodyHash: string }): BeginOutcome {
      const existing = read() ?? adoptLegacy(input.principal);
      if (existing && samePrincipal(existing.principal, input.principal)) {
        if (existing.bodyHash === input.bodyHash) return { kind: 'reused', key: existing.key, state: existing.state };
        if (existing.state === 'sent') return { kind: 'ambiguous', key: null, pending: existing };
        // an open intent for another body: the person changed their mind before anything left the device
      }
      const intent: CheckoutIntent = { key: mint(), principal: input.principal, bodyHash: input.bodyHash, state: 'open', createdAt: now() };
      persist(intent);
      return { kind: 'new', key: intent.key };
    },
    /** The request left the device: until an answer comes back, the outcome is unknown. */
    markSent(key: string): void {
      const intent = read();
      if (intent && intent.key === key && intent.state !== 'sent') persist({ ...intent, state: 'sent', sentAt: now() });
    },
    /** A definitive answer came back without an order (a validation failure): the same key may try again, a changed body may supersede. */
    markOpen(key: string): void {
      const intent = read();
      if (intent && intent.key === key && intent.state !== 'open') persist({ ...intent, state: 'open' });
    },
    /** The order was placed (or found placed), or the cart changed: whatever comes next is a new intent. */
    end(): void {
      persist(null);
    },
  };
}

export type CheckoutAttempt = ReturnType<typeof createCheckoutAttempt>;

// ---------------------------------------------------------------------------
// On-device counters: checkout_dedupe_replay, key_body_conflict,
// ambiguous_recovery — outcomes only.
// ---------------------------------------------------------------------------

const counters = new Map<string, number>();

export function recordCheckoutOutcome(metric: 'checkout_dedupe_replay' | 'key_body_conflict' | 'ambiguous_recovery' | 'in_flight_refused', detail?: string): void {
  const k = detail ? `${metric}:${detail}` : metric;
  counters.set(k, (counters.get(k) ?? 0) + 1);
}

export function checkoutCounters(): Record<string, number> {
  return Object.fromEntries(counters);
}

export function resetCheckoutCountersForTests(): void {
  counters.clear();
}
