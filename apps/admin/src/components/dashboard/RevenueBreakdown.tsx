'use client';

// DASH-01: per-type revenue is the API's REAL summed weeklyRate of ACTIVE
// subscriptions — no hardcoded rate table (which undercounted large vendors
// 33% and counted non-active statuses). This component only formats.
import { DataUnavailable } from './DataUnavailable';

const LABELS: Record<string, string> = {
  DELIVERY_RIDER: 'Delivery Riders',
  COURIER_RIDER: 'Courier Riders',
  TAXI_DRIVER: 'Taxi Drivers',
  RESTAURANT: 'Restaurants',
  SUPERMARKET: 'Supermarkets',
};

interface SubscriptionBreakdown {
  type: string;
  count: number;
  weeklyRevenue: number;
}

interface RevenueBreakdownProps {
  data?: SubscriptionBreakdown[];
  weeklyTotal?: number;
  /** [A-06] the read failed — a total of $0 and a projection from it are inventions */
  unavailable?: boolean;
}

export function RevenueBreakdown({ data, weeklyTotal, unavailable }: RevenueBreakdownProps) {
  return (
    <div className="bg-[var(--panel)] rounded-xl p-6 border border-[var(--border)]">
      <h3 className="text-lg font-semibold mb-4">Subscription Revenue</h3>
      <div className="space-y-3">
        {data?.map((item) => (
          <div key={item.type} className="flex items-center justify-between text-sm">
            <span className="text-[var(--muted)]">{LABELS[item.type] || item.type}</span>
            <span>
              {item.count} active ={' '}
              <span className="font-semibold text-white">
                ${item.weeklyRevenue.toLocaleString()}
              </span>
            </span>
          </div>
        )) ||
          (unavailable ? (
            <DataUnavailable what="Revenue" notAnAllClear="These figures are unknown, not zero." />
          ) : (
            <p className="text-[var(--muted)] text-sm">No data</p>
          ))}
      </div>
      <div className="mt-4 pt-4 border-t border-[var(--border)]">
        <div className="flex justify-between">
          <span className="font-semibold">Weekly Total</span>
          <span className="text-[var(--accent)] font-bold text-lg">
            {unavailable ? 'unavailable' : `$${weeklyTotal?.toLocaleString() || '0'} GYD`}
          </span>
        </div>
        {/* [A-06] A projection multiplies the total. Multiplying a number we
            do not have produces an authoritative-looking figure out of nothing. */}
        {!unavailable && (
          <div className="flex justify-between text-sm text-[var(--muted)] mt-1">
            <span>Monthly Projection</span>
            <span>${((weeklyTotal || 0) * 4.33).toLocaleString()} GYD</span>
          </div>
        )}
      </div>
    </div>
  );
}
