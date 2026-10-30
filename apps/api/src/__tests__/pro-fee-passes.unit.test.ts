import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runProFeePasses } from '../jobs/queue';

// [BILL-PRO · REVIEW-M #2229 S4-2] The pro weekly fee passes of the hourly billing job are isolated: a pass that throws
// is logged and pages the admins, the next pass still runs, and nothing throws out, so the billing cycle after them
// always runs.

function ctxStub() {
  const errors: unknown[] = [];
  const ctx = {
    prisma: {} as never,
    io: {} as never,
    redis: { set: vi.fn(async () => 'OK'), del: vi.fn(async () => 1) } as never,
    log: { error: (obj: unknown) => { errors.push(obj); }, info: () => undefined, warn: () => undefined } as never,
  };
  return { ctx, errors };
}

describe('runProFeePasses', () => {
  it('a birth pass that throws: the one-fee pass still runs, the admins are paged, nothing throws', async () => {
    const { ctx, errors } = ctxStub();
    const oneFee = vi.fn(async () => 3);
    const page = vi.fn(async () => 1);
    const out = await runProFeePasses(ctx, { birth: async () => { throw new Error('findMany failed'); }, 'one-fee': oneFee }, page);
    expect(out).toEqual({ birth: 'failed', 'one-fee': 3 });
    expect(oneFee).toHaveBeenCalledTimes(1);
    expect(page).toHaveBeenCalledWith('birth');
    expect(errors).toHaveLength(1);
  });

  it('a one-fee pass that throws is isolated the same way; a failing page never escapes either', async () => {
    const { ctx } = ctxStub();
    const out = await runProFeePasses(ctx, { birth: async () => 2, 'one-fee': async () => { throw new Error('lock timeout'); } }, async () => { throw new Error('notify down'); });
    expect(out).toEqual({ birth: 2, 'one-fee': 'failed' });
  });

  it('nothing fails: no page', async () => {
    const { ctx } = ctxStub();
    const page = vi.fn(async () => 1);
    expect(await runProFeePasses(ctx, { birth: async () => 0, 'one-fee': async () => 0 }, page)).toEqual({ birth: 0, 'one-fee': 0 });
    expect(page).not.toHaveBeenCalled();
  });

  it('the process-billing job runs the passes through it, before the billing cycle, outside any try that could skip the cycle', () => {
    const src = readFileSync(join(__dirname, '..', 'jobs', 'queue.ts'), 'utf8');
    const job = src.slice(src.indexOf("case 'process-billing': {"), src.indexOf("case 'tier-recalc': {"));
    const passes = job.indexOf('await runProFeePasses(ctx, {');
    const cycle = job.indexOf('await billing.runBillingCycle()');
    expect(passes).toBeGreaterThan(0);
    expect(cycle).toBeGreaterThan(passes);
    expect(job.slice(0, cycle)).not.toMatch(/\btry\s*\{/);
  });
});
