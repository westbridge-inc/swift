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
  /** [A-07] What this type will be BILLED this week — custom rates honoured,
   *  waived subscriptions excluded. Not the list rate, and not cash collected. */
  weeklyRevenue: number;
  waivedCount?: number;
  weeklyWaived?: number;
}

interface RevenueBreakdownProps {
  data?: SubscriptionBreakdown[];
  weeklyTotal?: number;
  /** [A-07] What has been waived out of the figure above — a real number in its
   *  own right, and the exact amount the old total overstated itself by. */
  weeklyWaived?: number;
  /** [A-06] the read failed — a total of $0 and a projection from it are inventions */
  unavailable?: boolean;
}

export function RevenueBreakdown({ data, weeklyTotal, weeklyWaived, unavailable }: RevenueBreakdownProps) {
  return (
    <div className="bg-[var(--panel)] rounded-xl p-6 border border-[var(--border)]">
      <h3 className="text-lg font-semibold">Weekly subscription fees</h3>
      {/* [A-07] Naming what the number is. It is what active subscriptions will
          be BILLED this week at their own price — not money collected, and not
          the tier list rate. */}
      <p className="text-xs text-[var(--muted)] mb-4">Billable this week · not cash collected</p>
      <div className="space-y-3">
        {data?.map((item) => (
          <div key={item.type} className="flex items-center justify-between text-sm">
            <span className="text-[var(--muted)]">{LABELS[item.type] || item.type}</span>
            <span>
              {item.count} active ={' '}
              <span className="font-semibold text-white">
                GY${item.weeklyRevenue.toLocaleString()}
              </span>
              {item.waivedCount ? (
                <span className="text-[var(--muted)]">
                  {' '}(+{item.waivedCount} waived, GY${(item.weeklyWaived ?? 0).toLocaleString()})
                </span>
              ) : null}
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
            {/* [A-07] A missing total is UNKNOWN, never zero. `|| '0'` turned an
                absent aggregate into an authoritative GY$0. */}
            {unavailable || weeklyTotal === undefined || weeklyTotal === null
              ? 'unavailable'
              : `GY$${weeklyTotal.toLocaleString()}`}
          </span>
        </div>
        {/* [A-06] A projection multiplies the total. Multiplying a number we
            do not have produces an authoritative-looking figure out of nothing. */}
        {weeklyWaived ? (
          <div className="flex justify-between text-sm text-amber-400 mt-1">
            <span>Waived this period</span>
            <span>−GY${weeklyWaived.toLocaleString()}</span>
          </div>
        ) : null}
        {!unavailable && weeklyTotal !== undefined && weeklyTotal !== null && (
          <div className="flex justify-between text-sm text-[var(--muted)] mt-1">
            <span>Monthly Projection</span>
            <span>GY${Math.round(weeklyTotal * 4.33).toLocaleString()}</span>
          </div>
        )}
      </div>
    </div>
  );
}
