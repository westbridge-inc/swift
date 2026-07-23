import { describe, it, expect } from 'vitest';
import { evaluateSchedulerHealth } from './scheduler-health';

const STALL = 5 * 60_000; // 5 min
const BOOT = 1_000_000;

describe('evaluateSchedulerHealth', () => {
  it('fresh heartbeat → no page', () => {
    const now = BOOT + 10 * 60_000;
    expect(evaluateSchedulerHealth({ beat: String(now - 30_000), nowMs: now, bootAtMs: BOOT, stallMs: STALL }))
      .toEqual({ page: false });
  });

  it('stale heartbeat (booted then died) → stall page', () => {
    const now = BOOT + 60 * 60_000;
    const r = evaluateSchedulerHealth({ beat: String(now - 12 * 60_000), nowMs: now, bootAtMs: BOOT, stallMs: STALL });
    expect(r).toMatchObject({ page: true, kind: 'stall' });
    expect((r as { ageMs: number }).ageMs).toBe(12 * 60_000);
  });

  it('no heartbeat but still inside the grace window → no page (fleet may be booting)', () => {
    const now = BOOT + 2 * 60_000; // 2 min < 5 min stall window
    expect(evaluateSchedulerHealth({ beat: null, nowMs: now, bootAtMs: BOOT, stallMs: STALL }))
      .toEqual({ page: false });
  });

  it('no heartbeat and up past the stall window → never-booted page (SWIFT-122: was silently swallowed)', () => {
    const now = BOOT + 20 * 60_000; // 20 min uptime, still no beat ever
    const r = evaluateSchedulerHealth({ beat: null, nowMs: now, bootAtMs: BOOT, stallMs: STALL });
    expect(r).toMatchObject({ page: true, kind: 'never-booted' });
    expect((r as { ageMs: number }).ageMs).toBe(20 * 60_000);
  });

  it('grace boundary is exclusive-safe: exactly at stallMs still holds fire', () => {
    const now = BOOT + STALL;
    expect(evaluateSchedulerHealth({ beat: null, nowMs: now, bootAtMs: BOOT, stallMs: STALL }))
      .toEqual({ page: false });
  });
});
