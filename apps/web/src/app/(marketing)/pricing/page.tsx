import type { Metadata } from 'next';
import { Section } from '@/components/site';
import { fetchPricing } from '@/lib/api';
import { site } from '@/site.config';

export const metadata: Metadata = { title: 'Pricing' };

// The mover fee has two bands, set by the VEHICLE. `moverHeavy` is optional:
// a market that has not priced its heavy fleet simply shows one mover card.
const TIER_META = [
  { key: 'mover' as const, label: 'Riders & drivers', blurb: 'Bicycle, motorbike, car or wagon car — taxi, delivery and courier work. Every fare, fee and tip is yours.' },
  { key: 'moverHeavy' as const, label: 'Buses, canters & trucks', blurb: 'The commercial fleet — 9- and 15-seater buses, short- and long-base canters, box trucks.' },
  { key: 'serviceVendor' as const, label: 'Services', blurb: 'Plumbers, electricians, mechanics, barbers — trades that book work rather than sell a catalogue.' },
  { key: 'smallVendor' as const, label: 'Businesses', blurb: 'Restaurants, shops and stores with a standard catalogue.' },
  { key: 'largeVendor' as const, label: 'Large catalogues', blurb: 'Supermarkets and stores with 1,000+ items.' },
  { key: 'departmentVendor' as const, label: 'Department stores', blurb: 'Full department-store scale — 10,000+ items.' },
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
            <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {TIER_META.filter((t) => pricing.weekly[t.key] != null).map((t) => (
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
            {pricing.franchise && (
              <div className="mt-6 rounded-2xl bg-white p-7 shadow-sm">
                <h3 className="font-bold">Franchises</h3>
                <p className="mt-3 text-3xl font-extrabold">
                  {pricing.franchise.discountPct}% off
                  <span className="text-base font-medium text-[var(--swift-muted)]"> every location</span>
                </p>
                <p className="mt-2 text-sm text-[var(--swift-muted)]">
                  From your {pricing.franchise.minLocations}th store, every location takes{' '}
                  {pricing.franchise.discountPct}% off its own weekly rate — so five standard shops come to{' '}
                  {pricing.currencySymbol}
                  {Math.round(
                    pricing.weekly.smallVendor * (1 - pricing.franchise.discountPct / 100),
                  ).toLocaleString()}{' '}
                  each. It applies to whichever tier a store is on, however large its catalogue.
                </p>
              </div>
            )}
            <p className="mt-6 text-sm text-[var(--swift-muted)]">
              Your weekly fee follows the vehicle you register, so a bus or canter is priced apart from a
              bike or car. Catalogue-size tiers apply above 1,000 items. Your exact rate is confirmed when
              your business is approved.
            </p>
          </>
        ) : (
          /* Rates come from the live config rather than a hardcoded table, so an
             API outage leaves this block with nothing to show. It must still say
             something true and actionable — and must not point at an app that
             does not exist yet [AC-10]. */
          <p className="text-[var(--swift-muted)]">
            We could not load this week&apos;s exact rates just now. The model does not change:{' '}
            <b>one flat weekly fee</b>, a free trial that starts the day you are approved, and{' '}
            <b>zero commission</b> on anything you sell or earn. Email{' '}
            <a
              className="font-medium text-[var(--swift-red)] underline underline-offset-2"
              href={`mailto:${site.supportEmail}`}
            >
              {site.supportEmail}
            </a>{' '}
            and we will send the current rate card for your market.
          </p>
        )}
      </Section>
    </>
  );
}
