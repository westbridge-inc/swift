'use client';

const RATES: Record<string, number> = {
  DELIVERY_RIDER: 10000,
  COURIER_RIDER: 20000,
  TAXI_DRIVER: 20000,
  RESTAURANT: 20000,
  SUPERMARKET: 20000,
};

const LABELS: Record<string, string> = {
  DELIVERY_RIDER: 'Delivery Riders',
  COURIER_RIDER: 'Courier Riders',
  TAXI_DRIVER: 'Taxi Drivers',
  RESTAURANT: 'Restaurants',
  SUPERMARKET: 'Supermarkets',
};

interface SubscriptionBreakdown {
  type: string;
  _count: number;
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
              {item._count} active &times; ${(RATES[item.type] || 0).toLocaleString()} ={' '}
              <span className="font-semibold text-white">
                ${(item._count * (RATES[item.type] || 0)).toLocaleString()}
              </span>
            </span>
          </div>
        )) || <p className="text-[#8E8E93] text-sm">No data</p>}
      </div>
      <div className="mt-4 pt-4 border-t border-[#38383A]">
        <div className="flex justify-between">
          <span className="font-semibold">Weekly Total</span>
          <span className="text-[#FF6B00] font-bold text-lg">
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
