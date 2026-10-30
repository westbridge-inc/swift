'use client';
import { Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { WeeklyFee } from '@/components/weekly-fee';
import { getDriverProfile, getRiderProfile } from '@/lib/mover-api';
import { useProviderFee } from '@/components/provider-fee-query';
import { lazyRetry } from '@/lib/chunk-retry';
// [BILL-PRO PR6 · perf-budget] Only a pro sees their block: it loads after the page, so the page costs riders and
// drivers nothing more up front.
const ProviderFeeBlock = lazyRetry(() => import('@/components/provider-fee').then((module) => ({ default: module.ProviderFeeBlock })));
export default function MoverWeeklyFeePage() {
  const rider = useQuery({ queryKey: ['p-rider'], queryFn: getRiderProfile });
  const driver = useQuery({ queryKey: ['p-driver'], queryFn: getDriverProfile });
  // [BILL-PRO PR6] A pro's own weekly fee (owner A4: in the app and on the website).
  const pro = useProviderFee();
  if (rider.isLoading || driver.isLoading || pro.fee.isLoading || pro.approvalLoading) return <p role="status" className="sw-empty">Loading your weekly fees…</p>;
  if (rider.isError || driver.isError || pro.fee.isError || pro.approval.isError) return <div role="alert" className="sw-card space-y-3 p-6">Could not load your partner profiles. <button className="sw-btn sw-btn-md sw-btn-outline" onClick={() => { void rider.refetch(); void driver.refetch(); void pro.fee.refetch(); void pro.approval.refetch(); }}>Try again</button></div>;
  return <div className="space-y-8">
    {rider.data && <div><h2 className="mb-4 font-bold">Delivery and courier</h2><WeeklyFee family="rider" /></div>}
    {driver.data && <div><h2 className="mb-4 font-bold">Taxi</h2><WeeklyFee family="driver" /></div>}
    {pro.fee.data && <div><h2 className="mb-4 font-bold">Service provider</h2><Suspense fallback={<p role="status" className="sw-empty">Loading your weekly fee…</p>}><ProviderFeeBlock view={pro.fee.data} isVerified={pro.isVerified} /></Suspense></div>}
    {!rider.data && !driver.data && !pro.fee.data && <p className="sw-empty">No earner profile on this account.</p>}
  </div>;
}
