import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { decideAgentApproval, fetchAgentApprovals, fetchAgentAudit, type AgentAuditEvent } from '../lib/api';

// Agent oversight (spec §5.6): everything the ops agent wants a human to
// decide. Money-adjacent actions ONLY execute after a click here — and the
// click renders the server's verdict, never an assumption. Below the queue, a
// live ACTIVITY feed of what the agent has already done on its own.

// The agent's action outcomes, coloured by how autonomous they were.
function OutcomeTag({ outcome }: { outcome: string }) {
  const map: Record<string, string> = {
    auto_executed: 'bg-green-500/20 text-green-300',
    executed: 'bg-green-500/20 text-green-300',
    suggested: 'bg-white/10 text-white/60',
    pending_approval: 'bg-amber-500/20 text-amber-300',
    rejected: 'bg-white/10 text-white/40',
    error: 'bg-[var(--swift-red)]/20 text-[var(--swift-red)]',
  };
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${map[outcome] ?? 'bg-white/10 text-white/60'}`}>{outcome.replaceAll('_', ' ')}</span>;
}

function ActivityFeed() {
  const q = useQuery({ queryKey: ['agent-audit'], queryFn: fetchAgentAudit, refetchInterval: 20_000 });
  const rows: AgentAuditEvent[] = q.data ?? [];
  return (
    <div className="mt-8">
      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-white/40">Recent agent activity</p>
      {q.isLoading && <p className="text-sm text-white/40">Loading…</p>}
      {rows.length === 0 && !q.isLoading && (
        <p className="text-sm text-white/40">Nothing yet — the agent acts when an order needs help (and only once it's turned on with a key in production).</p>
      )}
      <div className="space-y-1">
        {rows.map((e) => (
          <div key={e.id} className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.03] px-3 py-1.5 text-xs">
            <OutcomeTag outcome={e.outcome} />
            <span className="font-semibold text-white/80">{e.action.replaceAll('_', ' ')}</span>
            {e.subjectId && <span className="shrink-0 text-white/40">· order {e.subjectId.slice(0, 8)}</span>}
            {e.reasoning && <span className="min-w-0 flex-1 truncate text-white/50">— {e.reasoning}</span>}
            <span className="ml-auto shrink-0 text-white/30">{new Date(e.at).toLocaleTimeString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AgentDesk() {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['agent-approvals'], queryFn: fetchAgentApprovals, refetchInterval: 20_000 });
  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) => decideAgentApproval(id, approve),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['agent-approvals'] }),
  });

  if (q.isLoading) return <p className="text-sm text-white/40">Loading the approval queue…</p>;
  if (q.isError) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center">
        <p className="text-sm text-white/60">{(q.error as Error).message}</p>
        <button onClick={() => q.refetch()} className="mt-4 rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold">Try again</button>
      </div>
    );
  }

  const rows: any[] = q.data ?? [];

  return (
    <div className="max-w-3xl space-y-3">
      {rows.length === 0 && (
        <p className="rounded-2xl border border-dashed border-white/10 p-10 text-center text-sm text-white/40">
          Nothing waiting on you — the agent's queue is clear.
        </p>
      )}
      {rows.map((r) => (
        <div key={r.id} className="rounded-2xl border border-white/10 bg-white/5 p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-bold">{String(r.action).replaceAll('_', ' ')}</p>
            <span className="text-xs text-white/40">{new Date(r.createdAt).toLocaleString()}</span>
          </div>
          {r.orderId && <p className="mt-1 text-xs text-white/50">order {r.orderId}</p>}
          {r.reasoning && <p className="mt-2 text-sm text-white/70">{r.reasoning}</p>}
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => decide.mutate({ id: r.id, approve: true })}
              disabled={decide.isPending}
              className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold disabled:opacity-40"
            >
              Approve
            </button>
            <button
              onClick={() => decide.mutate({ id: r.id, approve: false })}
              disabled={decide.isPending}
              className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold disabled:opacity-40"
            >
              Reject
            </button>
          </div>
          {decide.isError && <p className="mt-2 text-xs text-[var(--swift-red)]">{(decide.error as Error).message}</p>}
        </div>
      ))}
      <ActivityFeed />
    </div>
  );
}
