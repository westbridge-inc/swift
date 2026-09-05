import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import {
  evaluateReadiness, getLastReadiness, registerLivenessRoute, registerReadinessRoute, registerRoutedWhileDegradedCounter, resetReadinessForTests,
  type RuntimeReadinessState,
} from '../plugins/readiness';
import { readyReasonCounter, routedWhileDegradedCounter } from '../plugins/observability';

// ---------------------------------------------------------------------------
// [R048-006] Liveness proves only that the process is alive; readiness is
// non-2xx for EVERY unavailable required dependency and names each one; the
// container probe reads the status code; /health says 503 for a known
// failure; the boot contracts complete before listen; a request served while
// the process was last judged not-ready is counted.
//
// Every dependency is broken INDEPENDENTLY against a fake app: the database
// (schema query throws), Redis (ping throws), the queue producer, the
// consumer bundle, the realtime adapter, the clock (host and infrastructure
// clocks disagree), the worker heartbeat (stalled / never booted), and the
// boot contracts (not complete). Then the source pins: /health's status code,
// the pre-listen taxonomy seed, and the Dockerfile probe path.
// ---------------------------------------------------------------------------

type Break = 'database' | 'redis' | 'queueInit' | 'queueConsumers' | 'realtime' | 'clock' | 'worker' | 'boot';

function fakeApp(broken: Set<Break>, opts: { workerStarting?: boolean } = {}) {
  const app = Fastify({ logger: false });
  const nowMs = Date.now();
  const skewMs = broken.has('clock') ? 120_000 : 0;
  const prisma = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
      if (broken.has('database')) throw new Error('database down');
      const sql = Array.from(parts).join(' ');
      if (sql.includes('information_schema.columns')) return [{ ok: true }];
      if (sql.includes('FROM "_prisma_migrations"')) return [{ ok: true }];
      return [{ nowMs: BigInt(nowMs + skewMs) }];
    }),
  };
  const redis = {
    ping: vi.fn(async () => { if (broken.has('redis')) throw new Error('redis down'); return 'PONG'; }),
    time: vi.fn(async () => [String(Math.floor((nowMs + skewMs) / 1_000)), String(((nowMs + skewMs) % 1_000) * 1_000)]),
  };
  app.decorate('prisma', prisma as never);
  app.decorate('redis', redis as never);
  const state: RuntimeReadinessState = {
    checkQueues: () => !broken.has('queueInit'),
    checkConsumers: () => !broken.has('queueConsumers'),
    checkRealtime: () => !broken.has('realtime'),
    checkWorker: () => (broken.has('worker') ? 'error' : opts.workerStarting ? 'starting' : 'ok'),
    checkBoot: () => !broken.has('boot'),
  };
  registerLivenessRoute(app);
  registerReadinessRoute(app, state);
  registerRoutedWhileDegradedCounter(app);
  app.get('/api/v1/customer/home', async () => ({ ok: true }));
  return { app, state, prisma, redis };
}

const reasonCount = async (reason: string) => (await readyReasonCounter.get()).values.find((v) => v.labels['reason'] === reason)?.value ?? 0;
const routedCount = async (family: string) => (await routedWhileDegradedCounter.get()).values.find((v) => v.labels['family'] === family)?.value ?? 0;

describe('[R048-006] liveness is dependency-free', () => {
  it('/live answers 200 with every dependency broken, and touches none of them', async () => {
    const { app, prisma, redis } = fakeApp(new Set<Break>(['database', 'redis', 'queueInit', 'queueConsumers', 'realtime', 'clock', 'worker', 'boot']));
    try {
      const res = await app.inject({ method: 'GET', url: '/live' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'alive' });
      expect(typeof res.json().uptimeSeconds).toBe('number');
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(redis.ping).not.toHaveBeenCalled();
      // ...while readiness on the same process is a 503 that names every one of them
      const ready = await app.inject({ method: 'GET', url: '/ready' });
      expect(ready.statusCode).toBe(503);
      expect(ready.json().reasons.sort()).toEqual(['boot', 'clock', 'database', 'queueConsumers', 'queueInit', 'realtime', 'redis', 'worker']);
    } finally {
      await app.close();
    }
  });
});

