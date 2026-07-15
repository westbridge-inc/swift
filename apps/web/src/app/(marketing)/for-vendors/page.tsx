import type { Metadata } from 'next';
import { Section } from '@/components/site';
import { CheckCircle2 } from 'lucide-react';

export const metadata: Metadata = { title: 'For businesses' };

const FEATURES = [
  'Keep 100% of every sale — one flat weekly fee, zero commission',
  '14-day free trial from the day you are approved',
  'A live orders board with realtime alerts — accept, prepare, ready',
  'Full inventory: stock tracking, low-stock alerts, CSV import for thousands of items',
  'Grocery pick lists with customer-approved substitutions',
  'Get paid directly — cash on handover or your own MMG link, money never passes through Swift',
  'Multi-store support with per-store boards and staff roles',
];

export default function ForVendorsPage() {
  return (
    <>
      <Section>
        <div className="max-w-3xl">
          <h1 className="text-4xl font-extrabold tracking-tight md:text-5xl">
            Your store, online — <span className="text-[var(--swift-red)]">every dollar stays yours</span>
          </h1>
          <p className="mt-4 text-lg text-[var(--swift-muted)]">
            Restaurants, supermarkets, shops and service businesses across the Caribbean run on Swift
            for one flat weekly fee. No percentage of your sales. Ever.
          </p>
          <div className="mt-8 rounded-2xl bg-[var(--swift-subtle)] p-6">
            <h2 className="font-bold">How to join</h2>
            <p className="mt-2 text-[var(--swift-muted)]">
              Download the Swift app, choose <b>Business</b> at sign-up, and upload your documents —
              owner ID, business registration, TIN and a storefront photo. We review within 24 hours
              and your 14-day free trial starts the moment you are approved.
            </p>
          </div>
        </div>
      </Section>
      <Section tint>
        <h2 className="text-2xl font-bold">What you get</h2>
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
