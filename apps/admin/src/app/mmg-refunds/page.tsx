'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchMmgRefunds, resolveMmgRefund, voidMmgRefund } from '@/lib/api';
import { StatusPill } from '@/components/detail';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionRunner } from '@/components/mc/useActionRunner';
import { gyDateTime } from '@/lib/dates';

// ---------------------------------------------------------------------------
// [BUG-HUNT-2 G08] What stores owe customers back by MMG. Swift holds none of this money: every line is a record, and nothing
// here moves any. A refund leaves this list when the customer or support says it arrived, or two people void it.
// ---------------------------------------------------------------------------

const FILTERS = [
  { key: 'open', label: 'Open' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'disputed', label: 'Disputed' },
] as const;
type Filter = (typeof FILTERS)[number]['key'];

const gyd = (amount: string | number) => `GY$${Number(amount).toLocaleString()}`;
const STATUS_WORDS: Record<string, string> = {
  OWED: 'Owed by the store',
  SENT: 'Store says sent, waiting for the customer',
  DISPUTED: 'Customer says it did not arrive',
};

export default function MmgRefundsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>('open');
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({ queryKey: ['mmg-refunds', filter], queryFn: () => fetchMmgRefunds(filter) });
  const actions = useActionRunner(() => qc.invalidateQueries({ queryKey: ['mmg-refunds'] }));
  const [queuedRows, setQueuedRows] = useState<Record<string, true>>({});
  const rows: any[] = data?.data ?? [];

  const find = (r: any, received: boolean) => void actions.run({
    title: received ? `The ${gyd(r.amount)} refund on ${r.orderNumber} arrived?` : `The ${gyd(r.amount)} refund on ${r.orderNumber} did not arrive?`,
    body: received
      ? <p>The refund closes. Both sides are told. Swift moves no money.</p>
      : <p>The store owes it again on a new deadline, and that MMG reference cannot be used again. Both sides are told. Swift moves no money.</p>,
    confirmLabel: received ? 'It arrived' : 'It did not arrive',
    fields: [{ kind: 'text', name: 'note', label: 'What you checked', required: true }],
    submit: ({ reason, values }) => resolveMmgRefund(r.send.id, received, String(values['note']), reason),
    success: () => (received ? 'Refund closed.' : 'Refund owed again.'),
  });
  const voidRow = (r: any) => void actions.run({
    title: `Close the ${gyd(r.amount)} refund record on ${r.orderNumber}?`,
    body: <p>Nothing stays owed on it. The record is kept, both sides are told, and a second admin must agree. Swift moves no money.</p>,
    confirmLabel: 'Close the record',
    fields: [{ kind: 'text', name: 'note', label: 'Why nothing is owed', required: true }],
    submit: ({ reason, values }) => voidMmgRefund(r.id, String(values['note']), reason),
    success: () => 'Refund record closed.',
  }).then((outcome) => {
    if (outcome?.tone === 'queued') setQueuedRows((all) => ({ ...all, [r.id]: true }));
  });

  return (
    <div className="mc-page">
      <div className="flex gap-1 mb-1" role="group" aria-label="Show refunds">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" onClick={() => setFilter(f.key)} aria-pressed={filter === f.key} className="mc-tab">{f.label}</button>
        ))}
      </div>
      <p className="mc-muted text-sm mb-6">
        What stores owe customers back by MMG. Swift holds none of this money. A refund is closed only when the customer or a person here says it arrived.
      </p>
      {actions.banner}
      <div className="space-y-3">
        {isLoading ? (
          <div className="mc-loading h-24" />
        ) : isError ? (
          <QueryFailed error={error} what="the MMG refunds" onRetry={() => void refetch()} retrying={isFetching} />
        ) : rows.length === 0 ? (
          <div className="mc-empty">No MMG refunds here.</div>
        ) : (
          rows.map((r: any) => (
            <div key={r.id} className="mc-card">
              <div className="flex flex-wrap items-center gap-3">
                <StatusPill value={r.overdue ? 'OVERDUE' : r.status} />
                <span className="text-sm font-semibold">{gyd(r.amount)}</span>
                <span className="text-sm">{r.storeName ?? 'Store'}</span>
                <span className="text-xs mc-muted ml-auto">Due {gyDateTime(r.dueAt)}</span>
              </div>
              <p className="text-sm mc-muted mt-2">{STATUS_WORDS[r.status] ?? 'Open'}{r.send?.mmgRefundRef ? `. MMG reference ${r.send.mmgRefundRef}` : ''}</p>
              <div className="flex flex-wrap items-center gap-3 mt-3 text-sm">
                <Link href={`/orders/${r.orderId}`} className="text-[var(--mc-accent)] font-semibold">{r.orderNumber} →</Link>
                {r.status === 'DISPUTED' && r.send ? (
                  <>
                    <button type="button" className="mc-btn" onClick={() => find(r, true)}>It arrived</button>
                    <button type="button" className="mc-btn" onClick={() => find(r, false)}>It did not arrive</button>
                  </>
                ) : null}
                <button type="button" className="mc-btn" disabled={queuedRows[r.id] === true} onClick={() => voidRow(r)}>
                  {queuedRows[r.id] ? 'Waiting for approval' : 'Close the record'}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
