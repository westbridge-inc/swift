import { redirect } from 'next/navigation';

/**
 * The app has no separate Today: its business board is the Orders home, with
 * today's revenue, the queue, the Manage tiles and the store controls together
 * (owner ruling, 11 Oct 2026). The old web Today page lives on there.
 */
export default function TodayPage() {
  redirect('/dashboard/orders');
}
