/**
 * Container healthcheck for the dedicated worker process (docker-compose.yml
 * worker service) [STG-D].
 *
 * The worker (dist/worker.js) serves no HTTP, so the API image's HEALTHCHECK —
 * a GET /ready — could never succeed and the worker container was permanently
 * "unhealthy" while /health reported worker: ok. This probe reads the SAME
 * signal /health and /ready use to decide the worker fleet is alive — the
 * `scheduler:heartbeat` Redis key the recurring scheduler-heartbeat job writes
 * every 60s (apps/api/src/jobs/queue.ts) — and exits 0 only for a fresh beat.
 *
 * In the compose topology the worker is the ONLY RUN_WORKERS=1 process, so a
 * fresh key IS this worker alive and consuming. The stall window comes from
 * the same total-parsed setting the API uses (SCHEDULER_STALL_ALERT_MINUTES),
 * so a probe verdict can never contradict the API's word about the workers.
 * Docker's start_period (120s) covers boot before the first beat lands.
 */
import Redis from 'ioredis';
import { schedulerStallMs } from '../utils/scheduler-health';

/** The pure verdict, unit-tested: a beat is healthy when present, numeric and
 *  no older than the stall window. Missing or unparseable means unhealthy. */
export function workerProbeOk(beat: string | null, nowMs: number, stallMs: number): boolean {
  if (beat === null) return false;
  const beatMs = Number(beat);
  if (!Number.isFinite(beatMs)) return false;
  return nowMs - beatMs <= stallMs;
}

/** Runs the probe and exits 0 (healthy) or 1 (unhealthy). Exported (rather
 *  than auto-run) so the compose healthcheck invokes it explicitly and unit
 *  tests can import the module without a Redis connection or a process exit. */
export async function main(): Promise<void> {
  const redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
    lazyConnect: true,
    connectTimeout: 3000,
    commandTimeout: 3000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  let ok = false;
  try {
    await redis.connect();
    const beat = await redis.get('scheduler:heartbeat');
    ok = workerProbeOk(beat, Date.now(), schedulerStallMs());
  } catch {
    ok = false;
  } finally {
    redis.disconnect();
  }
  process.exit(ok ? 0 : 1);
}
