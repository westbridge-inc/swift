'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchPromos, type Promo } from '@/lib/api';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { gyDate } from '@/lib/dates';

/** [Ruling 1 Nov 2026 · REVIEW-M N1] A code that is not the store's own is Swift-paid, and Swift-paid codes are
 *  off: the server refuses to create or change one, and never lets one discount an order (promo/swift-paid.ts). */
const swiftPaid = (promo: Promo) => promo.funder !== 'VENDOR';

export default function PromosPage() {
  const { data, isLoading, isError, error: readError, refetch, isFetching } = useQuery({ queryKey: ['promos'], queryFn: fetchPromos });

  return (
    <div className="mc-page">
      <p className="mc-note mb-6" role="note">
        Swift-paid promo codes are switched off. Swift never holds or moves order money, so it cannot pay a discount on a
        store’s order. A store can still make its own promo code in the Swift app; those are listed here and work as before.
      </p>

      <div className="mc-table-wrap">
        <table className="mc-table mc-table-auto">
          <thead>
            <tr >
              <th className="mc-label text-left">Code</th>
              <th className="mc-label text-left">Type</th>
              <th className="mc-label text-left">Paid by</th>
              <th className="mc-label text-left">Discount</th>
              <th className="mc-label text-left">Status</th>
              <th className="mc-label text-left">Uses</th>
              <th className="mc-label text-right">Expires</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="mc-table-empty">Loading...</td></tr>
            ) : isError ? (
              <tr><td colSpan={7} className="p-4">
                <QueryFailed error={readError} what="the promo codes" onRetry={() => void refetch()} retrying={isFetching} />
              </td></tr>
            ) : data?.data?.length === 0 ? (
              <tr><td colSpan={7} className="mc-table-empty">No promo codes yet</td></tr>
            ) : (
              data?.data?.map((promo: Promo) => (
                <tr key={promo.id} >
                  <td className="p-4 font-mono font-medium">{promo.code}</td>
                  <td className="p-4">{promo.discountType}</td>
                  <td className="p-4">{swiftPaid(promo) ? 'Swift' : 'The store'}</td>
                  <td className="p-4">
                    {promo.discountType === 'PERCENTAGE'
                      ? `${promo.discountValue}%`
                      : promo.discountType === 'FREE_DELIVERY'
                        ? 'Free delivery'
                        : `$${Number(promo.discountValue).toLocaleString()}`}
                  </td>
                  <td className="p-4">
                    {/* A Swift-paid row never discounts an order, whatever its own switch says. */}
                    <span className={`px-2 py-1 rounded-full text-xs ${
                      promo.isActive && !swiftPaid(promo) ? 'bg-[var(--mc-good-soft)] mc-text-good' : 'bg-gray-500/20 text-gray-400'
                    }`}>{swiftPaid(promo) ? 'Off (Swift-paid)' : promo.isActive ? 'Active' : 'Inactive'}</span>
                  </td>
                  <td className="p-4">{promo.currentUses} / {promo.maxUses || '∞'}</td>
                  <td className="p-4 text-right mc-muted">
                    {promo.validUntil ? gyDate(promo.validUntil) : 'Never'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

    </div>
  );
}
