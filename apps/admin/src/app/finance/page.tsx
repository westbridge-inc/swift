'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchRevenue } from '@/lib/api';

export default function FinancePage() {
  const { data, isLoading } = useQuery({ queryKey: ['revenue'], queryFn: fetchRevenue });

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Finance</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-[#1C1C1E] rounded-xl p-6 border border-[#38383A]">
          <p className="text-[#8E8E93] text-sm">Total Revenue (Week)</p>
          <p className="text-3xl font-bold mt-1">
            {isLoading ? '\u2014' : `$${Number(data?.data?.weeklyRevenue || 0).toLocaleString()}`}
          </p>
          <p className="text-[#8E8E93] text-xs mt-1">GYD</p>
        </div>
        <div className="bg-[#1C1C1E] rounded-xl p-6 border border-[#38383A]">
          <p className="text-[#8E8E93] text-sm">Subscription Revenue</p>
          <p className="text-3xl font-bold mt-1">
            {isLoading ? '\u2014' : `$${Number(data?.data?.subscriptionRevenue || 0).toLocaleString()}`}
          </p>
          <p className="text-[#8E8E93] text-xs mt-1">GYD / week</p>
        </div>
        <div className="bg-[#1C1C1E] rounded-xl p-6 border border-[#38383A]">
          <p className="text-[#8E8E93] text-sm">Markup Revenue</p>
          <p className="text-3xl font-bold mt-1">
            {isLoading ? '\u2014' : `$${Number(data?.data?.markupRevenue || 0).toLocaleString()}`}
          </p>
          <p className="text-[#8E8E93] text-xs mt-1">GYD / week</p>
        </div>
      </div>

      <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] p-6">
        <h2 className="text-lg font-semibold mb-4">Revenue Breakdown</h2>
        <div className="space-y-4">
          <div className="flex items-center justify-between p-3 rounded-lg bg-white/5">
            <span className="text-sm">Delivery Order Markups</span>
            <span className="text-sm font-semibold">
              {isLoading ? '\u2014' : `$${Number(data?.data?.deliveryMarkup || 0).toLocaleString()} GYD`}
            </span>
          </div>
          <div className="flex items-center justify-between p-3 rounded-lg bg-white/5">
            <span className="text-sm">Courier Delivery Fees</span>
            <span className="text-sm font-semibold">
              {isLoading ? '\u2014' : `$${Number(data?.data?.courierFees || 0).toLocaleString()} GYD`}
            </span>
          </div>
          <div className="flex items-center justify-between p-3 rounded-lg bg-white/5">
            <span className="text-sm">Taxi Ride Commissions</span>
            <span className="text-sm font-semibold">
              {isLoading ? '\u2014' : `$${Number(data?.data?.taxiCommissions || 0).toLocaleString()} GYD`}
            </span>
          </div>
          <div className="flex items-center justify-between p-3 rounded-lg bg-white/5">
            <span className="text-sm">Weekly Subscriptions</span>
            <span className="text-sm font-semibold">
              {isLoading ? '\u2014' : `$${Number(data?.data?.subscriptionRevenue || 0).toLocaleString()} GYD`}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