describe('[R048-006] readiness is 503 for each unavailable dependency, independently, and names it', () => {
  for (const dep of ['database', 'redis', 'queueInit', 'queueConsumers', 'realtime', 'clock', 'worker', 'boot'] as Break[]) {
    // the clock comparison reads the database clock, so a database outage takes it down too — stated, not hidden
    const expected = dep === 'database' ? ['clock', 'database'] : [dep];
    it(`${dep} broken alone → 503 with reasons=[${expected.join(',')}], counted by reason`, async () => {
      const { app } = fakeApp(new Set<Break>([dep]));
      try {
        const before = await reasonCount(dep);
        const res = await app.inject({ method: 'GET', url: '/ready' });
        expect(res.statusCode).toBe(503);
        const body = res.json();
        expect(body.ready).toBe(false);
        expect([...body.reasons].sort()).toEqual(expected);
        expect(body.deps[dep]).toBe(false);
        for (const [k, v] of Object.entries(body.deps)) if (!expected.includes(k)) expect(v, k).toBe(true);
        expect(await reasonCount(dep)).toBe(before + 1);
      } finally {
        await app.close();
      }
    });
  }

  it('everything available → 200; a worker still inside its boot grace ("starting") is not a failure', async () => {
    const { app } = fakeApp(new Set<Break>(), { workerStarting: true });
    try {
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ready: true, reasons: [], deps: { worker: true, boot: true } });
    } finally {
      await app.close();
    }
  });

  it('the Docker probe semantics: a 503 fails the probe, a 200 passes it', async () => {
    // the Dockerfile exits on `r.ok` — model exactly that on both answers
    const { app } = fakeApp(new Set<Break>(['worker']));
    try {
      const bad = await app.inject({ method: 'GET', url: '/ready' });
      expect(bad.statusCode >= 200 && bad.statusCode < 300).toBe(false);
    } finally {
      await app.close();
    }
    const { app: good } = fakeApp(new Set<Break>());
    try {
      const ok = await good.inject({ method: 'GET', url: '/ready' });
      expect(ok.statusCode >= 200 && ok.statusCode < 300).toBe(true);
    } finally {
      await good.close();
    }
  });
});

describe('[R048-006] requests routed while the process was last judged not-ready are counted', () => {
  it('a request after a 503 readiness is counted by family; after a 200 it is not; probes themselves never count', async () => {
    resetReadinessForTests();
    const { app, state } = fakeApp(new Set<Break>(['queueInit']));
    try {
      const before = await routedCount('customer');
      await app.inject({ method: 'GET', url: '/api/v1/customer/home' }); // no verdict yet: not counted
      expect(await routedCount('customer')).toBe(before);
      await app.inject({ method: 'GET', url: '/ready' });
      expect(getLastReadiness()?.ready).toBe(false);
      await app.inject({ method: 'GET', url: '/api/v1/customer/home' });
      await app.inject({ method: 'GET', url: '/live' });
      await app.inject({ method: 'GET', url: '/ready' });
      expect(await routedCount('customer')).toBe(before + 1);
      state.checkQueues = () => true;
      await app.inject({ method: 'GET', url: '/ready' });
      expect(getLastReadiness()?.ready).toBe(true);
      await app.inject({ method: 'GET', url: '/api/v1/customer/home' });
      expect(await routedCount('customer')).toBe(before + 1);
    } finally {
      await app.close();
      resetReadinessForTests();
    }
  });

  it('evaluateReadiness publishes the last snapshot', async () => {
    resetReadinessForTests();
    const { app, state } = fakeApp(new Set<Break>(['boot']));
    try {
      const snap = await evaluateReadiness(app as never, state);
      expect(snap.ready).toBe(false);
      expect(getLastReadiness()).toBe(snap);
    } finally {
      await app.close();
      resetReadinessForTests();
    }
  });
});

