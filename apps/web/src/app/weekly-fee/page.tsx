import type { Metadata } from 'next';
import { WeeklyFeeDestination } from '@/components/weekly-fee-destination';

export const metadata: Metadata = { title: 'Weekly fee', robots: { index: false, follow: false } };
export default function WeeklyFeePage() {
  return <WeeklyFeeDestination />;
}
