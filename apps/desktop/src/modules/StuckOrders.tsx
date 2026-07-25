import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchSlaBreaches, retryDispatch, type SlaBreach } from '../lib/api';

// The stuck-order rail (FUL-008). Live delivery orders past their stage SLA,
// worst first — the human view alongside the autonomous ops-agent. No optimistic
// UI (standing order 38). Refreshes every 15s so the board stays live.

const STAGE_LABEL: Record<string, string> = {
  ACCEPT: 'waiting for the store to accept',
  PREP: 'the kitchen is behind',
  PICKUP_WAIT: 'ready, waiting for a rider',
  DELIVERY: 'out for delivery, running long',
};
const overMin = (ms: number) => Math.round(ms / 60_000);

function Row({ b, onActed }: { b: SlaBreach; onActed: () => void }) {
  // A rider-side stall (ready but nobody's coming) is the one an operator can
  // act on from here — re-run dispatch. Other stages are store/rider nudges the
  // agent handles; here we just surface them.
  const canRedispatch = b.openStage === 'PICKUP_WAIT';
  const mut = useMutation({ mutationFn: () => retryDispatch(b.orderId), onSuccess: onActed });

  return (
    <div className="flex items-center gap-3 rounded-xl border border-neutral-200 bg-neutral-100 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">#{b.orderNumber} <span className="ml-1 text-xs font-normal text-neutral-400">{b.status}</span></p>
        <p className="text-xs text-neutral-500">{b.openStage ? STAGE_LABEL[b.openStage] ?? b.openStage : 'stalled'}</p>
      </div>
      <span className="rounded-md bg-[var(--swift-red)]/15 px-2 py-1 text-xs font-bold text-[var(--swift-red)]">
        +{overMin(b.worstOverMs)} min over
      </span>
      {canRedispatch && (
        <button
          onClick={() => mut.mutate()} disabled={mut.isPending}
          className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-semibold text-neutral-700 hover:bg-neutral-200 disabled:opacity-50"
        >
          {mut.isPending ? '…' : 'Find a rider'}
        </button>
      )}
    </div>
  );
}

export default function StuckOrders() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sla-breaches'], queryFn: fetchSlaBreaches, refetchInterval: 15_000 });
  const onActed = () => qc.invalidateQueries({ queryKey: ['sla-breaches'] });

  if (q.isLoading) return <p className="text-sm text-neutral-500">Checking the clocks…</p>;
  if (q.isError) return <p className="text-sm text-[var(--swift-red)]">{(q.error as Error).message}</p>;

  const rows = q.data?.rows ?? [];
  return (
    <div className="max-w-3xl space-y-3">
      <p className="text-sm text-neutral-500">
        {rows.length === 0
          ? 'No orders are breaching their SLA — the agent and the auto-sweeps are keeping up.'
          : `${rows.length} order${rows.length === 1 ? '' : 's'} past SLA, worst first.`}
        {q.data?.truncated && <span className="text-neutral-400"> (scan capped at {q.data.scanned})</span>}
      </p>
      {rows.map((b) => <Row key={b.orderId} b={b} onActed={onActed} />)}
    </div>
  );
}
