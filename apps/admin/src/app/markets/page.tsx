'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchCountries } from '@/lib/api';
import { QueryFailed } from '@/components/mc/QueryFailed';

/** Weekly tier prices live in subscriptionTiers JSON — every partner kind the
 *  resolver prices: mover, moverHeavy, taxiDriver, serviceVendor, smallVendor,
 *  largeVendor, departmentVendor. A market that has not set one shows a dash. */
function tier(c: any, key: string) {
  const v = c?.subscriptionTiers?.[key];
  return v != null ? `${c.currencySymbol}${Number(v).toLocaleString()}` : '—';
}

/** [O1 · owner 5 Nov 2026] A rider cash limit the API sends as null is the ruled "no cap": shown in words. */
function floatLimits(c: any): string {
  const levels = [c?.floatL1, c?.floatL2, c?.floatL3];
  if (levels.every((v) => v == null)) return 'No limit';
  return levels.map((v) => (v == null ? 'No limit' : Number(v).toLocaleString())).join(' / ');
}

const TIER_COLUMNS: Array<[key: string, label: string]> = [
  ['mover', 'Rider / wk'],
  ['moverHeavy', 'Heavy delivery / wk'],
  ['taxiDriver', 'Taxi driver / wk'],
  ['serviceVendor', 'Service / wk'],
  ['smallVendor', 'Small vendor / wk'],
  ['largeVendor', 'Large vendor / wk'],
  ['departmentVendor', 'Department / wk'],
];
const COLUMN_COUNT = 5 + TIER_COLUMNS.length;

export default function MarketsPage() {
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({ queryKey: ['countries'], queryFn: fetchCountries });
  const rows: any[] = data?.data ?? [];

  return (
    <div className="mc-page">
      <p className="mc-muted mb-4 max-w-3xl">
        Every live market&apos;s money rules — currency, ID check threshold, rider cash limits, weekly fees. Read-only:
        these numbers gate real money, so they change with the billing work, never from a free-text box.
      </p>

      <div className="mc-table-wrap overflow-x-auto">
        <table className="mc-table" style={{ tableLayout: 'auto' }}>
          <thead>
            <tr>
              <th className="mc-label">Market</th>
              <th className="mc-label">Currency</th>
              <th className="mc-label" data-align="right">per USD</th>
              <th className="mc-label" data-align="right">ID gate (USD)</th>
              <th className="mc-label" data-align="right">Rider cash limit L1 / L2 / L3</th>
              {TIER_COLUMNS.map(([key, label]) => (
                <th key={key} className="mc-label" data-align="right">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={COLUMN_COUNT} className="mc-table-empty">Loading…</td></tr>
            ) : isError ? (
              <tr><td colSpan={COLUMN_COUNT}>
                <QueryFailed error={error} what="the markets" onRetry={() => void refetch()} retrying={isFetching} />
              </td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={COLUMN_COUNT} className="mc-table-empty">No markets configured.</td></tr>
            ) : (
              rows.map((c: any) => (
                <tr key={c.id}>
                  <td data-label="Market" data-primary className="whitespace-nowrap font-semibold">
                    {c.name} <span className="mc-muted mc-mono ml-1">{c.code}</span>
                  </td>
                  <td data-label="Currency" className="whitespace-nowrap">{c.currencyCode} ({c.currencySymbol})</td>
                  <td data-label="per USD" data-align="right" className="mc-numbers">{Number(c.usdExchangeRate).toLocaleString()}</td>
                  <td data-label="ID gate (USD)" data-align="right" className="mc-numbers">${Number(c.idGateThresholdUsd).toLocaleString()}</td>
                  <td data-label="Rider cash limit L1 / L2 / L3" data-align="right" className="mc-muted mc-numbers whitespace-nowrap">
                    {floatLimits(c)}
                  </td>
                  {TIER_COLUMNS.map(([key, label]) => (
                    <td key={key} data-label={label} data-align="right" className="mc-numbers whitespace-nowrap">{tier(c, key)}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
