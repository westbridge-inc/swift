'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchReturns, resolveReturn, settleReturnRefund } from '@/lib/api';
import { StatusPill } from '@/components/detail';
import { useActionRunner } from '@/components/mc/useActionRunner';
import { QueryFailed } from '@/components/mc/QueryFailed';

const FILTERS = ['REQUESTED', 'APPROVED', 'REFUND_DUE', 'REJECTED', 'REFUNDED'] as const;

export default function ReturnsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('REQUESTED');
  const returnsQ = useQuery({ queryKey: ['returns', filter], queryFn: () => fetchReturns(filter) });
  const { data, isLoading } = returnsQ;
  // [MC-MONEY] Each decision is one in-page panel and its answer stays on
  // screen — the old page showed nothing at all when the server refused.
  const actions = useActionRunner(() => void qc.invalidateQueries({ queryKey: ['returns'] }));
  const DECISION: Record<'APPROVED' | 'REFUND_DUE' | 'REJECTED', { title: string; body: string; label: string; done: string }> = {
    APPROVED: { title: 'Approve this return?', body: 'The customer may send the item back. No money moves.', label: 'Approve return', done: 'The return is approved.' },
    REFUND_DUE: {
      title: 'Record that a refund is owed on this return?',
      body: 'This does not move money — you record the transfer separately once it is sent.',
      label: 'Record refund owed',
      done: 'A refund is recorded as owed. Record the transfer once it is sent.',
    },
    REJECTED: { title: 'Reject this return?', body: 'The customer is told the return was not accepted; the note says why.', label: 'Reject return', done: 'The return is rejected.' },
  };
  const decide = (r: any, s: 'APPROVED' | 'REFUND_DUE' | 'REJECTED') => void actions.run({
    title: DECISION[s].title,
    body: <p>{DECISION[s].body}</p>,
    confirmLabel: DECISION[s].label,
    fields: [{ kind: 'text', name: 'note', label: 'Note (optional)', maxLength: 1000 }],
    submit: ({ reason, values }) => resolveReturn(r.id, s, String(values['note'] ?? '') || undefined, reason),
    success: () => DECISION[s].done,
  });
  // [A-13] Settling is a SEPARATE act from deciding: the money moved, and here
  // is the transfer that moved it — a unique reference and the amount sent.
  const settle = (r: any) => void actions.run({
    title: 'Record the refund transfer for this return?',
    body: <p>Record a transfer you already sent{r.refundAmount ? ` — owed: $${Number(r.refundAmount).toLocaleString()}` : ''}. The return becomes refunded only with this evidence.</p>,
    confirmLabel: 'Record transfer',
    fields: [
      { kind: 'reference', name: 'reference', label: 'Transfer reference', hint: 'Bank or MMG reference — unique to this refund' },
      { kind: 'amount', name: 'amount', label: 'Amount refunded', hint: 'In GYD, as sent', cents: true },
    ],
    submit: ({ reason, values }) => settleReturnRefund(r.id, String(values['reference']), Number(values['amount']), undefined, reason),
    success: () => 'The refund is recorded as paid.',
  });

  const rows: any[] = data?.data ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold">Retail returns</h1>
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
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
        ) : returnsQ.isError ? (
          // [DS768 E4] refunds owed never look "clear" because a read failed
          <QueryFailed error={returnsQ.error} what="the returns" onRetry={() => void returnsQ.refetch()} retrying={returnsQ.isFetching} />
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
                    onClick={() => settle(r)}
                    className="px-4 py-2 rounded-lg text-sm bg-[var(--accent)] hover:bg-[var(--accent)]/80 disabled:opacity-50"
                  >
                    Record the transfer…
                  </button>
                </div>
              )}
              {r.status === 'REQUESTED' && (
                <div className="flex gap-2 mt-4">
                  {(['APPROVED', 'REFUND_DUE', 'REJECTED'] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => decide(r, s)}
                      className={`px-4 py-2 rounded-lg text-sm disabled:opacity-50 ${
                        s === 'REJECTED' ? 'border border-[var(--border)] hover:bg-white/10' : s === 'REFUND_DUE' ? 'bg-[var(--accent)] hover:bg-[var(--accent)]/80' : 'border border-[var(--border)] hover:bg-white/10'
                      }`}
                    >
                      {s === 'REFUND_DUE' ? 'Refund owed…' : `${s.charAt(0) + s.slice(1).toLowerCase()}…`}
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
