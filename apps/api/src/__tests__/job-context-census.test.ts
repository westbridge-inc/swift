import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Job } from 'bullmq';
import { inJobContext, jobCapability, QUEUE_NAMES } from '../jobs/queue';
import { getTenantContext, runWithTenant } from '../plugins/tenant-context';

// ---------------------------------------------------------------------------
// [L01 · tenant wall] Every background job runs in a NAMED context — never
// unbound.
//
// A job has no request and so no tenant. Every BullMQ handler ran with no
// tenant context at all, which the tenant wall treats as an unbound
// composition root: refused under TENANT_UNSCOPED_ACCESS=deny, and zero rows
// on a walled login. buildWorker now wraps every handler as named system work,
// `job:<queue>:<name>`. This census also fails the day a job name appears
// that nobody has classified (its context is a decision, not a default).
// ---------------------------------------------------------------------------

const QUEUE_SRC = readFileSync(join(__dirname, '..', 'jobs', 'queue.ts'), 'utf8');

/** Every job name the workers handle, classified. PER_ENTITY handlers work for
 *  ONE tenant's object and narrow to it with runWithTenant (follow-up PR);
 *  CROSS_TENANT handlers are platform sweeps — named system work. */
const PER_ENTITY = ['auto-cancel', 'auto-complete', 'dispatch-order', 'offer-timeout', 'route-match', 'sync-vendor', 'vendor-alert-escalate'] as const;
const CROSS_TENANT = [
  'ads-lifecycle', 'ads-release-expired', 'ads-stats-rollup', 'ads-weekly-report', 'agent-cash-sla', 'algo-decision-retention',
  'audit-chain-anchor', 'audit-chain-verify', 'backup-freshness', 'batching-shadow-scan', 'billing-fx-notices', 'billing-invariants',
  'booking-reminders', 'checkout-outbox', 'collusion-affinity-scan', 'compliance-sample', 'convert-trials', 'cw-scan',
  'discovery-backfill', 'discovery-derivation', 'eta-pad-weekly', 'evidence-retention', 'expiry-sweep', 'flag-ratings',
  'guardian-sweep', 'handover-claims-reconcile', 'image-policy-sweep', 'incident-pattern-scan', 'incident-sla-watch',
  'incident-weekly-digest', 'liveness-midshift', 'mmg-link-apply', 'mover-revocation-outbox', 'poll-mmg-billing',
  'prep-shadow-grade', 'prep-stats-nightly', 'process-billing', 'process-settlements', 'promote-sos-grace',
  'qr-attribution-purge', 'rating-actor-fold', 'rating-reminder-sweep', 'rating-stats-recompute', 'reaper-lag',
  'reconcile-dispatch', 'reconcile-earnings', 'release-held-orders', 'retention-sweep', 'rlp-reserve-provision', 'rlp-sweep',
  'scheduler-heartbeat', 'stale-movers', 'supply-watch-scan', 'tier-recalc',
] as const;

describe('[L01] every job runs in a named context', () => {
  it('a wrapped handler runs as system work under its own capability, never unbound', async () => {
    const seen: Array<ReturnType<typeof getTenantContext>> = [];
    const handler = inJobContext(QUEUE_NAMES.DISPATCH, async () => { seen.push(getTenantContext()); });
    await handler({ name: 'reconcile-dispatch', data: {} } as Job);
    await handler({ name: 'stale-movers', data: {} } as Job);
    expect(seen).toEqual([
      { tenantId: null, mode: 'system', capability: 'job:dispatch-jobs:reconcile-dispatch' },
      { tenantId: null, mode: 'system', capability: 'job:dispatch-jobs:stale-movers' },
    ]);
    expect(seen.some((c) => c.mode === 'unbound')).toBe(false);
  });

  it('the context does not leak out of the job, and a job may still narrow itself to one tenant', async () => {
    const handler = inJobContext(QUEUE_NAMES.ORDER, async () => {
      const narrowed = await runWithTenant('swift-default', async () => getTenantContext());
      expect(narrowed).toMatchObject({ tenantId: 'swift-default', mode: 'request' });
      expect(getTenantContext()).toMatchObject({ mode: 'system', capability: 'job:order-jobs:auto-cancel' });
    });
    await handler({ name: 'auto-cancel', data: {} } as Job);
    expect(getTenantContext().mode).toBe('unbound');
    await expect(inJobContext(QUEUE_NAMES.ORDER, async () => { throw new Error('job failed'); })({ name: 'auto-cancel' } as Job)).rejects.toThrow('job failed');
  });

  it('a job without a name still has a capability', () => {
    expect(jobCapability(QUEUE_NAMES.SEARCH, undefined)).toBe('job:search-jobs:unnamed');
  });

  it('every worker is built through the wrapper (one choke point for the API process and the standalone worker)', () => {
    expect(QUEUE_SRC).toMatch(/new Worker\(name, inJobContext\(name, processor\), \{ \.\.\.options, autorun: false \}\)/);
    // and nothing constructs a Worker any other way
    expect(QUEUE_SRC.match(/new Worker\(/g) ?? []).toHaveLength(1);
  });

  it('the census: every job name the workers handle is classified — a new one fails here until someone decides its context', () => {
    const handled = [...new Set([...QUEUE_SRC.matchAll(/(?:job\.name\s*(?:===|!==)\s*|case\s+)'([a-z0-9:_-]+)'/g)].map((m) => m[1]!))].sort();
    const classified = [...PER_ENTITY, ...CROSS_TENANT].sort();
    expect(new Set(classified).size).toBe(classified.length);
    expect(handled).toEqual(classified);
  });
});
