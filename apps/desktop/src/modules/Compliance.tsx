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

  if (q.isLoading) return <p className="text-sm text-white/40">Loading compliance…</p>;
  if (q.isError) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center">
        <p className="text-sm text-white/60">{(q.error as Error).message}</p>
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
        <p className="text-sm text-white/60">
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

      <section>
        <p className="text-xs font-bold uppercase tracking-wider text-white/40">
          Open violations · <span className={violations.length ? 'text-[var(--swift-red)]' : 'text-green-400'}>{violations.length}</span>
        </p>
        <div className="mt-2 space-y-2">
          {violations.length === 0 && (
            <p className="rounded-xl border border-dashed border-white/10 p-6 text-center text-sm text-white/40">
              Nobody is operating outside the rules — the run log below proves it.
            </p>
          )}
          {violations.map((v) => (
            <div key={v.id} className="rounded-xl border border-[var(--swift-red)]/40 bg-[var(--swift-red)]/5 p-4">
              <p className="text-sm font-semibold">
                {[v.user?.firstName, v.user?.lastName].filter(Boolean).join(' ')}{' '}
                <span className="text-xs text-white/40">{v.user?.phone}</span>
              </p>
              <p className="mt-1 text-xs text-white/50">
                {String(v.reason).replaceAll('_', ' ')} · {v.moverKind} · forced offline{' '}
                {new Date(v.createdAt).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <p className="text-xs font-bold uppercase tracking-wider text-white/40">Re-verification queue · {queue.length}</p>
        <div className="mt-2 space-y-2">
          {queue.length === 0 && (
            <p className="rounded-xl border border-dashed border-white/10 p-6 text-center text-sm text-white/40">
              No open cases — a random sample of active movers is drawn on the 1st monthly.
            </p>
          )}
          {queue.map((c) => (
            <div key={c.id} className="rounded-xl border border-white/10 bg-white/5 p-4">
              <p className="text-sm font-semibold">
                {[c.user?.firstName, c.user?.lastName].filter(Boolean).join(' ')}{' '}
                <span className="text-xs text-white/40">{c.user?.phone}</span>
                <span className="ml-2 text-xs text-amber-400">due {new Date(c.dueAt).toLocaleDateString()}</span>
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  value={note[c.id] ?? ''}
                  onChange={(e) => setNote({ ...note, [c.id]: e.target.value })}
                  placeholder="Note (required to fail)"
                  className="min-w-56 flex-1 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-sm outline-none"
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
        <p className="text-xs font-bold uppercase tracking-wider text-white/40">Audit runs (evidence trail)</p>
        <div className="mt-2 overflow-hidden rounded-xl border border-white/10">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-left text-xs text-white/40">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Trigger</th>
                <th className="px-3 py-2">Checked</th>
                <th className="px-3 py-2">Violations</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-white/5">
                  <td className="px-3 py-2">{new Date(r.startedAt).toLocaleString()}</td>
                  <td className="px-3 py-2 text-white/50">{r.trigger}</td>
                  <td className="px-3 py-2">{r.moversChecked}</td>
                  <td className={`px-3 py-2 font-bold ${r.violations > 0 ? 'text-[var(--swift-red)]' : 'text-green-400'}`}>
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
