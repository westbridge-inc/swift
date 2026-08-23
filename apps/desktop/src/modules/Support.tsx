import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchSupport, resolveTicket, type SupportTicket } from '../lib/api';

// Support inbox — the open customer/partner tickets, oldest first. Mark in-
// progress or resolved with a note. No optimistic UI (standing order 38).

const pretty = (t: string) => t.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const hoursSince = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 3600_000);

function Ticket({ t, onDone }: { t: SupportTicket; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const who = t.user ? [t.user.firstName, t.user.lastName].filter(Boolean).join(' ') || t.user.phone : 'someone';

  const mut = useMutation({
    mutationFn: (status: 'IN_PROGRESS' | 'RESOLVED') => resolveTicket(t.id, status, note || undefined),
    onSuccess: onDone,
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="rounded-xl border border-neutral-200 bg-neutral-100 p-4">
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-neutral-100 px-2 py-0.5 text-xs font-bold text-neutral-600">{pretty(t.category)}</span>
        {t.status === 'IN_PROGRESS' && <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">In progress</span>}
        <span className="ml-auto text-xs text-neutral-400">{hoursSince(t.createdAt)}h ago</span>
      </div>
      <p className="mt-2 text-sm font-semibold">{t.subject}</p>
      <p className="mt-1 text-sm text-neutral-600">{t.message}</p>
      <p className="mt-1 text-xs text-neutral-400">
        from {who}{t.user?.phone ? ` · ${t.user.phone}` : ''}{t.orderId ? ` · order ${t.orderId.slice(0, 8)}` : ''}
      </p>

      <div className="mt-3 flex items-center gap-2">
        <input
          // [WR-022] There IS no internal note on this rail: the server sends
          // this text verbatim to the ticket owner. The old "Reply / internal
          // note" label invited operators to type private remarks straight
          // into a customer notification.
          value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reply to the customer — they will see this (optional)"
          className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-sm outline-none focus:border-[var(--swift-red)]"
        />
        <button
          onClick={() => mut.mutate('IN_PROGRESS')} disabled={mut.isPending}
          className="rounded-lg bg-neutral-100 px-3 py-1.5 text-sm font-semibold text-neutral-600 hover:bg-neutral-200 disabled:opacity-50"
        >
          Working on it
        </button>
        <button
          onClick={() => mut.mutate('RESOLVED')} disabled={mut.isPending}
          className="rounded-lg bg-green-100 px-3 py-1.5 text-sm font-semibold text-green-700 hover:bg-green-200 disabled:opacity-50"
        >
          Resolve
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-[var(--swift-red)]">{error}</p>}
    </div>
  );
}

export default function Support() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['support', 'OPEN'], queryFn: () => fetchSupport('OPEN') });
  const onDone = () => qc.invalidateQueries({ queryKey: ['support'] });

  if (q.isLoading) return <p className="text-sm text-neutral-500">Opening the inbox…</p>;
  if (q.isError) return <p className="text-sm text-[var(--swift-red)]">{(q.error as Error).message}</p>;

  const tickets = q.data?.tickets ?? [];
  return (
    <div className="max-w-3xl space-y-3">
      <p className="text-sm text-neutral-500">{tickets.length} open ticket{tickets.length === 1 ? '' : 's'}.</p>
      {tickets.length === 0 && <p className="text-sm text-neutral-400">Inbox zero. 🎉</p>}
      {tickets.map((t) => <Ticket key={t.id} t={t} onDone={onDone} />)}
    </div>
  );
}
