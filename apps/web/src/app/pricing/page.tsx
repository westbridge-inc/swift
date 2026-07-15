import type { Metadata } from 'next';
import { Section } from '@/components/site';
import { fetchPricing } from '@/lib/api';

export const metadata: Metadata = { title: 'Pricing' };

const TIER_META = [
  { key: 'mover' as const, label: 'Movers', blurb: 'Taxi drivers, delivery riders and couriers — every fare, fee and tip is yours.' },
  { key: 'smallVendor' as const, label: 'Businesses', blurb: 'Restaurants, shops and services with a standard catalogue.' },
  { key: 'largeVendor' as const, label: 'Large catalogues', blurb: 'Supermarkets and stores with 1,000+ items.' },
];

// Live from the same endpoint the app's signup shows — never a hardcoded table.
export default async function PricingPage({ searchParams }: { searchParams: Promise<{ country?: string }> }) {
  const { country } = await searchParams;
  const pricing = await fetchPricing(country);

  return (
    <>
      <Section>
        <h1 className="text-4xl font-extrabold tracking-tight">Simple, flat pricing</h1>
        <p className="mt-3 max-w-2xl text-lg text-[var(--swift-muted)]">
          One weekly subscription. Zero commission. Customers pay nothing to Swift — partners keep
          100% of every sale, fare and tip.
        </p>
      </Section>
      <Section tint>
        {pricing ? (
          <>
            <p className="text-sm font-semibold text-[var(--swift-muted)]">
              {pricing.countryCode} · prices in {pricing.currencyCode}
            </p>
            <div className="mt-4 grid gap-5 md:grid-cols-3">
              {TIER_META.map((t) => (
                <div key={t.key} className="rounded-2xl bg-white p-7 shadow-sm">
                  <h3 className="font-bold">{t.label}</h3>
                  <p className="mt-3 text-3xl font-extrabold">
                    {pricing.currencySymbol}
                    {Number(pricing.weekly[t.key]).toLocaleString()}
                    <span className="text-base font-medium text-[var(--swift-muted)]"> / week</span>
                  </p>
                  <p className="mt-2 text-sm text-[var(--swift-muted)]">{t.blurb}</p>
                  <p className="mt-4 text-sm font-semibold text-[var(--swift-red)]">
                    {pricing.trialDays}-day free trial
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-6 text-sm text-[var(--swift-muted)]">
              Franchises pay per store; catalogue-size tiers apply above 1,000 items. Exact rates for
              every market are shown at sign-up in the app.
            </p>
          </>
        ) : (
          <p className="text-[var(--swift-muted)]">
            Live pricing is loading — open the Swift app and tap <b>See pricing</b> at sign-up for your
            market&apos;s weekly rates. Every plan starts with a free trial and takes no commission.
          </p>
        )}
      </Section>
    </>
  );
}
