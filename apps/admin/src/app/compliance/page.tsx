'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MutationNotice } from '@/components/MutationNotice';
import { fetchCompliance, runComplianceAudit, decideComplianceReview, resolveComplianceViolation } from '@/lib/api';

/**
 * The liability shield. Three panels:
 *  - Violations: movers found live-operating with a broken checklist (should
 *    be empty — anything here was already forced offline, evidence attached).
 *  - Re-verification queue: the monthly random sample awaiting a human
 *    re-review of their documents.
 *  - Audit runs: the immutable "we checked" trail — every daily run, counts,
 *    zero or not.
 */
export default function CompliancePage() {
  const qc = useQueryClient();
  const [note, setNote] = useState<Record<string, string>>({});
  const [openEvidence, setOpenEvidence] = useState<string | null>(null);

  const q = useQuery({ queryKey: ['compliance'], queryFn: fetchCompliance, refetchInterval: 60_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['compliance'] });

  const run = useMutation({ mutationFn: runComplianceAudit, onSettled: refresh });
  const decide = useMutation({
    mutationFn: ({ id, pass }: { id: string; pass: boolean }) => decideComplianceReview(id, pass, note[id]),
    onSettled: refresh,
  });
  const resolve = useMutation({ mutationFn: resolveComplianceViolation, onSettled: refresh });

  const d = q.data?.data;
  const runs: any[] = d?.runs ?? [];
  const violations: any[] = d?.openViolations ?? [];
  const queue: any[] = d?.reviewQueue ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold">Compliance</h1>
        <MutationNotice errors={[run.error, decide.error, resolve.error]} />
        <button
          onClick={() => run.mutate()}
          disabled={run.isPending}
          className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg text-sm font-medium hover:bg-[var(--accent)]/80 disabled:opacity-50"
        >
          {run.isPending ? 'Auditing…' : 'Run audit now'}
        </button>
      </div>
      <p className="text-[var(--muted)] text-sm mb-6">
        Every day Swift re-checks everyone on the road against their document checklist and keeps the evidence.
        An unlicensed or uninsured mover operating here is a lawsuit — this page is where that never happens.
      </p>

      {/* Open violations */}
      <h2 className="font-semibold mb-2">
        Open violations{' '}
        <span className={violations.length === 0 ? 'text-emerald-400' : 'text-red-400'}>({violations.length})</span>
      </h2>
      <div className="space-y-3 mb-8">
        {violations.length === 0 ? (
          <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-6 text-center text-[var(--muted)]">
            Nobody is operating outside the rules — and the run log below proves it.
          </div>
        ) : (
          violations.map((v) => (
            <div key={v.id} className="bg-[var(--panel)] rounded-xl border border-red-900/60 p-5">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-semibold">
                  {v.user?.firstName} {v.user?.lastName}
                </span>
                <span className="text-xs text-[var(--muted)]">{v.user?.phone}</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 font-bold">
                  {String(v.reason).replaceAll('_', ' ')}
                </span>
                <span className="text-xs text-[var(--muted)]">{v.moverKind}</span>
                <span className="text-xs text-[var(--muted)] ml-auto">{new Date(v.createdAt).toLocaleString()}</span>
              </div>
              <p className="text-sm text-[var(--muted)] mt-2">
                Action taken: <b className="text-white">{String(v.actionTaken).replaceAll('_', ' ')}</b> — they stay
                offline until their documents pass again.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => setOpenEvidence(openEvidence === v.id ? null : v.id)}
                  className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border)] hover:bg-[var(--panel-2)]"
                >
                  {openEvidence === v.id ? 'Hide evidence' : 'View evidence'}
                </button>
                <button
                  onClick={() => resolve.mutate(v.id)}
                  disabled={resolve.isPending}
                  className="px-3 py-1.5 text-xs rounded-lg bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 disabled:opacity-50"
                  title="Only succeeds once their checklist passes again"
                >
                  Mark resolved
                </button>
              </div>
              {openEvidence === v.id && (
                <pre className="mt-3 p-3 rounded-lg bg-black/40 text-xs text-[var(--muted)] overflow-x-auto">
                  {JSON.stringify(v.evidence, null, 2)}
                </pre>
              )}
            </div>
          ))
        )}
      </div>

      {/* Re-verification queue */}
      <h2 className="font-semibold mb-2">Random re-verification queue ({queue.length})</h2>
      <div className="space-y-3 mb-8">
        {queue.length === 0 ? (
          <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-6 text-center text-[var(--muted)]">
            No open cases. A random sample of active movers is drawn on the 1st of each month.
          </div>
        ) : (
          queue.map((c) => (
            <div key={c.id} className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-5">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-semibold">
                  {c.user?.firstName} {c.user?.lastName}
                </span>
                <span className="text-xs text-[var(--muted)]">{c.user?.phone}</span>
                <span className="text-xs text-amber-400">due {new Date(c.dueAt).toLocaleDateString()}</span>
              </div>
              <p className="text-xs text-[var(--muted)] mt-1.5">
                Re-open their documents in Verification and confirm they are genuine and current — then decide here.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  value={note[c.id] ?? ''}
                  onChange={(e) => setNote({ ...note, [c.id]: e.target.value })}
                  placeholder="Note (required for fail)"
                  className="flex-1 min-w-48 bg-[var(--panel-2)] px-3 py-1.5 rounded-lg text-sm border border-[var(--border)] focus:border-[var(--accent)] focus:outline-none"
                />
                <button
                  onClick={() => decide.mutate({ id: c.id, pass: true })}
                  disabled={decide.isPending}
                  className="px-3 py-1.5 text-xs rounded-lg bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 disabled:opacity-50"
                >
                  Documents check out
                </button>
                <button
                  onClick={() => decide.mutate({ id: c.id, pass: false })}
                  disabled={decide.isPending || !(note[c.id] ?? '').trim()}
                  className="px-3 py-1.5 text-xs rounded-lg bg-red-600/20 text-red-400 hover:bg-red-600/30 disabled:opacity-50"
                >
                  Fail — force offline
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Run history */}
      <h2 className="font-semibold mb-2">Audit runs (evidence trail)</h2>
      <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-[var(--muted)] border-b border-[var(--border)]">
            <tr>
              <th className="px-4 py-2.5">When</th>
              <th className="px-4 py-2.5">Trigger</th>
              <th className="px-4 py-2.5">Online movers checked</th>
              <th className="px-4 py-2.5">Violations</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-[var(--muted)]">
                  No runs yet — the daily job writes one every morning, or run one now.
                </td>
              </tr>
            )}
            {runs.map((r) => (
              <tr key={r.id} className="border-b border-[var(--border)]/50 last:border-0">
                <td className="px-4 py-2.5">{new Date(r.startedAt).toLocaleString()}</td>
                <td className="px-4 py-2.5 text-[var(--muted)]">{r.trigger}</td>
                <td className="px-4 py-2.5">{r.moversChecked}</td>
                <td className={`px-4 py-2.5 font-bold ${r.violations > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                  {r.violations}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
