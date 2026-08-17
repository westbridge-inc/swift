import { describe, it, expect } from 'vitest';
import {
  cacheUsable,
  cacheTrackable,
  pruneQueue,
  restoreQueue,
  takeBatch,
  takeBatchForScope,
  retireQueueScope,
  applyVerdicts,
  CACHE_TTL_MS,
  EVENT_MAX_AGE_MS,
  BATCH_MAX,
  type QueuedAdEvent,
} from './adsCore';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const ev = (over: Partial<QueuedAdEvent> = {}): QueuedAdEvent => ({
  id: over.id ?? `e-${Math.random().toString(36).slice(2, 8)}`,
  scope: over.scope ?? { kind: 'ANONYMOUS', scopeId: 'guest-1', generation: 0 },
  token: over.token ?? `t-${Math.random().toString(36).slice(2, 8)}`,
  eventType: 'IMPRESSION',
  occurredAt: new Date(NOW - 1000).toISOString(),
  attempts: 0,
  retryAt: 0,
  ...over,
});

describe('serve cache windows (§13/E7)', () => {
  it('usable ≤1h, collapses after', () => {
    expect(cacheUsable(NOW - CACHE_TTL_MS, NOW)).toBe(true);
    expect(cacheUsable(NOW - CACHE_TTL_MS - 1, NOW)).toBe(false);
  });

  it('trackable only inside the serve ttl — display-only after', () => {
    expect(cacheTrackable(NOW - 200_000, 300, NOW)).toBe(true);
    expect(cacheTrackable(NOW - 301_000, 300, NOW)).toBe(false);
  });
});

describe('event queue (§12.2)', () => {
  const accountA = { kind: 'AUTHENTICATED', scopeId: 'account-a-1', generation: 1 } as const;
  const accountB = { kind: 'AUTHENTICATED', scopeId: 'account-b-1', generation: 3 } as const;

  it('drops ambiguous legacy ownerless rows during persisted-queue migration', () => {
    const current = ev();
    const legacy = {
      token: 'legacy-token',
      eventType: 'IMPRESSION',
      occurredAt: new Date(NOW - 1000).toISOString(),
      attempts: 0,
      retryAt: 0,
    };

    expect(restoreQueue([legacy, current], NOW)).toEqual([current]);
  });

  it('drops a persisted row with a non-contract event type before batching', () => {
    const invalid = { ...ev(), eventType: 'NOT_A_REAL_AD_EVENT' };

    expect(restoreQueue([invalid], NOW)).toEqual([]);
  });

  it('batches only the requested principal and never mixes authenticated with anonymous', () => {
    const anonymous = ev({ id: 'anonymous', scope: { kind: 'ANONYMOUS', scopeId: 'guest-1', generation: 0 } });
    const a = ev({ id: 'a', scope: accountA });
    const b = ev({ id: 'b', scope: accountB });
    const queue = [anonymous, a, b];

    expect(takeBatchForScope(queue, accountA, NOW).map((event) => event.id)).toEqual(['a']);
    expect(takeBatchForScope(queue, accountB, NOW).map((event) => event.id)).toEqual(['b']);
    expect(takeBatchForScope(queue, anonymous.scope, NOW).map((event) => event.id)).toEqual(['anonymous']);
  });

  it('retires only the captured A scope, preserving anonymous and B work', () => {
    const anonymous = ev({ id: 'anonymous' });
    const a = ev({ id: 'a', scope: accountA });
    const b = ev({ id: 'b', scope: accountB });

    expect(retireQueueScope([anonymous, a, b], accountA).map((event) => event.id))
      .toEqual(['anonymous', 'b']);
  });

  it('prunes events older than 24h', () => {
    const fresh = ev();
    const stale = ev({ occurredAt: new Date(NOW - EVENT_MAX_AGE_MS - 1000).toISOString() });
    expect(pruneQueue([fresh, stale], NOW).map((e) => e.token)).toEqual([fresh.token]);
  });

  it('batches oldest-first, ≤50, only retry-eligible', () => {
    const backingOff = ev({ retryAt: NOW + 60_000 });
    const many = Array.from({ length: 60 }, (_, i) => ev({ occurredAt: new Date(NOW - 60_000 + i * 100).toISOString() }));
    const batch = takeBatch([backingOff, ...many], NOW);
    expect(batch).toHaveLength(BATCH_MAX);
    expect(batch.some((e) => e.token === backingOff.token)).toBe(false);
    expect(Date.parse(batch[0]!.occurredAt)).toBeLessThanOrEqual(Date.parse(batch[1]!.occurredAt));
  });

  it('accepted/duplicate/invalid leave the queue; failures back off exponentially', () => {
    const a = ev();
    const d = ev();
    const i = ev();
    const f = ev();
    const queue = [a, d, i, f];
    const sent = [a, d, i, f];
    const next = applyVerdicts(queue, sent, ['accepted', 'duplicate', 'invalid'], NOW);
    expect(next.map((e) => e.token)).toEqual([f.token]);
    expect(next[0]!.attempts).toBe(1);
    expect(next[0]!.retryAt).toBe(NOW + 60_000); // 30s · 2^1

    // Whole-batch transport failure (verdicts null): everything sent backs off.
    const after = applyVerdicts([a, f], [a, f], null, NOW);
    expect(after).toHaveLength(2);
    expect(after.every((e) => e.retryAt > NOW)).toBe(true);
  });

  it('backoff caps at 15 minutes', () => {
    const tired = ev({ attempts: 12 });
    const next = applyVerdicts([tired], [tired], null, NOW);
    expect(next[0]!.retryAt).toBe(NOW + 15 * 60_000);
  });

  it('unsent events are untouched by a flush', () => {
    const sent = ev();
    const waiting = ev();
    const next = applyVerdicts([sent, waiting], [sent], ['accepted'], NOW);
    expect(next.map((e) => e.token)).toEqual([waiting.token]);
    expect(next[0]!.attempts).toBe(0);
  });

  it('keys verdicts by local event ID so a late A result cannot mutate B', () => {
    const a = ev({ id: 'event-a', scope: accountA, token: 'same-token' });
    const b = ev({ id: 'event-b', scope: accountB, token: 'same-token' });

    const next = applyVerdicts([a, b], [a], ['accepted'], NOW);

    expect(next).toEqual([b]);
    expect(next[0]!.attempts).toBe(0);
    expect(next[0]!.retryAt).toBe(0);
  });
});
