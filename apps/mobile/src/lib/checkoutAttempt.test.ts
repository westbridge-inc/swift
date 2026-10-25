import { describe, expect, it, beforeEach } from 'vitest';
import {
  CHECKOUT_ATTEMPT_STORAGE_KEY, checkoutCounters, checkoutFailureOutcome, createCheckoutAttempt, LEGACY_CHECKOUT_ATTEMPT_STORAGE_KEY, mintCheckoutKey,
  RECEIPT_PROBE_BACKOFF_MS, recordCheckoutOutcome, resetCheckoutCountersForTests, settleUnresolvedIntent, stableBodyHash, UNKNOWN_BODY_HASH,
  type CheckoutKeyStore, type ReceiptProbe,
} from './checkoutAttempt';

// ---------------------------------------------------------------------------
// [TA-S1-001 / MOB-020] One checkout INTENT = one idempotency key.
//
// #990 gave the key the lifetime of an attempt. This suite proves the intent:
// the key follows the principal and the body. The same body reuses the key
// across taps, retries and a restart; an open intent for a changed body is
// superseded; a SENT intent (outcome unknown) with a changed body is refused
// until the server has been asked; another principal's intent is never
// reused; the #990 bare key is adopted once as an unresolved intent.
// ---------------------------------------------------------------------------

function memoryStore(initial: string | null = null): CheckoutKeyStore & { raw: () => string | null } {
  let value = initial;
  return { get: () => value, set: (v) => { value = v; }, clear: () => { value = null; }, raw: () => value };
}
const A = { userId: 'account-a', generation: 1 };
const A2 = { userId: 'account-a', generation: 2 };
const B = { userId: 'account-b', generation: 1 };
const DELIVERY = stableBodyHash({ paymentMethod: 'CASH', tipAmount: 0 });
const PICKUP = stableBodyHash({ paymentMethod: 'CASH', tipAmount: 0, fulfillmentSelections: { v1: 'PICKUP' } });
let n = 0;
const mint = () => `chk_test_${++n}`;

beforeEach(() => { n = 0; resetCheckoutCountersForTests(); });

describe('the key', () => {
  it('fits the server window (8–128 chars) and is unique per mint', () => {
    const keys = new Set(Array.from({ length: 200 }, () => mintCheckoutKey()));
    expect(keys.size).toBe(200);
    for (const k of keys) { expect(k.length).toBeGreaterThanOrEqual(8); expect(k.length).toBeLessThanOrEqual(128); expect(k).toMatch(/^chk_[a-z0-9]+_[a-z0-9]{10}$/); }
  });
  it('pads a short random tail instead of shrinking below the window', () => {
    expect(mintCheckoutKey(1, () => 0)).toMatch(/^chk_1_0{10}$/);
  });
});

