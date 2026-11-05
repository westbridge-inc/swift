'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchInPersonPayments, fetchInPersonReceipt } from '@/lib/api';
import { printReceipt } from '@/lib/print-receipt';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { gyDateTime } from '@/lib/dates';

const METHOD: Record<string, string> = { CASH: 'Cash', CHEQUE: 'Cheque', BANK_TRANSFER: 'Bank transfer' };
const money = (n: number) => `$${n.toLocaleString()}`;

/** One receipt as the partner reads it. Print sends these lines alone to paper, never the page around them. */
function ReceiptLines({ number }: { number: string }) {
  const q = useQuery({ queryKey: ['fee-receipt', number], queryFn: () => fetchInPersonReceipt(number) });
  if (q.isLoading) return <p className="mc-muted text-xs">Loading the receipt…</p>;
  if (q.isError) return <QueryFailed error={q.error} what="the receipt" onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  return (
    <div className="text-xs">
      {(q.data?.data.lines ?? []).map((line) => <p key={line}>{line}</p>)}
      <button type="button" className="mc-btn mt-2" onClick={() => printReceipt(q.data?.data.lines ?? [])}>Print this receipt</button>
    </div>
  );
}

/**
 * [OWNER 5 Nov 2026] Weekly fees paid directly to the company in person, apart from MMG. Account numbers, no names.
 * Cash on hand is the ledger's cash taken less cash paid back: taking it to the bank is not recorded in Swift.
 */
export function InPersonPayments() {
  const q = useQuery({ queryKey: ['in-person-payments'], queryFn: fetchInPersonPayments });
  const [open, setOpen] = useState<string | null>(null);
  const data = q.data?.data;
  return (
    <div className="mc-card mb-6">
      <h2 className="text-lg font-semibold mb-1">Weekly fees paid in person</h2>
      <p className="mc-muted text-xs mb-4">Paid directly to the company by cash, cheque or bank transfer. Not MMG money.</p>
      {q.isLoading ? (
        <p className="mc-muted text-sm">Loading…</p>
      ) : q.isError ? (
        <QueryFailed error={q.error} what="the in-person payments" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
            {(data?.totals ?? []).map((t) => (
              <div key={t.method} className="rounded-[var(--mc-radius-sm)] bg-[var(--mc-surface)] p-3">
                <p className="mc-muted text-xs">{METHOD[t.method] ?? 'Other'} ({data?.windowDays} days)</p>
                <p className="text-sm font-semibold">{money(t.totalGyd)} · {t.count} paid</p>
              </div>
            ))}
            <div className="rounded-[var(--mc-radius-sm)] bg-[var(--mc-surface)] p-3">
              <p className="mc-muted text-xs">Cash taken, less cash paid back</p>
              <p className="text-sm font-semibold">{money(data?.cashOnHandGyd ?? 0)}</p>
            </div>
          </div>
          {(data?.rows ?? []).length === 0 ? <p className="mc-muted text-sm">No fees paid in person yet.</p> : (
            <div className="mc-table-wrap">
              <table className="mc-table mc-table-auto">
                <thead>
                  <tr>
                    <th className="mc-label text-left">Recorded</th>
                    <th className="mc-label text-left">Account</th>
                    <th className="mc-label text-left">Paid by</th>
                    <th className="mc-label text-left">Reference</th>
                    <th className="mc-label text-right">Amount</th>
                    <th className="mc-label text-right">Receipt</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.rows.map((r) => (
                    <tr key={r.receiptNumber}>
                      <td className="p-3 mc-muted">{gyDateTime(r.issuedAt)}</td>
                      <td className="p-3">{r.san ?? '—'}</td>
                      <td className="p-3">{METHOD[r.method] ?? 'Other'}</td>
                      <td className="p-3">{r.reference ?? '—'}</td>
                      <td className="p-3 text-right">{money(r.amount)}</td>
                      <td className="p-3 text-right">
                        <button type="button" className="mc-btn" aria-expanded={open === r.receiptNumber} onClick={() => setOpen(open === r.receiptNumber ? null : r.receiptNumber)}>{r.receiptNumber}</button>
                        {open === r.receiptNumber ? <div className="mt-2 text-left"><ReceiptLines number={r.receiptNumber} /></div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
