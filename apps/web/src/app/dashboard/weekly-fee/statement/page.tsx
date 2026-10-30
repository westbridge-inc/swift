'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatMoney } from '@/lib/money';
import { getChainStatement, lastGuyanaMonth, statementDay, statementTime, thisGuyanaMonth, type ChainStatement, type ChainStatementBranch } from '@/lib/chain-statement';
import { DataUnavailable } from '@/components/data-unavailable';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { useStoreRole } from '@/lib/store-role';

const money = (n: number) => formatMoney(n);

/**
 * [ENTERPRISE E3 · owner 29 Oct 2026] The owner's weekly-fee statement for one month: every branch, its fee and chain
 * deal, its paid weeks that start in the month, what it owes on the day the statement is made, and the receipts issued
 * in the month, from Swift's own records. Print it, or save it as a PDF from the print dialog (the console prints
 * nothing of its own). It is a statement, never a tax invoice: "Not a VAT invoice". Owner only (the server refuses
 * anyone else).
 */
export default function FeeStatementPage() {
  const storeId = useStoreId();
  const queryClient = useQueryClient();
  // [REVIEW-F #2228 9a10328f S3-1] The console's one role read (same key, same shape as the shell's), never a second.
  const role = useStoreRole();
  const isOwner = role.role === 'OWNER';
  const [month, setMonth] = useState(() => lastGuyanaMonth());
  const statement = useQuery({ queryKey: storeKey(storeId, 'chain-statement', month), queryFn: () => getChainStatement(month), enabled: isOwner });

  return (
    <div className="max-w-4xl space-y-6">
      <div className="print:hidden">
        <Link href="/dashboard/weekly-fee" className="text-sm text-[var(--swift-muted)] hover:underline">← Weekly fee</Link>
        <h1 className="sw-title mt-1">Fee statement</h1>
      </div>
      {!role.known && !role.failed && <div className="sw-empty print:hidden" role="status">Loading…</div>}
      {role.failed && <DataUnavailable what="your store details" onRetry={() => void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'my-role') })} />}
      {role.known && !isOwner && <div className="sw-card p-6 text-sm">Only the business owner sees the fee statement.</div>}
      {isOwner && (
        <>
          <div className="sw-card p-6 space-y-3 print:hidden">
            <label htmlFor="statement-month" className="block text-sm font-semibold">Month</label>
            <input
              id="statement-month"
              type="month"
              min="2026-01"
              max={thisGuyanaMonth()}
              value={month}
              onChange={(e) => e.target.value && setMonth(e.target.value)}
              className="rounded-lg border border-[var(--swift-border)] px-3 py-2 text-sm"
            />
            <button type="button" onClick={() => window.print()} className="block rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white">
              Print or save as PDF
            </button>
          </div>
          {statement.isError && <DataUnavailable what="your fee statement" error={statement.error} onRetry={() => void statement.refetch()} />}
          {statement.isLoading && <div className="sw-empty" role="status">Loading your fee statement…</div>}
          {statement.data && <StatementView s={statement.data} />}
        </>
      )}
    </div>
  );
}

/** What the branch pays per week, in words (REVIEW-F #2228 S4-2). */
function feeLine(b: ChainStatementBranch): string {
  if (b.weeklyFee === null) return 'No weekly fee yet';
  if (b.subscriptionStatus === 'TRIAL') return `In its free trial (then ${money(b.weeklyFee)} a week)`;
  if (b.subscriptionStatus === 'CHURNED' || b.subscriptionStatus === 'CANCELLED' || b.subscriptionStatus === 'PAUSED') return 'Not billed now';
  if (b.feeWaived) return 'Weekly fee waived';
  return `Weekly fee ${money(b.weeklyFee)}${b.dealWeeklyRate !== null && b.weeklyFee === b.dealWeeklyRate ? ' (chain deal)' : ''}`;
}

function StatementView({ s }: { s: ChainStatement }) {
  const made = statementDay(s.generatedAt);
  return (
    <article className="sw-card p-6 space-y-5" aria-label={`Fee statement for ${s.month}`}>
      <header className="space-y-1 text-sm">
        <p className="font-bold">{s.issuer.name} (trading as {s.issuer.tradingAs})</p>
        <p>Registration no. {s.issuer.registrationNo}</p>
        <p>Registered office: {s.issuer.registeredOffice}</p>
        {s.issuer.tin && <p>TIN: {s.issuer.tin}</p>}
      </header>
      <section className="text-sm space-y-1">
        <h2 className="font-bold">Weekly-fee statement · {statementDay(s.from)} to {statementDay(new Date(Date.parse(s.to) - 1).toISOString())}</h2>
        <p>Made {statementTime(s.generatedAt)} (Guyana). What is owed is as on that day, not at the end of the month.</p>
        <p>Business owner: {s.billedTo.name}{s.billedTo.email ? ` · ${s.billedTo.email}` : ''}{s.billedTo.phone ? ` · ${s.billedTo.phone}` : ''}</p>
        <p>{s.deal ? `Chain deal: ${money(s.deal.weeklyRate)} a week per branch (or a branch's own fee, if lower).` : 'No chain deal: each branch pays its own weekly fee.'}</p>
      </section>
      {s.branches.map((b) => (
        <section key={b.vendorId} className="border-t border-[var(--swift-border)] pt-4 text-sm space-y-2">
          <h3 className="font-semibold">{b.branchName}</h3>
          {b.address && <p className="text-[var(--swift-muted)]">{b.address}</p>}
          <p>
            {feeLine(b)}
            {b.owedNow ? ` · Owed on ${made}: ${money(b.owedNow.amount)}, due since ${statementDay(b.owedNow.dueSince)}` : ` · Nothing owed on ${made}`}
          </p>
          {b.weeks.length > 0 ? (
            <table className="w-full" aria-label={`Paid weeks starting this month, ${b.branchName}`}>
              <thead><tr className="text-left text-[var(--swift-muted)]"><th>Week (starting this month)</th><th>Paid</th><th className="text-right">Fee</th></tr></thead>
              <tbody>
                {b.weeks.map((w) => (
                  <tr key={w.periodStart}><td>{statementDay(w.periodStart)} to {statementDay(w.periodEnd)}</td><td>{w.paidAt ? statementDay(w.paidAt) : '—'}</td><td className="text-right">{money(w.amount)}</td></tr>
                ))}
              </tbody>
            </table>
          ) : <p className="text-[var(--swift-muted)]">No paid week starts this month.</p>}
          {b.receipts.length > 0 && (
            <table className="w-full" aria-label={`Receipts issued this month, ${b.branchName}`}>
              <thead><tr className="text-left text-[var(--swift-muted)]"><th>Receipt</th><th>Date</th><th className="text-right">Received</th></tr></thead>
              <tbody>
                {b.receipts.map((r) => (
                  <tr key={r.receiptNumber}><td>{r.receiptNumber}</td><td>{statementDay(r.issuedAt)}</td><td className="text-right">{money(r.amount)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
      <section className="border-t border-[var(--swift-border)] pt-4 text-sm space-y-1">
        <p>Paid weeks starting this month: <span className="font-semibold">{money(s.totals.weeksCharged)}</span></p>
        <p>Receipts issued this month (before any refund): <span className="font-semibold">{money(s.totals.received)}</span></p>
        <p>Owed on {made}: <span className="font-semibold">{money(s.totals.owedNow)}</span></p>
        <p className="font-semibold">{s.vatNote}</p>
      </section>
    </article>
  );
}
