import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { decideComplianceReview, fetchCompliance, runComplianceAudit } from '../lib/api';

// Compliance (spec §5.8) over the #221 liability shield: audit runs are the
// evidence trail, violations are already-forced-offline movers, and the
// re-verification queue is the monthly human fraud-net.

export default function Compliance() {
  const queryClient = useQueryClient();
  const [note, setNote] = useState<Record<string, string>>({});
  const q = useQuery({ queryKey: ['compliance'], queryFn: fetchCompliance, refetchInterval: 60_000 });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['compliance'] });
  const run = useMutation({ mutationFn: runComplianceAudit, onSettled: refresh });
  const decide = useMutation({
    mutationFn: ({ id, pass }: { id: string; pass: boolean }) => decideComplianceReview(id, pass, note[id]),
    onSettled: refresh,
  });

  if (q.isLoading) return <p className="text-sm text-neutral-400">Loading compliance…</p>;
  if (q.isError) {
    return (
      <div className="rounded-2xl border border-neutral-200 bg-neutral-100 p-8 text-center">
        <p className="text-sm text-neutral-600">{(q.error as Error).message}</p>
        <button onClick={() => q.refetch()} className="mt-4 rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold">Try again</button>
      </div>
    );
  }

  const d = q.data ?? {};
  const runs: any[] = d.runs ?? [];
  const violations: any[] = d.openViolations ?? [];
  const queue: any[] = d.reviewQueue ?? [];

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-neutral-600">
          Daily invariant check over everyone on the road — evidence kept either way.
        </p>
        <button
          onClick={() => run.mutate()}
          disabled={run.isPending}
          className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold disabled:opacity-40"
        >
          {run.isPending ? 'Auditing…' : 'Run audit now'}
        </button>
      </div>

      {(run.error || decide.error) ? (
        // [WR-019] A failed audit run or pass/fail decision must be seen —
        // force-offline is a safety action; the refetch keeps the case open,
        // and this line says why it is still there.
        <p role="alert" className="text-sm font-semibold text-[var(--swift-red)]">
          {run.error
            ? `Audit run did not start: ${(run.error as Error).message}`
            : `Decision did not record — the case is still open: ${(decide.error as Error).message}`}
        </p>
      ) : null}

      <section>
        <p className="text-xs font-bold uppercase tracking-wider text-neutral-400">
          Open violations · <span className={violations.length ? 'text-[var(--swift-red)]' : 'text-green-600'}>{violations.length}</span>
        </p>
        <div className="mt-2 space-y-2">
          {violations.length === 0 && (
            <p className="rounded-xl border border-dashed border-neutral-200 p-6 text-center text-sm text-neutral-400">
              Nobody is operating outside the rules — the run log below proves it.
            </p>
          )}
          {violations.map((v) => (
            <div key={v.id} className="rounded-xl border border-[var(--swift-red)]/40 bg-[var(--swift-red)]/5 p-4">
              <p className="text-sm font-semibold">
                {[v.user?.firstName, v.user?.lastName].filter(Boolean).join(' ')}{' '}
                <span className="text-xs text-neutral-400">{v.user?.phone}</span>
              </p>
              <p className="mt-1 text-xs text-neutral-500">
                {String(v.reason).replaceAll('_', ' ')} · {v.moverKind} · forced offline{' '}
                {new Date(v.createdAt).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <p className="text-xs font-bold uppercase tracking-wider text-neutral-400">Re-verification queue · {queue.length}</p>
        <div className="mt-2 space-y-2">
          {queue.length === 0 && (
            <p className="rounded-xl border border-dashed border-neutral-200 p-6 text-center text-sm text-neutral-400">
              No open cases — a random sample of active movers is drawn on the 1st monthly.
            </p>
          )}
          {queue.map((c) => (
            <div key={c.id} className="rounded-xl border border-neutral-200 bg-neutral-100 p-4">
              <p className="text-sm font-semibold">
                {[c.user?.firstName, c.user?.lastName].filter(Boolean).join(' ')}{' '}
                <span className="text-xs text-neutral-400">{c.user?.phone}</span>
                <span className="ml-2 text-xs text-amber-600">due {new Date(c.dueAt).toLocaleDateString()}</span>
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  value={note[c.id] ?? ''}
                  onChange={(e) => setNote({ ...note, [c.id]: e.target.value })}
                  placeholder="Note (required to fail)"
                  className="min-w-56 flex-1 rounded-lg border border-neutral-200 bg-black/30 px-2 py-1.5 text-sm outline-none"
                />
                <button
                  onClick={() => decide.mutate({ id: c.id, pass: true })}
                  disabled={decide.isPending}
                  className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                >
                  Documents check out
                </button>
                <button
                  onClick={() => decide.mutate({ id: c.id, pass: false })}
                  disabled={decide.isPending || !(note[c.id] ?? '').trim()}
                  className="rounded-lg bg-[var(--swift-red)] px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                >
                  Fail — force offline
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <p className="text-xs font-bold uppercase tracking-wider text-neutral-400">Audit runs (evidence trail)</p>
        <div className="mt-2 overflow-hidden rounded-xl border border-neutral-200">
          <table className="w-full text-sm">
            <thead className="bg-neutral-100 text-left text-xs text-neutral-400">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Trigger</th>
                <th className="px-3 py-2">Checked</th>
                <th className="px-3 py-2">Violations</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-neutral-100">
                  <td className="px-3 py-2">{new Date(r.startedAt).toLocaleString()}</td>
                  <td className="px-3 py-2 text-neutral-500">{r.trigger}</td>
                  <td className="px-3 py-2">{r.moversChecked}</td>
                  <td className={`px-3 py-2 font-bold ${r.violations > 0 ? 'text-[var(--swift-red)]' : 'text-green-600'}`}>
                    {r.violations}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
