import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchModerationQueue, resolveReport, type ModerationReport } from '../lib/api';

// UGC moderation queue (store-compliance §5.4). Consumes the STORE-001/002 API:
// report → queue → resolve. No optimistic UI (standing order 38): a decision
// renders its server result. Enforcement (ban/remove) uses the People/Vendors
// modules — resolving a report records the DECISION.

const pretty = (t: string) => t.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const hoursSince = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 3600_000);

// The reported content, whatever its type — one honest line per target.
function targetSummary(r: ModerationReport): string {
  const t = r.target;
  if (!t) return '(content already removed)';
  if (r.targetType === 'RATING') return `${'★'.repeat(Number(t['score']) || 0)} "${t['comment'] ?? ''}"`;
  if (r.targetType === 'CHAT_MESSAGE') return `"${t['message'] ?? ''}"`;
  if (r.targetType === 'USER') return [t['firstName'], t['lastName']].filter(Boolean).join(' ') || String(t['id'] ?? '');
  if (r.targetType === 'VENDOR') return String(t['name'] ?? '');
  if (r.targetType === 'ITEM') return String(t['name'] ?? '');
  return r.targetId;
}

function Row({ r, onResolved }: { r: ModerationReport; onResolved: () => void }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const isCsae = r.reason === 'CSAE';

  const mut = useMutation({
    mutationFn: (status: 'ACTIONED' | 'DISMISSED') => resolveReport(r.id, status, note || undefined),
    onSuccess: onResolved,
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className={`rounded-xl border p-4 ${isCsae ? 'border-[var(--swift-red)]/60 bg-[var(--swift-red)]/10' : 'border-white/10 bg-white/5'}`}>
      <div className="flex items-center gap-2">
        <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${isCsae ? 'bg-[var(--swift-red)] text-white' : 'bg-white/10 text-white/70'}`}>
          {pretty(r.reason)}
        </span>
        <span className="text-xs text-white/40">on a {pretty(r.targetType).toLowerCase()}</span>
        <span className="ml-auto text-xs text-white/30">{hoursSince(r.createdAt)}h ago</span>
      </div>

      <p className="mt-2 text-sm text-white/90">{targetSummary(r)}</p>
      {r.detail && <p className="mt-1 text-xs italic text-white/50">Reporter said: “{r.detail}”</p>}

      <div className="mt-3 flex items-center gap-2">
        <input
          value={note} onChange={(e) => setNote(e.target.value)} placeholder="Resolution note (optional)"
          className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm outline-none focus:border-white/30"
        />
        <button
          onClick={() => mut.mutate('ACTIONED')} disabled={mut.isPending}
          className="rounded-lg bg-green-500/20 px-3 py-1.5 text-sm font-semibold text-green-300 hover:bg-green-500/30 disabled:opacity-50"
        >
          Action taken
        </button>
        <button
          onClick={() => mut.mutate('DISMISSED')} disabled={mut.isPending}
          className="rounded-lg bg-white/10 px-3 py-1.5 text-sm font-semibold text-white/60 hover:bg-white/15 disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-[var(--swift-red)]">{error}</p>}
    </div>
  );
}

export default function Moderation() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['moderation', 'PENDING'], queryFn: () => fetchModerationQueue('PENDING') });
  const onResolved = () => qc.invalidateQueries({ queryKey: ['moderation'] });

  if (q.isLoading) return <p className="text-sm text-white/50">Loading the moderation queue…</p>;
  if (q.isError) return <p className="text-sm text-[var(--swift-red)]">{(q.error as Error).message}</p>;

  // Child-safety reports float to the top of the queue (the rest stay FIFO).
  const rows = [...(q.data?.rows ?? [])].sort((a, b) => Number(b.reason === 'CSAE') - Number(a.reason === 'CSAE'));
  return (
    <div className="max-w-3xl space-y-3">
      <p className="text-sm text-white/50">
        {q.data?.pendingTotal ?? 0} open report{(q.data?.pendingTotal ?? 0) === 1 ? '' : 's'} — child-safety (CSAE) first.
      </p>
      {rows.length === 0 && <p className="text-sm text-white/40">Nothing to review. 🎉</p>}
      {rows.map((r) => <Row key={r.id} r={r} onResolved={onResolved} />)}
    </div>
  );
}
