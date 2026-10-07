import Link from 'next/link';
import { AccountFrame } from './account-frame';

export function Safety() {
  return <AccountFrame title="Safety">
    <section className="space-y-3 sw-card p-5">
      <h2 className="font-bold">SOS and trip safety</h2>
      <p>Use the Swift app for SOS, trip sharing and driver checks. These features are available in the app during a trip.</p>
      <p>If you are in immediate danger, contact local emergency services.</p>
    </section>
    <section className="space-y-3 sw-card p-5">
      <h2 className="font-bold">Emergency contacts</h2>
      <p>Manage emergency contacts in the Swift app. Swift texts confirmed contacts when you raise an alert.</p>
      <p>A saved contact must confirm their number before they can be alerted. Your own number cannot be an emergency contact.</p>
      <h2 className="font-bold">Blocked people</h2>
      <p>Use the Swift app to manage people who cannot message or be matched with you.</p>
    </section>
    <section className="space-y-3"><h2 className="font-bold">Report a safety concern</h2><p>Support requests are not emergency alerts.</p><Link href="/account/help" className="inline-block min-h-11 py-3 font-semibold text-[var(--swift-red)]">Contact support</Link></section>
  </AccountFrame>;
}
