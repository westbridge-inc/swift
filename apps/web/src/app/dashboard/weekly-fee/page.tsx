'use client';
import Link from 'next/link';
import { WeeklyFee } from '@/components/weekly-fee';
import { useStoreRole } from '@/lib/store-role';
export default function WeeklyFeePage() {
  // [ENTERPRISE E1b] The console's one role read: only the business owner of several stores is offered "Pay all my branches".
  const role = useStoreRole();
  const payAll = role.role === 'OWNER' && role.stores > 1 ? (
    <p className="rounded-2xl border border-black/5 bg-white p-5 text-sm shadow-sm">
      <Link href="/dashboard/weekly-fee/pay-all" className="font-semibold underline">Pay all my branches</Link>
      {' '}<span className="text-[var(--swift-muted)]">One MMG payment for every branch with a weekly fee due. Optional: each branch can still pay on its own.</span>
    </p>
  ) : null;
  return (
    <>
      <WeeklyFee family="vendor" aside={payAll} />
      {/* [ENTERPRISE E3] The owner's monthly statement of every branch's fees (owner only; the page says so to others). */}
      <p className="mt-6 text-sm print:hidden"><Link href="/dashboard/weekly-fee/statement" className="underline">Monthly fee statement (all branches)</Link></p>
    </>
  );
}
