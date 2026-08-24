import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
  if (r.targetType === 'RATING') {
    const review = `${'★'.repeat(Number(t['score']) || 0)} "${t['comment'] ?? ''}"`;
    return t['response'] ? `${review} · Store reply: "${String(t['response'])}"` : review;
  }
  if (r.targetType === 'RATING_RESPONSE') return `Store reply: "${String(t['response'] ?? '')}"`;
  if (r.targetType === 'CHAT_MESSAGE') return `"${t['message'] ?? ''}"`;
  if (r.targetType === 'USER') return [t['firstName'], t['lastName']].filter(Boolean).join(' ') || String(t['id'] ?? '');
  if (r.targetType === 'VENDOR' || r.targetType === 'ITEM' || r.targetType === 'CATEGORY') {
    return [t['name'], t['description']].filter(Boolean).map(String).join(' — ');
  }
  if (r.targetType === 'PROMO_CODE') return [t['code'], t['description']].filter(Boolean).map(String).join(' — ');
  if (r.targetType === 'SERVICE_PROVIDER') return [t['trade'], t['bio']].filter(Boolean).map(String).join(' — ');
  if (r.targetType === 'SERVICE_JOB') return String(t['description'] ?? t['id'] ?? '');
  if (r.targetType === 'ORDER') {
    return [t['orderNumber'], t['deliveryInstructions'], t['courierPackageDescription']]
      .filter(Boolean).map(String).join(' — ');
  }
  if (r.targetType === 'AD_CREATIVE') return [t['headline'], t['body'], t['ctaLabel']].filter(Boolean).map(String).join(' — ');
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
    <div className={`rounded-xl border p-4 ${isCsae ? 'border-[var(--swift-red)]/60 bg-[var(--swift-red)]/10' : 'border-neutral-200 bg-neutral-100'}`}>
      <div className="flex items-center gap-2">
        <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${isCsae ? 'bg-[var(--swift-red)] text-white' : 'bg-neutral-100 text-neutral-600'}`}>
          {pretty(r.reason)}
        </span>
        <span className="text-xs text-neutral-400">on a {pretty(r.targetType).toLowerCase()}</span>
        <span className="ml-auto text-xs text-neutral-400">{hoursSince(r.createdAt)}h ago</span>
      </div>

      <p className="mt-2 text-sm text-neutral-800">{targetSummary(r)}</p>
      {r.detail && <p className="mt-1 text-xs italic text-neutral-500">Reporter said: “{r.detail}”</p>}
      <p className="mt-2 text-xs text-neutral-500">
        Target ID: <code className="select-all rounded bg-neutral-200 px-1 py-0.5">{r.targetId}</code>
      </p>
      {r.target && (
        <details className="mt-2 text-xs text-neutral-500">
          <summary className="cursor-pointer font-semibold">Evidence snapshot and account IDs</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-200 p-2">
            {JSON.stringify(r.target, null, 2)}
          </pre>
        </details>
      )}

      <div className="mt-3 flex items-center gap-2">
        <input
          value={note} onChange={(e) => setNote(e.target.value)} placeholder="Resolution note (optional)"
          className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-sm outline-none focus:border-[var(--swift-red)]"
        />
        <button
          onClick={() => mut.mutate('ACTIONED')} disabled={mut.isPending}
          className="rounded-lg bg-green-100 px-3 py-1.5 text-sm font-semibold text-green-700 hover:bg-green-200 disabled:opacity-50"
        >
          Mark handled
        </button>
        <button
          onClick={() => mut.mutate('DISMISSED')} disabled={mut.isPending}
          className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-semibold text-neutral-600 hover:bg-neutral-200 disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
      {/* [WR-021 / VG-007] "Action taken" implied enforcement; the server only
          records the decision. Say exactly what this does — especially on CSAE
          rows, where implying content was removed would be dangerous. */}
      <p className="mt-2 text-xs text-neutral-400">
        Marking handled records your decision on the report — it does not remove content or suspend anyone. Do that
        directly in People, Vendors, or the target-specific review tool first if the report warrants it. Use the
        target and account IDs above to locate the retained evidence.
      </p>
      {error && <p className="mt-2 text-xs text-[var(--swift-red)]">{error}</p>}
    </div>
  );
}

export default function Moderation() {
  const qc = useQueryClient();
  const q = useInfiniteQuery({
    queryKey: ['moderation', 'PENDING'],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => fetchModerationQueue('PENDING', pageParam),
    getNextPageParam: (lastPage) => lastPage.meta.hasNext ? lastPage.meta.page + 1 : undefined,
  });
  const onResolved = () => qc.invalidateQueries({ queryKey: ['moderation'] });

  if (q.isLoading) return <p className="text-sm text-neutral-500">Loading the moderation queue…</p>;
  if (q.isError) return <p className="text-sm text-[var(--swift-red)]">{(q.error as Error).message}</p>;

  // Child-safety reports float to the top of the queue (the rest stay FIFO).
  const rows = (q.data?.pages.flatMap((page) => page.rows) ?? [])
    .sort((a, b) => Number(b.reason === 'CSAE') - Number(a.reason === 'CSAE'));
  const pendingTotal = q.data?.pages[0]?.pendingTotal ?? 0;
  return (
    <div className="max-w-3xl space-y-3">
      <p className="text-sm text-neutral-500">
        {pendingTotal} open report{pendingTotal === 1 ? '' : 's'} — child-safety (CSAE) first.
      </p>
      {rows.length === 0 && <p className="text-sm text-neutral-400">Nothing to review. 🎉</p>}
      {rows.map((r) => <Row key={r.id} r={r} onResolved={onResolved} />)}
      {q.hasNextPage ? (
        <button
          type="button"
          onClick={() => { void q.fetchNextPage(); }}
          disabled={q.isFetchingNextPage}
          className="w-full rounded-xl border border-neutral-200 bg-neutral-100 px-4 py-3 text-sm font-semibold text-neutral-700 hover:bg-neutral-200 disabled:opacity-50"
        >
          {q.isFetchingNextPage ? 'Loading more reports…' : 'Load more reports'}
        </button>
      ) : null}
      {q.isFetchNextPageError ? (
        <p className="text-sm text-[var(--swift-red)]">
          Couldn’t load more reports. Try again.
        </p>
      ) : null}
    </div>
  );
}
