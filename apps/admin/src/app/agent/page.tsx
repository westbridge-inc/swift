'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchAgentApprovals, decideAgentApproval, fetchAgentAudit } from '@/lib/api';
import { StatusPill } from '@/components/detail';

const OUTCOME_CLS: Record<string, string> = {
  executed: 'text-emerald-400',
  auto_executed: 'text-emerald-400',
  pending_approval: 'text-amber-400',
  suggested: 'text-sky-400',
  rejected: 'text-[#8E8E93]',
  error: 'text-red-400',
};

/**
 * The ops agent's console: what it wants a human to decide (approvals) and
 * everything it has done or suggested (append-only audit). The agent only
 * ever proposes money-adjacent actions — this page is where they live or die.
 */
export default function AgentPage() {
  const qc = useQueryClient();
  const [showAudit, setShowAudit] = useState(false);
  const approvalsQ = useQuery({ queryKey: ['agent-approvals'], queryFn: () => fetchAgentApprovals(), refetchInterval: 30_000 });
  const auditQ = useQuery({ queryKey: ['agent-audit'], queryFn: () => fetchAgentAudit(), enabled: showAudit });
  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) => decideAgentApproval(id, approve),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-approvals'] });
      qc.invalidateQueries({ queryKey: ['agent-audit'] });
    },
  });

  const rows: any[] = approvalsQ.data?.data ?? [];
  const audit: any[] = auditQ.data?.data ?? [];

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Ops agent</h1>
      <p className="text-[#8E8E93] text-sm mb-6">
        The agent detects stuck orders and proposes fixes. Safe nudges run on their own; anything money-adjacent waits here for you.
      </p>

      <div className="space-y-3 mb-8">
        {approvalsQ.isLoading ? (
          <div className="h-24 rounded-xl bg-[#1C1C1E] border border-[#38383A] animate-pulse" />
        ) : rows.length === 0 ? (
          <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] p-8 text-center text-[#8E8E93]">
            Nothing waiting on you — the queue is clear.
          </div>
        ) : (
          rows.map((r: any) => (
            <div key={r.id} className="bg-[#1C1C1E] rounded-xl border border-[#38383A] p-5">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-semibold">{String(r.action).replaceAll('_', ' ')}</span>
                <StatusPill value={r.status} />
                <span className="text-xs text-[#8E8E93] ml-auto">{new Date(r.createdAt).toLocaleString()}</span>
              </div>
              {r.reasoning ? <p className="text-sm text-[#8E8E93] mt-2">{r.reasoning}</p> : null}
              <div className="flex items-center gap-4 mt-3">
                {r.orderId ? (
                  <Link href={`/orders/${r.orderId}`} className="text-sm text-[#8E8E93] hover:text-[#E8192C] transition-colors">
                    View order →
                  </Link>
                ) : null}
                <div className="ml-auto flex gap-2">
                  <button
                    onClick={() => {
                      if (window.confirm(`Reject this ${String(r.action).replaceAll('_', ' ')} proposal? Nothing will execute.`))
                        decide.mutate({ id: r.id, approve: false });
                    }}
                    disabled={decide.isPending}
                    className="px-4 py-2 rounded-lg text-sm border border-[#38383A] hover:bg-white/10 disabled:opacity-50"
                  >
                    Reject
                  </button>
                  <button
                    onClick={() => {
                      if (window.confirm(`Approve and EXECUTE ${String(r.action).replaceAll('_', ' ')}? This acts on the real order.`))
                        decide.mutate({ id: r.id, approve: true });
                    }}
                    disabled={decide.isPending}
                    className="px-4 py-2 rounded-lg text-sm bg-[#E8192C] hover:bg-[#E8192C]/80 disabled:opacity-50"
                  >
                    Approve & execute
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <button onClick={() => setShowAudit((s) => !s)} className="text-sm text-[#8E8E93] hover:text-white mb-3">
        {showAudit ? 'Hide' : 'Show'} the agent&apos;s audit trail →
      </button>
      {showAudit && (
        <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] p-4 space-y-1.5">
          {audit.length === 0 ? (
            <p className="text-sm text-[#8E8E93] p-2">No agent activity yet.</p>
          ) : (
            audit.map((e: any) => (
              <div key={e.id} className="flex items-center gap-3 text-xs p-1.5">
                <span className="text-[#8E8E93] w-36 shrink-0">{new Date(e.at).toLocaleString()}</span>
                <span className="font-mono">{String(e.action).replaceAll('_', ' ')}</span>
                <span className={OUTCOME_CLS[e.outcome] ?? 'text-[#8E8E93]'}>{e.outcome.replaceAll('_', ' ')}</span>
                {e.subjectId ? (
                  <Link href={`/orders/${e.subjectId}`} className="text-[#8E8E93] hover:text-[#E8192C] ml-auto shrink-0">
                    order →
                  </Link>
                ) : null}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
