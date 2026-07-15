import type { Metadata } from 'next';
import { Section } from '@/components/site';
import { CheckCircle2 } from 'lucide-react';

export const metadata: Metadata = { title: 'For drivers & riders' };

const FEATURES = [
  'Keep 100% of every fare, delivery fee and tip — one flat weekly fee',
  '14-day free trial once your documents are verified',
  'Offers ping you first when you are nearest — accept or pass, your call',
  'See the job before you take it: fee, distance, order size, and who you are fronting cash for',
  'Cash-order protection: the company guarantee covers verified no-pays under the threshold',
  'PIN-verified taxi pickups and live trip sharing for safety',
  'Earnings in the app daily — fees, tips and your cash ledger, all transparent',
];

export default function ForDriversPage() {
  return (
    <>
      <Section>
        <div className="max-w-3xl">
          <h1 className="text-4xl font-extrabold tracking-tight md:text-5xl">
            Drive. Deliver. <span className="text-[var(--swift-red)]">Keep all of it.</span>
          </h1>
          <p className="mt-4 text-lg text-[var(--swift-muted)]">
            Taxi drivers, delivery riders and couriers on Swift pay one flat weekly subscription and
            keep every dollar they earn. No commission, no games.
          </p>
          <div className="mt-8 rounded-2xl bg-[var(--swift-subtle)] p-6">
            <h2 className="font-bold">How to start</h2>
            <p className="mt-2 text-[var(--swift-muted)]">
              Download the Swift app, choose <b>Earn with Swift</b>, add your vehicle and upload your
              documents — ID, licence, insurance (hire-class for taxis) and the rest shown in the app.
              Verified within 24 hours, then your free trial starts and you can go online.
            </p>
          </div>
        </div>
      </Section>
      <Section tint>
        <h2 className="text-2xl font-bold">Why movers choose Swift</h2>
        <ul className="mt-6 grid gap-4 md:grid-cols-2">
          {FEATURES.map((f) => (
            <li key={f} className="flex items-start gap-3 rounded-2xl bg-white p-5 shadow-sm">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[var(--swift-red)]" />
              <span>{f}</span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
