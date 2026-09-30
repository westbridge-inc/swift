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
 *   principal   the signed-in account and its login generation — another
 *               account cannot use it; a new login may recover its own sent key
 *   bodyHash    the canonical hash of what will be sent — payment method,
 *               fulfillment, tip, promo, schedule, appointments
 *   state       open  = minted, or refused by the server (a 4xx) or found
 *                       "none" by the receipt probe: the same key may be
 *                       retried, a changed body supersedes it
 *               sent  = on the wire with the outcome UNKNOWN (a timeout, a lost
 *                       response, an app killed mid-request, any 5xx or the
 *                       server's CHECKOUT_OUTCOME_UNKNOWN): the same body
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
  // One minimal record per account. Switching accounts never evicts an
  // unresolved key; no request payload, contact data or credentials are stored.
  let memory: CheckoutIntent[] | null = null;
  let activeUserId: string | null = null;
  let legacyRead = false;
  const samePrincipal = (a: CheckoutPrincipal, b: CheckoutPrincipal) => a.userId === b.userId && a.generation === b.generation;
  const read = (): CheckoutIntent[] => {
    if (memory) return memory;
    memory = [];
    try {
      const raw = store.get();
      const old = decodeIntent(raw);
      if (old) { memory = [old]; activeUserId = old.principal.userId; }
      else if (raw) {
        const saved = JSON.parse(raw) as { version?: number; intents?: unknown[]; activeUserId?: string };
        if (saved.version === 3 && Array.isArray(saved.intents)) {
          memory = saved.intents.map((v) => decodeIntent(JSON.stringify(v))).filter((v): v is CheckoutIntent => !!v);
          activeUserId = saved.activeUserId ?? null;
        }
      }
    } catch { /* Memory still protects retries when storage is unavailable. */ }
    return memory;
  };
  const persist = () => {
    try {
      if (read().length) store.set(JSON.stringify({ version: 3, intents: memory, activeUserId }));
      else store.clear();
    } catch { /* The in-memory records remain intact. */ }
  };
  const put = (intent: CheckoutIntent) => {
    memory = [...read().filter((i) => i.principal.userId !== intent.principal.userId), intent];
    activeUserId = intent.principal.userId;
    persist();
  };
  const adoptLegacy = (principal: CheckoutPrincipal): CheckoutIntent | null => {
    if (legacyRead || !legacy) return null;
    legacyRead = true;
    let raw: string | null = null;
    try { raw = legacy.get(); } catch { raw = null; }
    try { legacy.clear(); } catch { /* best effort */ }
    if (!validKey(raw)) return null;
    const intent: CheckoutIntent = { key: raw, principal, bodyHash: UNKNOWN_BODY_HASH, state: 'sent', createdAt: now(), sentAt: now() };
    put(intent);
    return intent;
  };
  const owned = (key: string, principal: CheckoutPrincipal) => read().find((i) => i.key === key && samePrincipal(i.principal, principal));
  const currentFor = (principal: CheckoutPrincipal): CheckoutIntent | null => {
    const intent = read().find((i) => i.principal.userId === principal.userId) ?? (read().length === 0 ? adoptLegacy(principal) : null);
    return intent && samePrincipal(intent.principal, principal) ? intent : null;
  };
  // Called only by a freshly authorized operation/recovery. A returning account
  // inherits its own unresolved key, but an old generation cannot complete it.
  const resumeFor = (principal: CheckoutPrincipal): CheckoutIntent | null => {
    const intent = read().find((i) => i.principal.userId === principal.userId) ?? (read().length === 0 ? adoptLegacy(principal) : null);
    if (!intent) return null;
    if (samePrincipal(intent.principal, principal)) return intent;
    if (intent.state !== 'sent') return null;
    const adopted = { ...intent, principal };
    put(adopted);
    return adopted;
  };
  return {
    current(): CheckoutIntent | null { return read().find((i) => i.principal.userId === activeUserId) ?? null; },
    currentFor,
    resumeFor,
    begin(input: { principal: CheckoutPrincipal; bodyHash: string }): BeginOutcome {
      const existing = resumeFor(input.principal);
      if (existing) {
        if (existing.bodyHash === input.bodyHash) return { kind: 'reused', key: existing.key, state: existing.state };
        if (existing.state === 'sent') return { kind: 'ambiguous', key: null, pending: existing };
      }
      const intent: CheckoutIntent = { key: mint(), principal: input.principal, bodyHash: input.bodyHash, state: 'open', createdAt: now() };
      put(intent);
      return { kind: 'new', key: intent.key };
    },
    markSent(key: string, principal: CheckoutPrincipal): void {
      const intent = owned(key, principal);
      if (intent && intent.state !== 'sent') put({ ...intent, state: 'sent', sentAt: now() });
    },
    markOpen(key: string, principal: CheckoutPrincipal): void {
      const intent = owned(key, principal);
      if (intent && intent.state !== 'open') put({ ...intent, state: 'open' });
    },
    /** An authoritative completion can remove only the exact operation. */
    end(key: string, principal: CheckoutPrincipal): boolean {
      if (!owned(key, principal)) return false;
      memory = read().filter((i) => !(i.key === key && samePrincipal(i.principal, principal)));
      persist();
      return true;
    },
    /** Cart edits supersede an unsent intent, but never an unknown outcome. */
    invalidateCart(principal: CheckoutPrincipal): void {
      const intent = currentFor(principal);
      if (intent?.state === 'open') {
        memory = read().filter((i) => i !== intent);
        persist();
      }
    },
  };
}

