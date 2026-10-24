'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchReturns, resolveReturn, settleReturnRefund } from '@/lib/api';
import { StatusPill } from '@/components/detail';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionRunner } from '@/components/mc/useActionRunner';

const FILTERS = ['REQUESTED', 'APPROVED', 'REFUND_DUE', 'REJECTED', 'REFUNDED'] as const;

export default function ReturnsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('REQUESTED');
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({ queryKey: ['returns', filter], queryFn: () => fetchReturns(filter) });
  // [U06] Deciding and settling a return are C4 (money): the first answer is a
  // second admin's approval. Both used to show nothing — a queued ask looked
  // like a dead button, a refusal was swallowed — which invited a second press
  // and a duplicate approval. The panel shows every answer; once a row's ask is
  // queued its buttons are locked.
  const actions = useActionRunner(() => qc.invalidateQueries({ queryKey: ['returns'] }));
  const [queuedRows, setQueuedRows] = useState<Record<string, true>>({});
  const lockIfQueued = (id: string) => (outcome: { tone: string } | null) => {
    if (outcome?.tone === 'queued') setQueuedRows((all) => ({ ...all, [id]: true }));
  };
  const decide = (r: any, status: 'APPROVED' | 'REJECTED' | 'REFUND_DUE') => {
    const label = status === 'REFUND_DUE' ? 'Refund owed' : status === 'APPROVED' ? 'Approve' : 'Reject';
    void actions.run({
      title: status === 'REFUND_DUE' ? 'Record that a refund is owed on this return?' : `${label} this return?`,
      body: status === 'REFUND_DUE'
        ? <p>This does not move money: you record the transfer separately once it is sent.</p>
        : <p>The customer is told the decision.</p>,
      confirmLabel: label,
      fields: [{ kind: 'text', name: 'note', label: 'Note for the record', hint: 'Optional' }],
      submit: ({ reason, values }) => resolveReturn(r.id, status, String(values['note'] ?? '') || undefined, reason),
      success: () => (status === 'REFUND_DUE' ? 'Refund recorded as owed.' : status === 'APPROVED' ? 'Return approved.' : 'Return rejected.'),
    }).then(lockIfQueued(r.id));
  };
  // [A-13] Settling is a SEPARATE act from deciding: the money moved, and here
  // is the transfer that moved it. What is typed is what is sent: the amount is
  // never pre-filled from the owed figure, so the server's attested-amount
  // check still means something.
  const settle = (r: any) => void actions.run({
    title: 'Record this refund as paid?',
    body: <p>{r.refundAmount ? `Owed: GY$${Number(r.refundAmount).toLocaleString()}. ` : ''}Type the amount you actually sent and the transfer&apos;s reference.</p>,
    confirmLabel: 'Record the transfer',
    fields: [
      { kind: 'reference', name: 'reference', label: 'Transfer reference for the refund you sent' },
      { kind: 'amount', name: 'amount', label: 'Amount you actually refunded (GYD)', cents: true },
    ],
    submit: ({ reason, values }) => settleReturnRefund(r.id, String(values['reference']), Number(values['amount']), undefined, reason),
    success: () => 'Refund recorded as paid.',
  }).then(lockIfQueued(r.id));

  const rows: any[] = data?.data ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold">Retail returns</h1>
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              className={`px-2.5 py-1 rounded-lg text-xs ${
                filter === f ? 'bg-white text-black font-semibold' : 'bg-white/5 text-[var(--muted)] hover:bg-white/10'
              }`}
            >
              {f.toLowerCase()}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[var(--muted)] text-sm mb-6">
        Return requests on retail orders. Deciding to refund records that money is <b>owed</b>; a return
        only becomes <b>refunded</b> once the transfer that paid it is recorded here.
      </p>

      {actions.banner}
      <div className="space-y-3">
        {isLoading ? (
          <div className="h-24 rounded-xl bg-[var(--panel)] border border-[var(--border)] animate-pulse" />
        ) : isError ? (
          <QueryFailed error={error} what="the returns" onRetry={() => void refetch()} retrying={isFetching} />
        ) : rows.length === 0 ? (
          <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-8 text-center text-[var(--muted)]">
            No {filter.toLowerCase()} returns.
          </div>
        ) : (
          rows.map((r: any) => (
            <div key={r.id} className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-5">
              <div className="flex flex-wrap items-center gap-3">
                <StatusPill value={r.status} />
                <span className="text-sm">{r.reason ?? 'No reason given'}</span>
                <span className="text-xs text-[var(--muted)] ml-auto">{new Date(r.createdAt).toLocaleString()}</span>
              </div>
              <div className="flex flex-wrap items-center gap-4 mt-3 text-sm text-[var(--muted)]">
                <Link href={`/orders/${r.orderId}`} className="hover:text-[var(--accent)] transition-colors">
                  View order →
                </Link>
                {r.resolutionNote ? <span className="italic">“{r.resolutionNote}”</span> : null}
              </div>
              {/* [A-13] A REFUNDED row that carries no transfer reference was closed
                  before evidence was required. It is not rewritten — it is shown
                  for what it is, so nobody reads it as a proved payment. */}
              {r.status === 'REFUNDED' && !r.refundRef && (
                <p className="mt-3 text-sm text-amber-400">
                  Closed before a transfer reference was required — no evidence on file that the money was sent.
                </p>
              )}
              {r.status === 'REFUNDED' && r.refundRef && (
                <p className="mt-3 text-sm text-[var(--muted)]">
                  Settled with reference <span className="font-mono">{r.refundRef}</span>
                  {r.refundPaidAmount ? ` for $${Number(r.refundPaidAmount).toLocaleString()}` : ''}.
                </p>
              )}
              {r.status === 'REFUND_DUE' && (
                <div className="mt-4">
                  <p className="text-sm text-amber-400 mb-2">
                    Refund owed{r.refundAmount ? ` — $${Number(r.refundAmount).toLocaleString()}` : ''}. Not yet paid.
                  </p>
                  <button
                    type="button"
                    onClick={() => settle(r)}
                    disabled={queuedRows[r.id] === true}
                    className="px-4 py-2 rounded-lg text-sm bg-[var(--accent)] hover:bg-[var(--accent)]/80 disabled:opacity-50"
                  >
                    {queuedRows[r.id] ? 'Waiting for approval' : 'Record the transfer'}
                  </button>
                </div>
              )}
              {queuedRows[r.id] ? (
                <p role="status" className="mt-3 text-xs text-amber-500">
                  Waiting for a second admin&apos;s approval. Do not ask again: once approved, apply it from{' '}
                  <Link href="/approvals" className="underline">Approvals</Link>.
                </p>
              ) : null}
              {r.status === 'REQUESTED' && (
                <div className="flex gap-2 mt-4">
                  {(['APPROVED', 'REFUND_DUE', 'REJECTED'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => decide(r, s)}
                      disabled={queuedRows[r.id] === true}
                      className={`px-4 py-2 rounded-lg text-sm disabled:opacity-50 ${
                        s === 'REJECTED' ? 'border border-[var(--border)] hover:bg-white/10' : s === 'REFUND_DUE' ? 'bg-[var(--accent)] hover:bg-[var(--accent)]/80' : 'border border-[var(--border)] hover:bg-white/10'
                      }`}
                    >
                      {s === 'REFUND_DUE' ? 'Refund owed' : s.charAt(0) + s.slice(1).toLowerCase()}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
