import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { discardDlqJob, fetchAlertsHealth, fetchDlq, fetchHealth, requeueDlqJob } from '../lib/api';

// Health (spec §5.7): is the platform alive, and what died in the queues.
// The DLQ is where retry-exhausted jobs get eyes; requeue/discard are audited.
// Alert delivery (alerts spec §A4): ack rate + median time-to-ack per kind —
// how silently-failing pushes get caught before they become churn.

export default function Health() {
  const queryClient = useQueryClient();
  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth, refetchInterval: 15_000 });
  const dlq = useQuery({ queryKey: ['dlq'], queryFn: fetchDlq, refetchInterval: 30_000 });
  const alerts = useQuery({ queryKey: ['alerts-health'], queryFn: fetchAlertsHealth, refetchInterval: 60_000 });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['dlq'] });
  const requeue = useMutation({
    mutationFn: ({ queue, id }: { queue: string; id: string }) => requeueDlqJob(queue, id),
    onSettled: refresh,
  });
  const discard = useMutation({
    mutationFn: ({ queue, id }: { queue: string; id: string }) => discardDlqJob(queue, id),
    onSettled: refresh,
  });

  const h = health.data;
  const healthy = h?.status === 'healthy';
  const checks: Record<string, string> = h?.checks ?? {};
  const jobs: any[] = dlq.data ?? [];

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center gap-4">
        <div className={`rounded-2xl border p-5 ${healthy ? 'border-green-500/40 bg-green-500/10' : 'border-[var(--swift-red)]/50 bg-[var(--swift-red)]/10'}`}>
          <p className="text-[11px] font-bold uppercase tracking-wider text-neutral-400">API</p>
          <p className={`mt-1 text-2xl font-extrabold ${healthy ? 'text-green-600' : 'text-[var(--swift-red)]'}`}>
            {health.isError ? 'UNREACHABLE' : (h?.status ?? '…').toUpperCase()}
          </p>
          {typeof h?.uptime === 'number' && (
            <p className="mt-1 text-xs text-neutral-400">up {Math.floor(h.uptime / 3600)}h {Math.floor((h.uptime % 3600) / 60)}m</p>
          )}
        </div>
        {Object.entries(checks).map(([dep, state]) => (
          <div key={dep} className="rounded-2xl border border-neutral-200 bg-neutral-100 p-5">
            <p className="text-[11px] font-bold uppercase tracking-wider text-neutral-400">{dep}</p>
            <p className={`mt-1 text-lg font-extrabold ${state === 'ok' ? 'text-green-600' : 'text-[var(--swift-red)]'}`}>
              {state.toUpperCase()}
            </p>
          </div>
        ))}
      </div>

      <section>
        <p className="text-xs font-bold uppercase tracking-wider text-neutral-400">
          Alert delivery · last {alerts.data?.windowHours ?? 24}h
        </p>
        <div className="mt-2 flex flex-wrap gap-3">
          {(alerts.data?.kinds ?? []).length === 0 && (
            <p className="rounded-xl border border-dashed border-neutral-200 p-4 text-sm text-neutral-400">
              No alerts sent in the window.
            </p>
          )}
          {(alerts.data?.kinds ?? []).map((k: any) => (
            <div
              key={k.kind}
              className={`rounded-2xl border p-4 ${k.breaching ? 'border-[var(--swift-red)]/50 bg-[var(--swift-red)]/10' : 'border-neutral-200 bg-neutral-100'}`}
            >
              <p className="text-[11px] font-bold uppercase tracking-wider text-neutral-400">{k.kind}</p>
              <p className={`mt-1 text-lg font-extrabold ${k.breaching ? 'text-[var(--swift-red)]' : 'text-green-600'}`}>
                {k.ackRate === null ? '—' : `${Math.round(k.ackRate * 100)}% acked`}
              </p>
              <p className="mt-1 text-xs text-neutral-400">
                {k.acked}/{k.sent} · median {k.medianTimeToAckSeconds === null ? '—' : `${k.medianTimeToAckSeconds}s`} to ack
              </p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <p className="text-xs font-bold uppercase tracking-wider text-neutral-400">
          Dead-letter queue · <span className={jobs.length ? 'text-[var(--swift-red)]' : 'text-green-600'}>{jobs.length}</span>
        </p>
        {dlq.isError && (
          <p className="mt-2 rounded-xl border border-neutral-200 bg-neutral-100 p-4 text-sm text-neutral-600">
            {(dlq.error as Error).message}
          </p>
        )}
        <div className="mt-2 space-y-2">
          {jobs.length === 0 && !dlq.isError && (
            <p className="rounded-xl border border-dashed border-neutral-200 p-8 text-center text-sm text-neutral-400">
              No dead jobs — every background task either finished or is still retrying.
            </p>
          )}
          {jobs.map((j) => (
            <div key={`${j.queue}:${j.id}`} className="rounded-xl border border-neutral-200 bg-neutral-100 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold">
                  {j.queue} · {j.name}
                  <span className="ml-2 text-xs text-neutral-400">#{j.id} · {j.attemptsMade} attempts</span>
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => requeue.mutate({ queue: j.queue, id: j.id })}
                    disabled={requeue.isPending}
                    className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                  >
                    Requeue
                  </button>
                  <button
                    onClick={() => discard.mutate({ queue: j.queue, id: j.id })}
                    disabled={discard.isPending}
                    className="rounded-lg bg-[var(--swift-red)] px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                  >
                    Discard
                  </button>
                </div>
              </div>
              {j.failedReason && <p className="mt-1 text-xs text-[var(--swift-red)]">{j.failedReason}</p>}
              <p className="mt-1 truncate text-xs text-neutral-400">{j.data}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
