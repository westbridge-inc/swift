'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { getProfile, money } from '@/lib/vendor-api';
import { getVatReport, lastGuyanaMonth, monthPeriod, vatReportCsv, type VatReport } from '@/lib/vat-report';
import { DataUnavailable } from '@/components/data-unavailable';
import { storeKey, useStoreId } from '@/lib/store-scope';

/**
 * [STORE-VAT · owner O-5 · PR4] The store's VAT report, for its accountant: one month (a VAT return's tax period) of its
 * sales through Swift that carried VAT, by Guyana day, laid out as the sales lines of the GRA VAT return. Made only from
 * the VAT each order froze, the figures each receipt prints. Owner only (the server refuses anyone else). Swift never
 * files the return: the page says the store's accountant does.
 */
export default function VatReportPage() {
  const storeId = useStoreId();
  const profile = useQuery({ queryKey: storeKey(storeId, 'profile'), queryFn: getProfile });
  const isOwner = (profile.data as { myRole?: string } | undefined)?.myRole === 'OWNER';
  const [month, setMonth] = useState(() => lastGuyanaMonth());
  const period = monthPeriod(month);
  const report = useQuery({
    queryKey: storeKey(storeId, 'vat-report', period.from, period.to),
    queryFn: () => getVatReport(period.from, period.to),
    enabled: isOwner,
  });

  const download = (r: VatReport) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([vatReportCsv(r)], { type: 'text/csv;charset=utf-8' }));
    a.download = `swift-vat-report-${r.from}-to-${r.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <Link href="/dashboard/settings" className="text-sm text-[var(--swift-muted)] hover:underline">← Settings</Link>
        <h1 className="sw-title mt-1">VAT report</h1>
      </div>

      {profile.isError && <DataUnavailable what="your store details" error={profile.error} onRetry={() => void profile.refetch()} />}
      {profile.data && !isOwner && (
        <div className="sw-card p-6 text-sm">Only the store’s owner sees its VAT report.</div>
      )}

      {isOwner && (
        <>
          <div className="sw-card p-6 space-y-3">
            <label htmlFor="vat-month" className="block text-sm font-semibold">Month</label>
            <input
              id="vat-month"
              type="month"
              value={month}
              onChange={(e) => e.target.value && setMonth(e.target.value)}
              className="rounded-lg border border-[var(--swift-border)] px-3 py-2 text-sm"
            />
            <p className="text-sm text-[var(--swift-muted)]">
              {period.from} to {period.to}, by Guyana day. A VAT return covers one month and is due by the 21st of the next month.
            </p>
          </div>

          {report.isError && <DataUnavailable what="your VAT report" error={report.error} onRetry={() => void report.refetch()} />}
          {report.isLoading && <div className="sw-empty" role="status">Loading your VAT report…</div>}
          {/* By day sits behind the read's own success: a failed read shows DataUnavailable above, never "no orders". */}
          {report.data && (
            <VatReportView report={report.data} onDownload={() => download(report.data!)}>
            <div className="sw-card p-6">
              <h2 className="font-bold">By day</h2>
              {report.data.days.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--swift-muted)]">No supplied orders with VAT in this month.</p>
              ) : (
                <table className="mt-3 w-full text-sm" aria-label="VAT by day">
                  <thead>
                    <tr className="text-left text-[var(--swift-muted)]">
                      <th>Day</th><th className="text-right">Orders</th><th className="text-right">Standard-rated incl. VAT</th>
                      <th className="text-right">VAT</th><th className="text-right">Zero-rated</th><th className="text-right">Exempt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.data.days.map((d) => (
                      <tr key={d.day}>
                        <td>{d.day}</td><td className="text-right">{d.orders}</td><td className="text-right">{money(d.standardRatedInclVat)}</td>
                        <td className="text-right">{money(d.vatCharged)}</td><td className="text-right">{money(d.zeroRatedSales)}</td><td className="text-right">{money(d.exemptSales)}</td>
                      </tr>
                    ))}
                    <tr className="font-semibold">
                      <td>Total</td><td className="text-right">{report.data.totals.orders}</td><td className="text-right">{money(report.data.totals.standardRatedInclVat)}</td>
                      <td className="text-right">{money(report.data.totals.vatCharged)}</td><td className="text-right">{money(report.data.totals.zeroRatedSales)}</td><td className="text-right">{money(report.data.totals.exemptSales)}</td>
                    </tr>
                  </tbody>
                </table>
              )}
            </div>
            </VatReportView>
          )}
        </>
      )}
    </div>
  );
}

function VatReportView({ report: r, onDownload, children }: { report: VatReport; onDownload: () => void; children: ReactNode }) {
  return (
    <>
      <div className="sw-card p-6 space-y-3">
        <p className="font-semibold" role="note">{r.prepared}</p>
        {r.sellers.map((s) => (
          <p key={`${s.name}-${s.vatNumber}`} className="text-sm">VAT charged by {s.name} · VAT reg. no. {s.vatNumber} ({s.orders} orders)</p>
        ))}
        <button
          type="button"
          onClick={onDownload}
          className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white"
        >
          Download CSV for your accountant
        </button>
      </div>

      <div className="sw-card p-6">
        <h2 className="font-bold">For your VAT return (sales lines)</h2>
        <table className="mt-3 w-full text-sm" aria-label="VAT return sales lines">
          <thead><tr className="text-left text-[var(--swift-muted)]"><th>Line</th><th>On the GRA form</th><th className="text-right">Amount</th></tr></thead>
          <tbody>
            {r.returnLines.map((l) => (
              <tr key={l.line}><td>{l.line}</td><td>{l.label}</td><td className="text-right">{money(l.amount)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      {children}

      {r.orders.length > 0 && (
        <details className="sw-card p-6">
          <summary className="cursor-pointer font-bold">Each order ({r.orders.length}): the figures its receipt prints</summary>
          <table className="mt-3 w-full text-sm" aria-label="VAT by order">
            <thead><tr className="text-left text-[var(--swift-muted)]"><th>Order</th><th>Day</th><th className="text-right">Standard-rated incl. VAT</th><th className="text-right">VAT</th></tr></thead>
            <tbody>
              {r.orders.map((o) => (
                <tr key={o.orderId}><td>{o.orderNumber}</td><td>{o.day}</td><td className="text-right">{money(o.standardRatedInclVat)}</td><td className="text-right">{money(o.vatCharged)}</td></tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <div className="sw-card p-6">
        <h2 className="font-bold">Good to know</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--swift-muted)]">
          {r.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      </div>
    </>
  );
}