export type CheckoutAttempt = ReturnType<typeof createCheckoutAttempt>;

// ---------------------------------------------------------------------------
// [AX372 R1] An unknown outcome is never read as a failure.
// ---------------------------------------------------------------------------

/** Transport status cannot settle a SENT key. Another send may have committed
 * while this response was delayed, including a first send's 4xx refusal.
 * Only the receipt authority's `none` permits reopening. Committed receipts
 * are handled separately as placed; absent/in-flight evidence stays unknown. */
export type CheckoutFailureOutcome = 'unknown' | 'refused';

export function checkoutFailureOutcome(failure: { status?: number; code?: string; receipt?: ReceiptProbe }): CheckoutFailureOutcome {
  return failure.receipt?.status === 'none' ? 'refused' : 'unknown';
}

/** The receipt probe's answer for a key (GET /customer/checkout/receipts/:key). */
export type ReceiptProbe = { status: 'placed'; orderIds: string[] } | { status: 'in_flight' } | { status: 'none' };

/** The waits between receipt probes while a key is still in flight: backing
 *  off to 15 s, 135 s in all, past the server's 120 s default settle window
 *  for an unknown outcome (CHECKOUT_UNKNOWN_SETTLE_S), after which a missing
 *  receipt is conclusive and the probe can answer "none". */
export const RECEIPT_PROBE_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000];

/** Ask what became of an unresolved intent until the server can say. "placed"
 *  or "none" ends the asking; "in_flight" keeps asking, with backoff. When the
 *  waits run out (or whoever asked is gone) the answer is still "in_flight":
 *  never "none" by default. */
export async function settleUnresolvedIntent(
  probe: () => Promise<ReceiptProbe>,
  options: { sleep?: (ms: number) => Promise<void>; backoffMs?: readonly number[]; stopped?: () => boolean } = {},
): Promise<ReceiptProbe> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  let answer = await probe();
  for (const ms of options.backoffMs ?? RECEIPT_PROBE_BACKOFF_MS) {
    if (answer.status !== 'in_flight' || options.stopped?.()) return answer;
    await sleep(ms);
    if (options.stopped?.()) return answer;
    answer = await probe();
  }
  return answer;
}

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
