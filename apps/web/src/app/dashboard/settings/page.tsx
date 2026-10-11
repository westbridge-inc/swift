import { redirect } from 'next/navigation';

/** Settings became the app's "Account" (owner ruling, 11 Oct 2026). */
export default function SettingsPage() {
  redirect('/dashboard/account');
}
