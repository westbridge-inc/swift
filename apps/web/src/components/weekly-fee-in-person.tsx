'use client';

import Link from 'next/link';
import type { FeeFamily } from '@/lib/weekly-fee';
import { inPersonWaiting, PAY_IN_PERSON, PAY_IN_PERSON_ASK } from '@/lib/weekly-fee-in-person';

/**
 * [OWNER 5 Nov 2026] Paying in person on the weekly-fee page. The page loads this only when the server says the door
 * accepts (`inPerson.open`) or a person's record waits (`waitingGyd`), so its words are not in the first load.
 */
export default function WeeklyFeeInPerson(props: { waitingGyd: number } | { family: FeeFamily }) {
  if ('waitingGyd' in props) return <p role="status" data-testid="in-person-waiting" className="mt-3 font-semibold">{inPersonWaiting(props.waitingGyd)}</p>;
  return <div data-testid="pay-in-person" className="space-y-2 text-sm text-[var(--swift-muted)]">
    <p>{PAY_IN_PERSON}</p>
    <Link className="font-semibold underline underline-offset-4" href={props.family === 'vendor' ? '/dashboard/help' : '/portal/help'}>{PAY_IN_PERSON_ASK}</Link>
  </div>;
}
