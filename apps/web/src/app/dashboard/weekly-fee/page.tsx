'use client';
import Link from 'next/link';
import { WeeklyFee } from '@/components/weekly-fee';
export default function WeeklyFeePage() {
  return (
    <>
      <WeeklyFee family="vendor" />
      {/* [ENTERPRISE E3] The owner's monthly statement of every branch's fees (owner only; the page says so to others). */}
      <p className="mt-6 text-sm print:hidden"><Link href="/dashboard/weekly-fee/statement" className="underline">Monthly fee statement (all branches)</Link></p>
    </>
  );
}
