'use client';
import { useQuery } from '@tanstack/react-query';
import { WeeklyFee } from '@/components/weekly-fee';
import { getDriverProfile, getRiderProfile } from '@/lib/mover-api';
export default function MoverWeeklyFeePage() {
  const rider = useQuery({ queryKey: ['p-rider'], queryFn: getRiderProfile });
  const driver = useQuery({ queryKey: ['p-driver'], queryFn: getDriverProfile });
  if (rider.isLoading || driver.isLoading) return <p role="status" className="sw-empty">Loading your weekly fees…</p>;
  if (rider.isError || driver.isError) return <div role="alert" className="sw-card space-y-3 p-6">Could not load your partner profiles. <button className="sw-btn sw-btn-md sw-btn-outline" onClick={() => { void rider.refetch(); void driver.refetch(); }}>Try again</button></div>;
  return <div className="space-y-8">
    {rider.data && <div><h2 className="mb-4 font-bold">Delivery and courier</h2><WeeklyFee family="rider" /></div>}
    {driver.data && <div><h2 className="mb-4 font-bold">Taxi</h2><WeeklyFee family="driver" /></div>}
    {!rider.data && !driver.data && <p className="sw-empty">No earner profile on this account.</p>}
  </div>;
}
