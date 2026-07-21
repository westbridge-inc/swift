'use client';

// DASH-01: per-type revenue is the API's REAL summed weeklyRate of ACTIVE
// subscriptions — no hardcoded rate table (which undercounted large vendors
// 33% and counted non-active statuses). This component only formats.
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
}

export function RevenueBreakdown({ data, weeklyTotal }: RevenueBreakdownProps) {
  return (
    <div className="bg-[#1C1C1E] rounded-xl p-6 border border-[#38383A]">
      <h3 className="text-lg font-semibold mb-4">Subscription Revenue</h3>
      <div className="space-y-3">
        {data?.map((item) => (
          <div key={item.type} className="flex items-center justify-between text-sm">
            <span className="text-[#8E8E93]">{LABELS[item.type] || item.type}</span>
            <span>
              {item.count} active ={' '}
              <span className="font-semibold text-white">
                ${item.weeklyRevenue.toLocaleString()}
              </span>
            </span>
          </div>
        )) || <p className="text-[#8E8E93] text-sm">No data</p>}
      </div>
      <div className="mt-4 pt-4 border-t border-[#38383A]">
        <div className="flex justify-between">
          <span className="font-semibold">Weekly Total</span>
          <span className="text-[#E8192C] font-bold text-lg">
            ${weeklyTotal?.toLocaleString() || '0'} GYD
          </span>
        </div>
        <div className="flex justify-between text-sm text-[#8E8E93] mt-1">
          <span>Monthly Projection</span>
          <span>${((weeklyTotal || 0) * 4.33).toLocaleString()} GYD</span>
        </div>
      </div>
    </div>
  );
}