describe('the body hash', () => {
  it('is stable across key order, ignores undefined, and changes with any selection', () => {
    expect(stableBodyHash({ a: 1, b: { c: [1, 2] } })).toBe(stableBodyHash({ b: { c: [1, 2] }, a: 1 }));
    expect(stableBodyHash({ a: 1, b: undefined })).toBe(stableBodyHash({ a: 1 }));
    expect(stableBodyHash({ paymentMethod: 'CASH' })).not.toBe(stableBodyHash({ paymentMethod: 'MOBILE_MONEY' }));
    expect(stableBodyHash({ tipAmount: 0 })).not.toBe(stableBodyHash({ tipAmount: 100 }));
    expect(DELIVERY).not.toBe(PICKUP);
    expect(stableBodyHash(undefined)).toBe(stableBodyHash({}));
    expect(stableBodyHash({ x: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('the intent', () => {
  it('is ONE key across every tap and retry of the same body until it ends', () => {
    const attempt = createCheckoutAttempt(memoryStore(), mint);
    const first = attempt.begin({ principal: A, bodyHash: DELIVERY });
    expect(first).toEqual({ kind: 'new', key: 'chk_test_1' });
    attempt.markSent('chk_test_1', A);
    expect(attempt.begin({ principal: A, bodyHash: DELIVERY })).toEqual({ kind: 'reused', key: 'chk_test_1', state: 'sent' });
    expect(attempt.begin({ principal: A, bodyHash: DELIVERY })).toEqual({ kind: 'reused', key: 'chk_test_1', state: 'sent' });
    attempt.end(attempt.current()!.key, A);
    expect(attempt.begin({ principal: A, bodyHash: DELIVERY })).toEqual({ kind: 'new', key: 'chk_test_2' });
  });

  it('an OPEN intent for a changed body is superseded silently — the person changed their mind before anything left the device', () => {
    const attempt = createCheckoutAttempt(memoryStore(), mint);
    attempt.begin({ principal: A, bodyHash: DELIVERY });
    expect(attempt.begin({ principal: A, bodyHash: PICKUP })).toEqual({ kind: 'new', key: 'chk_test_2' });
    expect(attempt.current()).toMatchObject({ key: 'chk_test_2', bodyHash: PICKUP, state: 'open' });
  });

  it('a SENT intent for a changed body is AMBIGUOUS: no key is handed out until the server has been asked', () => {
    const attempt = createCheckoutAttempt(memoryStore(), mint);
    attempt.begin({ principal: A, bodyHash: DELIVERY });
    attempt.markSent('chk_test_1', A);
    const out = attempt.begin({ principal: A, bodyHash: PICKUP });
    expect(out).toMatchObject({ kind: 'ambiguous', key: null, pending: { key: 'chk_test_1', bodyHash: DELIVERY, state: 'sent' } });
    // still the same intent: nothing was minted, nothing was ended
    expect(attempt.current()?.key).toBe('chk_test_1');
    // the server answered "nothing placed": the caller ends it, and the new body gets its own key
    attempt.end(attempt.current()!.key, A);
    expect(attempt.begin({ principal: A, bodyHash: PICKUP })).toEqual({ kind: 'new', key: 'chk_test_2' });
  });

  it('a definitive failure re-opens the intent: the same key may retry, and a changed body may now supersede', () => {
    const attempt = createCheckoutAttempt(memoryStore(), mint);
    attempt.begin({ principal: A, bodyHash: DELIVERY });
    attempt.markSent('chk_test_1', A);
    attempt.markOpen({ key: 'chk_test_1', principal: A, revision: attempt.current()?.revision ?? 0, quiescent: true });
    expect(attempt.begin({ principal: A, bodyHash: DELIVERY })).toEqual({ kind: 'reused', key: 'chk_test_1', state: 'open' });
    expect(attempt.begin({ principal: A, bodyHash: PICKUP })).toEqual({ kind: 'new', key: 'chk_test_2' });
  });

  it('markSent/markOpen touch only the intent they name', () => {
    const attempt = createCheckoutAttempt(memoryStore(), mint);
    attempt.begin({ principal: A, bodyHash: DELIVERY });
    attempt.markSent('chk_test_other', A);
    expect(attempt.current()?.state).toBe('open');
    attempt.markSent('chk_test_1', A);
    attempt.markOpen({ key: 'chk_test_other', principal: A, revision: attempt.current()?.revision ?? 0, quiescent: true });
    expect(attempt.current()?.state).toBe('sent');
  });
});

describe('the principal', () => {
  it('another account’s intent is never reused, and a same-user relogin (new generation) is another principal', () => {
    const store = memoryStore();
    const attempt = createCheckoutAttempt(store, mint);
    attempt.begin({ principal: A, bodyHash: DELIVERY });
    attempt.markSent('chk_test_1', A);
    expect(attempt.currentFor(B)).toBeNull();
    expect(attempt.currentFor(A2)).toBeNull();
    expect(attempt.currentFor(A)?.key).toBe('chk_test_1');
    // B gets a separate key; A's unresolved intent stays privately recoverable.
    expect(attempt.begin({ principal: B, bodyHash: DELIVERY })).toEqual({ kind: 'new', key: 'chk_test_2' });
    expect(attempt.current()?.principal).toEqual(B);
    expect(attempt.currentFor(A)?.key).toBe('chk_test_1');
  });
});

describe('durability', () => {
  it('an app that comes back after dying mid-request replays the same intent — key, body and sent state', () => {
    const store = memoryStore();
    const first = createCheckoutAttempt(store, mint);
    first.begin({ principal: A, bodyHash: DELIVERY });
    first.markSent('chk_test_1', A);
    const fresh = createCheckoutAttempt(store, mint);
    expect(fresh.currentFor(A)).toMatchObject({ key: 'chk_test_1', bodyHash: DELIVERY, state: 'sent' });
    expect(fresh.begin({ principal: A, bodyHash: DELIVERY })).toEqual({ kind: 'reused', key: 'chk_test_1', state: 'sent' });
    expect(fresh.begin({ principal: A, bodyHash: PICKUP }).kind).toBe('ambiguous');
  });

  it('ignores a persisted record that is not an intent (corrupt, wrong shape, key outside the window)', () => {
    for (const raw of ['not json', '"chk_bare"', '{}', JSON.stringify({ key: 'short', principal: A, bodyHash: 'x', state: 'open', createdAt: 1 }), JSON.stringify({ key: 'chk_ok_key_1', principal: { userId: '' }, bodyHash: 'x', state: 'open', createdAt: 1 }), JSON.stringify({ key: 'chk_ok_key_1', principal: A, bodyHash: 'x', state: 'weird', createdAt: 1 })]) {
      const attempt = createCheckoutAttempt(memoryStore(raw), mint);
      expect(attempt.current(), raw).toBeNull();
    }
  });

  it('adopts the #990 bare key ONCE as an unresolved intent of unknown body — a different body must ask the server, the legacy slot is cleared', () => {
    const legacy = memoryStore('chk_legacy_aaaaaaaaaa');
    const store = memoryStore();
    const attempt = createCheckoutAttempt(store, mint, Date.now, legacy);
    const out = attempt.begin({ principal: A, bodyHash: DELIVERY });
    expect(out).toMatchObject({ kind: 'ambiguous', pending: { key: 'chk_legacy_aaaaaaaaaa', bodyHash: UNKNOWN_BODY_HASH, state: 'sent' } });
    expect(legacy.raw()).toBeNull();
    expect(JSON.parse(store.raw()!).intents).toContainEqual(expect.objectContaining({ key: 'chk_legacy_aaaaaaaaaa', principal: A }));
    // resolved: nothing placed → end → a real intent
    attempt.end(attempt.current()!.key, A);
    expect(attempt.begin({ principal: A, bodyHash: DELIVERY })).toEqual({ kind: 'new', key: 'chk_test_1' });
    // a second process never adopts it again
    const again = createCheckoutAttempt(memoryStore(), mint, Date.now, legacy);
    expect(again.begin({ principal: A, bodyHash: DELIVERY })).toEqual({ kind: 'new', key: 'chk_test_2' });
  });

  it('adopts the legacy key ONCE per process even when the legacy slot cannot be cleared — never an endless ambiguity', () => {
    const stuck = { get: () => 'chk_legacy_stuck_key', clear: () => { throw new Error('mmkv read-only'); } };
    const attempt = createCheckoutAttempt(memoryStore(), mint, Date.now, stuck);
    expect(attempt.begin({ principal: A, bodyHash: DELIVERY }).kind).toBe('ambiguous');
    attempt.end(attempt.current()!.key, A); // the server said nothing was placed
    expect(attempt.begin({ principal: A, bodyHash: DELIVERY })).toEqual({ kind: 'new', key: 'chk_test_1' });
    expect(attempt.begin({ principal: A, bodyHash: PICKUP })).toEqual({ kind: 'new', key: 'chk_test_2' });
  });

  it('fails OPEN: a broken store never blocks an order, and memory alone still ends the double tap', () => {
    const broken: CheckoutKeyStore = { get: () => { throw new Error('mmkv closed'); }, set: () => { throw new Error('mmkv closed'); }, clear: () => { throw new Error('mmkv closed'); } };
    const attempt = createCheckoutAttempt(broken, mint);
    expect(attempt.begin({ principal: A, bodyHash: DELIVERY })).toEqual({ kind: 'new', key: 'chk_test_1' });
    expect(attempt.begin({ principal: A, bodyHash: DELIVERY })).toEqual({ kind: 'reused', key: 'chk_test_1', state: 'open' });
    expect(() => attempt.end(attempt.current()!.key, A)).not.toThrow();
  });

  it('names the storage keys apart: the intent record is not written under the #990 slot', () => {
    expect(CHECKOUT_ATTEMPT_STORAGE_KEY).not.toBe(LEGACY_CHECKOUT_ATTEMPT_STORAGE_KEY);
  });
});

describe('the counters', () => {
  it('count replays, key/body conflicts, ambiguous recoveries and in-flight refusals', () => {
    recordCheckoutOutcome('checkout_dedupe_replay');
    recordCheckoutOutcome('key_body_conflict');
    recordCheckoutOutcome('ambiguous_recovery', 'placed');
    recordCheckoutOutcome('ambiguous_recovery', 'none');
    recordCheckoutOutcome('in_flight_refused');
    expect(checkoutCounters()).toEqual({ checkout_dedupe_replay: 1, key_body_conflict: 1, 'ambiguous_recovery:placed': 1, 'ambiguous_recovery:none': 1, in_flight_refused: 1 });
  });
});

describe('[AX372 R1] a failed checkout is read for what it says about the order', () => {
  it('every transport failure stays UNKNOWN until receipt authority proves none', () => {
    expect(checkoutFailureOutcome({})).toBe('unknown');
    expect(checkoutFailureOutcome({ status: 503, code: 'CHECKOUT_OUTCOME_UNKNOWN' })).toBe('unknown');
    expect(checkoutFailureOutcome({ status: 500 })).toBe('unknown');
    expect(checkoutFailureOutcome({ status: 502 })).toBe('unknown');
    expect(checkoutFailureOutcome({ status: 504 })).toBe('unknown');
    expect(checkoutFailureOutcome({ status: 408 })).toBe('unknown');
    // the code is the server saying it cannot tell, whatever status carries it
    expect(checkoutFailureOutcome({ status: 409, code: 'CHECKOUT_OUTCOME_UNKNOWN' })).toBe('unknown');
    expect(checkoutFailureOutcome({ status: 400, code: 'VALIDATION_ERROR' })).toBe('unknown');
    expect(checkoutFailureOutcome({ status: 409, code: 'DELIVERY_NO_RIDERS' })).toBe('unknown');
    expect(checkoutFailureOutcome({ status: 422 })).toBe('unknown');
    // Rate limiting is upstream of the receipt authority.
    expect(checkoutFailureOutcome({ status: 429 })).toBe('unknown');
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      expect(checkoutFailureOutcome({ status })).toBe('unknown');
      expect(checkoutFailureOutcome({ status, receipt: { status: 'in_flight' } })).toBe('unknown');
      expect(checkoutFailureOutcome({ status, receipt: { status: 'none' } })).toBe('refused');
    }
  });
});

describe('[AX372 R1] an unresolved intent is settled by asking the server, with backoff', () => {
  function answers(...seq: ReceiptProbe[]) {
    let asked = 0;
    return { asked: () => asked, probe: async () => seq[Math.min(asked++, seq.length - 1)]! };
  }

  it('keeps asking while the key is in flight, backing off, and stops at the first placed or none', async () => {
    const waits: number[] = [];
    const none = answers({ status: 'in_flight' }, { status: 'in_flight' }, { status: 'none' });
    expect(await settleUnresolvedIntent(none.probe, { sleep: async (ms) => { waits.push(ms); } })).toEqual({ status: 'none' });
    expect(none.asked()).toBe(3);
    expect(waits).toEqual([1_000, 2_000]);
    const placed = answers({ status: 'in_flight' }, { status: 'placed', orderIds: ['o1'] });
    expect(await settleUnresolvedIntent(placed.probe, { sleep: async () => {} })).toEqual({ status: 'placed', orderIds: ['o1'] });
    expect(placed.asked()).toBe(2);
  });

  it('never turns "still in flight" into "none": when the waits run out the answer is in_flight, and the waits back off to 15 s and outlast the server’s 120 s settle window', async () => {
    const waits: number[] = [];
    const stuck = answers({ status: 'in_flight' });
    expect(await settleUnresolvedIntent(stuck.probe, { sleep: async (ms) => { waits.push(ms); } })).toEqual({ status: 'in_flight' });
    expect(waits).toEqual([...RECEIPT_PROBE_BACKOFF_MS]);
    expect(stuck.asked()).toBe(RECEIPT_PROBE_BACKOFF_MS.length + 1);
    for (let i = 1; i < waits.length; i += 1) expect(waits[i]!).toBeGreaterThanOrEqual(waits[i - 1]!);
    expect(Math.max(...waits)).toBe(15_000);
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThan(120_000);
  });

  it('stops asking once whoever asked is gone', async () => {
    let gone = false;
    const stuck = answers({ status: 'in_flight' });
    expect(await settleUnresolvedIntent(stuck.probe, { sleep: async () => { gone = true; }, stopped: () => gone })).toEqual({ status: 'in_flight' });
    expect(stuck.asked()).toBe(1);
  });
});


describe('[SX391] account return preserves unresolved minimal metadata', () => {
  it('A → B → process restart → A new login recovers K without exposing it to B', () => {
    const store = memoryStore();
    const first = createCheckoutAttempt(store, mint);
    const a = first.begin({ principal: A, bodyHash: DELIVERY });
    if (a.kind === 'ambiguous') throw new Error('unexpected initial ambiguity');
    first.markSent(a.key, A);
    const b = first.begin({ principal: B, bodyHash: DELIVERY });
    const fresh = createCheckoutAttempt(store, mint);
    expect(fresh.currentFor(B)?.key).toBe(b.key);
    const resumed = fresh.begin({ principal: A2, bodyHash: PICKUP });
    expect(resumed).toMatchObject({ kind: 'ambiguous', pending: { key: a.key, state: 'sent', principal: A2 } });
    expect(fresh.currentFor(B)?.key).toBe(b.key);
  });
});


describe('[SX391] intent transitions compare both key and principal', () => {
  it('old-generation completion and state changes leave the adopted intent intact', () => {
    const attempt = createCheckoutAttempt(memoryStore(), mint);
    attempt.begin({ principal: A, bodyHash: DELIVERY }); attempt.markSent('chk_test_1', A);
    attempt.resumeFor(A2);
    attempt.markOpen({ key: 'chk_test_1', principal: A, revision: attempt.current()?.revision ?? 0, quiescent: true });
    expect(attempt.end('chk_test_1', A)).toBe(false);
    expect(attempt.currentFor(A2)).toMatchObject({ state: 'sent' });
    attempt.markOpen(attempt.observe('chk_test_1', A2)!);
    attempt.markSent('chk_test_1', A);
    expect(attempt.currentFor(A2)).toMatchObject({ state: 'open' });
    expect(attempt.end('chk_test_wrong', A2)).toBe(false);
    expect(attempt.end('chk_test_1', A2)).toBe(true);
  });
  it('the old v2 intent survives migration and another account using the device', () => {
    const store = memoryStore(JSON.stringify({ key: 'chk_test_v2', principal: A, bodyHash: DELIVERY, state: 'sent', createdAt: 1, sentAt: 2 }));
    const migrated = createCheckoutAttempt(store, mint);
    expect(migrated.currentFor(A)).toMatchObject({ key: 'chk_test_v2', sentAt: 2 });
    migrated.begin({ principal: B, bodyHash: DELIVERY });
    const restarted = createCheckoutAttempt(store, mint);
    expect(restarted.resumeFor(A2)).toMatchObject({ key: 'chk_test_v2', principal: A2, state: 'sent', sentAt: 2 });
  });
});


describe('[SX405] shared send and observation authority', () => {
  it('every send advances revision even when already SENT; old none cannot reopen, replace or end', () => {
    const attempt = createCheckoutAttempt(memoryStore(), mint);
    attempt.begin({ principal: A, bodyHash: DELIVERY });
    const first = attempt.startSend('chk_test_1', A)!; attempt.finishSend(first);
    const oldNone = attempt.observe('chk_test_1', A)!;
    const second = attempt.startSend('chk_test_1', A)!; attempt.finishSend(second);
    expect(second.revision).toBeGreaterThan(oldNone.revision);
    expect(attempt.markOpen(oldNone), 'revision CAS rejects old none').toBe(false);
    expect(attempt.replaceAfterNone(oldNone, PICKUP)).toBeNull();
    expect(attempt.endIfUnchanged(first)).toBe(false);
    expect(attempt.currentFor(A)).toMatchObject({ key: first.key, state: 'sent' });
  });
  it('a current none is consumed atomically and cannot authorize a second transition', () => {
    const attempt = createCheckoutAttempt(memoryStore(), mint);
    attempt.begin({ principal: A, bodyHash: DELIVERY }); attempt.markSent('chk_test_1', A);
    const none = attempt.observe('chk_test_1', A)!;
    expect(attempt.markOpen(none)).toBe(true);
    expect(attempt.markOpen(none)).toBe(false);
    expect(attempt.replaceAfterNone(none, PICKUP)).toBeNull();
    attempt.markSent('chk_test_1', A);
    expect(attempt.replaceAfterNone(attempt.observe('chk_test_1', A)!, PICKUP)).toBe('chk_test_2');
    expect(attempt.currentFor(A)).toMatchObject({ key: 'chk_test_2', bodyHash: PICKUP, state: 'open' });
  });
  it('persists repeated-send revisions and fences old observations on same-generation restart', () => {
    const store = memoryStore(); const attempt = createCheckoutAttempt(store, mint);
    attempt.begin({ principal: A, bodyHash: DELIVERY }); attempt.markSent('chk_test_1', A);
    const oldNone = attempt.observe('chk_test_1', A)!;
    attempt.markSent('chk_test_1', A);
    const persisted = JSON.parse(store.raw()!);
    expect(persisted.version).toBe(4);
    expect(persisted.intents[0].revision, 'repeated send revision persisted').toBe(oldNone.revision + 1);
    const beforeRestart = attempt.observe('chk_test_1', A)!;
    const restarted = createCheckoutAttempt(store, mint);
    expect(restarted.observe('chk_test_1', A)!.revision, 'restart advances persisted revision').toBe(beforeRestart.revision + 1);
    expect(restarted.markOpen(beforeRestart)).toBe(false);
    expect(restarted.replaceAfterNone(oldNone, PICKUP)).toBeNull();
    expect(restarted.currentFor(A)).toMatchObject({ key: 'chk_test_1', state: 'sent' });
  });
  it('adoption persists its revision and old-generation live transport blocks new-generation none', () => {
    const store = memoryStore(); const attempt = createCheckoutAttempt(store, mint);
    attempt.begin({ principal: A, bodyHash: DELIVERY });
    const oldSend = attempt.startSend('chk_test_1', A)!;
    const adopted = attempt.resumeFor(A2)!;
    expect(adopted.revision, 'adoption advances revision').toBe(oldSend.revision + 1);
    expect(JSON.parse(store.raw()!).intents[0].revision).toBe(adopted.revision);
    const none = attempt.observe('chk_test_1', A2)!;
    expect(attempt.markOpen(none), 'old generation live lease blocks none').toBe(false);
    expect(attempt.replaceAfterNone(none, PICKUP)).toBeNull();
    attempt.finishSend({ ...oldSend }); // A lookalike is not the acquired lease.
    expect(attempt.markOpen(none)).toBe(false);
    expect(attempt.markOpen(attempt.observe('chk_test_1', A2)!), 'lookalike cannot release live transport').toBe(false);
    attempt.finishSend(oldSend);
    expect(attempt.markOpen(none), 'live observation stays invalid after lease release').toBe(false);
    expect(attempt.markOpen(attempt.observe('chk_test_1', A2)!)).toBe(true);
  });
  it('placed authority remains valid across a newer same-key send', () => {
    const attempt = createCheckoutAttempt(memoryStore(), mint);
    attempt.begin({ principal: A, bodyHash: DELIVERY });
    const old = attempt.startSend('chk_test_1', A)!; attempt.finishSend(old);
    const newer = attempt.startSend('chk_test_1', A)!;
    expect(attempt.end(old.key, A)).toBe(true);
    expect(attempt.currentFor(A)).toBeNull();
    attempt.finishSend(newer);
  });
  it('old schema records migrate without replacing the unresolved key', () => {
    for (const version of [2, 3]) {
      const intent = { key: 'chk_schema_old', principal: A, bodyHash: DELIVERY, state: 'sent', createdAt: 1 };
      const store = memoryStore(JSON.stringify(version === 2 ? intent : { version, intents: [intent], activeUserId: A.userId }));
      const attempt = createCheckoutAttempt(store, mint);
      expect(attempt.currentFor(A)).toMatchObject({ key: intent.key, state: 'sent', revision: 1 });
      expect(JSON.parse(store.raw()!).version).toBe(4);
    }
  });
});