describe('[R048-006] the server and the container say it', () => {
  // The composition root is src/app.ts (server.ts only boots it).
  const server = readFileSync(join(__dirname, '..', 'app.ts'), 'utf8');
  // The boot sequence (start(): listen, then the seeds and the boot-contract mark) stays in server.ts.
  const boot = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8');
  const dockerfile = readFileSync(join(__dirname, '..', '..', 'Dockerfile'), 'utf8');

  it('/health answers 503 when degraded — never a 200 for a known failure', () => {
    const health = server.slice(server.indexOf("app.get('/health'"), server.indexOf('registerReadinessRoute(app'));
    expect(health).toContain("app.get('/health', async (request, reply) =>");
    expect(health).toContain('reply.status(allOk ? 200 : 503);');
  });

  it('liveness and the routed-while-degraded counter are registered; readiness carries the worker heartbeat and the boot contracts', () => {
    expect(server).toContain('registerLivenessRoute(app);');
    expect(server).toContain('registerRoutedWhileDegradedCounter(app);');
    expect(server).toMatch(/checkWorker: async \(\) => \{[\s\S]*scheduler:heartbeat[\s\S]*workerCheckStatus\(/);
    expect(server).toContain('checkBoot: () => bootContractsComplete,');
  });

  it('the required taxonomy is a boot contract that READINESS proves — not a reason to refuse the port', () => {
    // The clause's complaint is that "readiness does not prove all application
    // boot side effects". It is not that the seed runs after listen, and the
    // older law (seeders-have-callers.test.ts) still holds for good reasons:
    // open the port early so /live answers and the process is inspectable, and
    // never let a degraded category rail take the API down.
    //
    // Both stand when READINESS is the proof. The seed keeps its place and
    // keeps catching its own failure; the contract is marked complete only on
    // success, and /ready and /health answer 503 until then. A failed seed
    // leaves a process that is alive and never sent traffic — better than a
    // crash loop, and better than a green container with an empty rail.
    const start = boot.slice(boot.indexOf('async function start()'));
    const seedAt = start.indexOf('await seedDiscoveryTaxonomy(app.prisma)');
    const markAt = start.indexOf('app.markBootContractsComplete();');
    expect(seedAt).toBeGreaterThan(0);
    expect(markAt).toBeGreaterThan(seedAt);
    // the mark is INSIDE the seed's own try, so a failure cannot reach it
    const seedBlock = start.slice(seedAt, start.indexOf('} catch (err) {', seedAt));
    expect(seedBlock).toContain('app.markBootContractsComplete();');
    // and the failure is still caught, never fatal
    expect(start).toContain('taxonomy seed failed — the category rail will be empty');
    expect(start.slice(seedAt, start.indexOf('})();', seedAt))).not.toMatch(/process\.exit/);
  });

  it('the scheduler page goes through the durable outbox, and the page is closed when the condition clears', () => {
    expect(server).toContain('await pageOps({ prisma: app.prisma, redis: app.redis');
    expect(server).not.toContain("notifyAdmins(app.prisma, new NotificationService(app.prisma, app.io), {\n        // Boot/infra failure");
    expect(server).toContain("resolveOpsPage(app.prisma, 'Job scheduler stalled')");
  });

  it('the container probe is READINESS (/ready) and exits on the status code; liveness is documented as /live', () => {
    const probe = dockerfile.slice(dockerfile.indexOf('HEALTHCHECK'));
    expect(probe).toContain("/ready')");
    expect(probe).not.toContain("/health')");
    expect(probe).toContain('process.exit(r.ok?0:1)');
    expect(dockerfile).toContain('GET /live');
  });
});
