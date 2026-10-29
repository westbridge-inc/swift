import { Queue, QueueEvents, Worker } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bullConnectionOpts, DEFAULT_JOB_OPTIONS, inJobContext } from '../jobs/queue';
import { JOB_RECOVERY, recoveryFor } from '../jobs/recovery-policy';

// ---------------------------------------------------------------------------
// [Item 63] Automatic retries are a replay, so they follow the same rule as an
// operator's replay: only a job class CERTIFIED as safe to repeat
// (SAFE_REPLAY in recovery-policy.ts) is run again by BullMQ. Any other class
// fails once and stays on the dead-letter list for a person — a money, stock
// or custody job must never repeat an effect it already made.
//
// Real BullMQ failure transitions: the handler has already made its effect and
// then throws, so counting invocations proves whether BullMQ repeats it. A
// "prior start" is a run whose worker died mid-job (BullMQ's stalled
// recovery puts it back in the queue): an uncertified class is refused before
// its handler runs again.
// ---------------------------------------------------------------------------

async function run(name: string, priorStarted: number) {
  const redis = new Redis(process.env['REDIS_URL']!);
  const connection = bullConnectionOpts(redis);
  const queueName = `retry-policy-test-${randomUUID()}`;
  const queue = new Queue(queueName, { connection });
  const events = new QueueEvents(queueName, { connection });
  const effects: string[] = [];
  const worker = new Worker(queueName, inJobContext(queueName, async () => {
    effects.push('effect committed');
    throw new Error('synthetic failure after effect');
  }), { connection, autorun: false });
  try {
    await events.waitUntilReady();
    // A producer's own options (or an old job's) cannot grant an uncertified retry.
    const job = await queue.add(name, {}, { ...DEFAULT_JOB_OPTIONS, attempts: 3, backoff: { type: 'fixed', delay: 1 } });
    if (priorStarted) {
      // What BullMQ itself persists before a stalled job returns to waiting.
      const client = await queue.client;
      await client.hset(queue.toKey(job.id!), { ats: String(priorStarted), stc: '1' });
    }
    const finished = job.waitUntilFinished(events, 15_000).then(() => null, (err: unknown) => err as Error);
    void worker.run();
    const error = await finished;
    const failed = await queue.getJob(job.id!);
    return { error, effects, attemptsMade: failed!.attemptsMade, state: await failed!.getState() };
  } finally {
    await worker.close();
    await events.close();
    await queue.obliterate({ force: true });
    await queue.close();
    redis.disconnect();
  }
}

describe('[Item 63] automatic retries require certified replay safety', () => {
  it.each([
    'process-billing', // money: a weekly fee charged twice is the failure this exists to stop
    'unknown-dispatch-test-job', // a class nobody has classified is refused, not assumed safe
  ])('%s is not certified: it fails once, with its own reason, and its effect is not repeated', async (name) => {
    expect(recoveryFor(name).policy).not.toBe('SAFE_REPLAY');
    const r = await run(name, 0);
    expect(r.error?.message).toContain('synthetic failure after effect');
    expect(r.effects).toHaveLength(1);
    expect(r.attemptsMade).toBe(1);
    expect(r.state).toBe('failed');
  });

  it.each(['dispatch-order', 'auto-cancel', 'auto-complete'])('%s is certified: a transient failure is still retried with backoff', async (name) => {
    expect(recoveryFor(name).policy).toBe('SAFE_REPLAY');
    const r = await run(name, 0);
    expect(r.error?.message).toContain('synthetic failure after effect');
    expect(r.effects).toHaveLength(3);
    expect(r.attemptsMade).toBe(3);
    expect(r.state).toBe('failed');
  });

  it.each(['process-billing', 'vendor-alert-escalate'])('a stalled uncertified job (%s) is refused before its handler runs again, and stays dead for a person', async (name) => {
    const r = await run(name, 1);
    expect(r.error?.message).toContain('Automatic replay is not certified for this job class');
    expect(r.effects).toHaveLength(0);
    expect(r.attemptsMade).toBe(1);
    expect(r.state).toBe('failed');
  });

  it('a stalled certified job resumes as before', async () => {
    const r = await run('dispatch-order', 1);
    expect(r.error?.message).toContain('synthetic failure after effect');
    expect(r.effects).toHaveLength(3);
    expect(r.attemptsMade).toBe(3);
  });

  it('a failure keeps its own code and cause for the logs and error reports', async () => {
    const redis = new Redis(process.env['REDIS_URL']!);
    const connection = bullConnectionOpts(redis);
    const queueName = `retry-policy-cause-${randomUUID()}`;
    const queue = new Queue(queueName, { connection });
    const original = Object.assign(new Error('store said no'), { code: 'STORE_REFUSED' });
    const worker = new Worker(queueName, inJobContext(queueName, async () => { throw original; }), { connection, autorun: false });
    // Wait for the worker's OWN failed event: the queue-events stream can report
    // the failure before the worker emits it locally, so waiting on the job
    // alone raced (main a5ef9bf1 saw `undefined`).
    const seen = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the worker never reported the failure')), 15_000);
      worker.once('failed', (_job, err) => { clearTimeout(timer); resolve(err); });
    });
    try {
      await queue.add('process-billing', {}, { attempts: 3 });
      void worker.run();
      expect(await seen).toMatchObject({ message: 'store said no', code: 'STORE_REFUSED', cause: original });
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      redis.disconnect();
    }
  });

  it('every class the workers dispatch has a recovery answer, including the ones guarded by !==', () => {
    for (const name of ['vendor-alert-escalate', 'process-settlements', 'sync-vendor']) {
      expect(Object.keys(JOB_RECOVERY), name).toContain(name);
    }
    expect(JOB_RECOVERY['vendor-alert-escalate' as keyof typeof JOB_RECOVERY]?.policy).toBe('RECONCILE_FIRST');
  });

  it('the one-shot order jobs with no backstop sweep stay retryable — each was certified by reading its handler', () => {
    // auto-cancel and auto-complete are single delayed jobs per order: if a
    // transient failure were final, the order would sit PENDING / DELIVERED
    // until a person noticed. Their certification names the property.
    for (const name of ['auto-cancel', 'auto-complete'] as const) {
      expect(JOB_RECOVERY[name].policy, name).toBe('SAFE_REPLAY');
      expect(JOB_RECOVERY[name].why, name).toMatch(/compare-and-set/);
    }
  });
});
