import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { evaluateSchedulerHealth, workerCheckStatus } from '../utils/scheduler-health';

// ---------------------------------------------------------------------------
// [BUILD_NOW Band A] "/health reports database, Redis, Meilisearch and worker
// heartbeat SEPARATELY. A green /health that does not check the workers is
// exactly the lie that matters."
//
// The paging machinery already existed: every probe read `scheduler:heartbeat`
// and paged admins on a stall. What it never did was SAY so in the response —
// `checks` was {api, database, redis}, so a load balancer and a human reading
// /health both saw "healthy" with the worker fleet dead. This adds the word,
// derived from the SAME evaluation that decides whether to page, so there is
// one heartbeat and one verdict about it.
// ---------------------------------------------------------------------------

const MIN = 60_000;
const BOOT = 1_000_000;
const STALL = 10 * MIN;

describe('the three words, each true', () => {
  it('a recent heartbeat is ok', () => {
    const now = BOOT + 30 * MIN;
    const beat = String(now - 2 * MIN);
    expect(workerCheckStatus(evaluateSchedulerHealth({ beat, nowMs: now, bootAtMs: BOOT, stallMs: STALL }), beat)).toBe('ok');
  });

  it('no heartbeat inside the boot grace is STARTING — not ok, not error', () => {
    // Not `ok`: a green word for a worker nobody has heard from is the lie.
    // Not `error`: an API that reports degraded for its first minute after
    // every deploy trains people to ignore degraded.
    const now = BOOT + 1 * MIN;
    expect(workerCheckStatus(evaluateSchedulerHealth({ beat: null, nowMs: now, bootAtMs: BOOT, stallMs: STALL }), null)).toBe('starting');
  });

  it('no heartbeat past the grace window is error — the fleet never booted', () => {
    const now = BOOT + STALL + MIN;
    expect(workerCheckStatus(evaluateSchedulerHealth({ beat: null, nowMs: now, bootAtMs: BOOT, stallMs: STALL }), null)).toBe('error');
  });

  it('a stale heartbeat is error — the fleet booted and then died', () => {
    const now = BOOT + 60 * MIN;
    const beat = String(now - STALL - MIN);
    expect(workerCheckStatus(evaluateSchedulerHealth({ beat, nowMs: now, bootAtMs: BOOT, stallMs: STALL }), beat)).toBe('error');
  });

  it('the word and the page always agree', () => {
    // If these ever diverge there are two opinions about whether the workers
    // are alive, which is the disease this file exists to prevent.
    const cases = [
      { beat: null, now: BOOT + MIN },
      { beat: null, now: BOOT + STALL + MIN },
      { beat: String(BOOT + 20 * MIN), now: BOOT + 21 * MIN },
      { beat: String(BOOT + 20 * MIN), now: BOOT + 40 * MIN },
    ];
    for (const c of cases) {
      const h = evaluateSchedulerHealth({ beat: c.beat, nowMs: c.now, bootAtMs: BOOT, stallMs: STALL });
      const word = workerCheckStatus(h, c.beat);
      expect(word === 'error', `beat=${c.beat} now=${c.now}`).toBe(h.page);
    }
  });
});

describe('/health actually says it', () => {
  const src = readFileSync(path.join(__dirname, '..', 'server.ts'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const health = stripped.slice(stripped.indexOf("app.get('/health'"), stripped.indexOf('registerReadinessRoute('));

  it('the worker is a named check in the response', () => {
    expect(health).toContain("checks['worker'] = workerCheckStatus(");
  });

  it('one heartbeat read, one evaluation — the page path reuses the verdict', () => {
    // A second `redis.get('scheduler:heartbeat')` inside the paging block would
    // be a second opinion that can disagree with the word already sent.
    expect(health.match(/scheduler:heartbeat/g)?.length, 'exactly one read of the heartbeat key').toBe(1);
    expect(health.match(/evaluateSchedulerHealth\(/g)?.length, 'exactly one evaluation').toBe(1);
  });

  it('the page path is still fire-and-caught — it never slows or fails a probe [D18]', () => {
    expect(health).toContain('void (async () => {');
    expect(health).toContain('})().catch(() => {});');
    // And the heartbeat read itself cannot fail a probe either.
    expect(health).toContain("app.redis.get('scheduler:heartbeat').catch(() => null)");
  });

  it('starting does not degrade the API; error does', () => {
    expect(health).toContain("every((v) => v === 'ok' || v === 'starting')");
  });
});
