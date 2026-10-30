import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Section } from '@/components/site';
import { fetchPricing, type CataloguePriceBand, type CountryPricing, type MoverPriceQuote } from '@/lib/api';
import { formatAmount, parseAmount } from '@/lib/money';
import { site } from '@/site.config';

export const metadata: Metadata = { title: 'Pricing' };

// Every number on this page is the server's quote — resolved by the same
// function signup and the weekly re-tier bill through — so what a partner reads
// here is what they are billed. A mover reads the rate of the role their
// vehicle provisions: a taxi driver and a delivery rider never share a figure.
// Only vehicles a mover can register today are shown (the server's `offered`
// flag): heavy delivery — canters and box trucks — is off at launch (owner,
// 13 Oct 2026), so its card appears only once the server offers them again.
const MOVER_CLASSES: ReadonlyArray<{ tier: MoverPriceQuote['tier']; label: string; blurb: string }> = [
  { tier: 'courier', label: 'Delivery & courier riders', blurb: 'Deliveries and parcels. Every delivery fee and tip is yours.' },
  { tier: 'taxi', label: 'Taxi drivers', blurb: 'One rate, whatever you drive. Every fare and tip is yours.' },
  { tier: 'courierHeavy', label: 'Heavy delivery', blurb: 'Canters and box trucks for large and bulky loads.' },
];

/** A vehicle a mover can sign up with today. An older server that predates
 *  the flag sends none, and its quotes stand. */
const isOffered = (q: MoverPriceQuote) => q.offered !== false;

const CATALOGUE_CLASSES: Record<CataloguePriceBand['tier'], { label: string; blurb: string }> = {
  small: { label: 'Businesses', blurb: 'Restaurants, groceries and shops.' },
  large: { label: 'Large catalogues', blurb: 'Supermarkets and stores with a wide range.' },
  department: { label: 'Department stores', blurb: 'Full department-store scale.' },
};

// A billable weekly fee is a whole number of currency units above zero. The
// formatter rounds to whole units, so a fraction would be shown as a different
// figure than the one held — or, below half a unit, as $0 [PR1270-S2-02].
const isRate = (value: unknown) => {
  const amount = parseAmount(value);
  return amount !== null && Number.isInteger(amount) && amount > 0;
};

/** The typed list, whole and billable — or null. A partial list, or one with a
 *  rate that is not a positive amount, is not quoted at all: the page says so
 *  rather than show a hole as a price. */
function typedList(pricing: CountryPricing | null) {
  const movers = pricing?.movers;
  const vendors = pricing?.vendors;
  if (!pricing || !Array.isArray(movers) || movers.length === 0 || !vendors) return null;
  const catalogue = vendors.catalogue;
  if (!movers.every((q) => isRate(q.rate)) || !isRate(vendors.service)) return null;
  if (!Array.isArray(catalogue) || catalogue.length === 0 || catalogue[0]!.minItems !== 0) return null;
  const rising = catalogue.every((band, i) => isRate(band.rate) && (i === 0 || band.minItems > catalogue[i - 1]!.minItems));
  return rising ? { pricing, movers, service: vendors.service, catalogue } : null;
}

/** The active-item range a catalogue step covers, from the server's own boundaries. */
function itemRange(catalogue: CataloguePriceBand[], i: number): string {
  const band = catalogue[i]!;
  const next = catalogue[i + 1];
  if (!next) return i === 0 ? 'Any number of active items' : `${band.minItems.toLocaleString()}+ active items`;
  if (i === 0) return `For fewer than ${next.minItems.toLocaleString()} active items`;
  return `${band.minItems.toLocaleString()}–${(next.minItems - 1).toLocaleString()} active items`;
}

function PriceCard({ title, price, children, trialDays }: { title: string; price: string; children: ReactNode; trialDays: number }) {
  return (
    <div className="rounded-2xl bg-[var(--swift-card)] p-7 shadow-[var(--swift-elevation-card)]">
      <h3 className="font-bold">{title}</h3>
      <p className="mt-3 text-3xl font-extrabold">
        {price}
        <span className="text-base font-medium text-[var(--swift-muted)]"> / week</span>
      </p>
      {children}
      <p className="mt-4 text-sm font-semibold text-[var(--swift-red)]">{trialDays}-day free trial</p>
    </div>
  );
}

// Live from the same endpoint the app's signup shows — never a hardcoded table.
export default async function PricingPage({ searchParams }: { searchParams: Promise<{ country?: string }> }) {
  const { country } = await searchParams;
  const list = typedList(await fetchPricing(country));
  const amount = (n: number) => formatAmount(n, list?.pricing.currencySymbol ?? '');

  return (
    <>
      <Section>
        <h1 className="text-4xl font-extrabold tracking-tight">Simple, flat pricing</h1>
        <p className="mt-3 max-w-2xl text-lg text-[var(--swift-muted)]">
          One flat weekly fee and no commission. Partners keep 100% of every sale, fare and tip, and customers pay
          Swift nothing.
        </p>
      </Section>
      <Section tint>
        {list ? (
          <>
            <p className="text-sm font-semibold text-[var(--swift-muted)]">
              {list.pricing.countryCode} · prices in {list.pricing.currencyCode}
            </p>
            {/* [WEB-LAUNCH-CHECK F5] The cards' h3 titles sit under this h2, not straight under the h1. */}
            <h2 className="sr-only">Weekly rates</h2>
            <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {MOVER_CLASSES.map((c) => {
                const quotes = list.movers.filter((q) => q.tier === c.tier && isOffered(q));
                if (quotes.length === 0) return null;
                const rates = quotes.map((q) => q.rate);
                const low = Math.min(...rates);
                const high = Math.max(...rates);
                // One figure when the class shares one rate; otherwise the range,
                // with each vehicle's own rate beside it — never one guessed number.
                const vehicles = low === high ? quotes.map((q) => q.label).join(', ') : quotes.map((q) => `${q.label} ${amount(q.rate)}`).join(' · ');
                return (
                  <PriceCard key={c.tier} title={c.label} price={low === high ? amount(low) : `${amount(low)}–${amount(high)}`} trialDays={list.pricing.trialDays}>
                    <p className="mt-2 text-sm text-[var(--swift-muted)]">{c.blurb}</p>
                    <p className="mt-2 text-sm text-[var(--swift-muted)]">{vehicles}</p>
                  </PriceCard>
                );
              })}
              <PriceCard title="Services" price={amount(list.service)} trialDays={list.pricing.trialDays}>
                <p className="mt-2 text-sm text-[var(--swift-muted)]">
                  Plumbers, electricians, mechanics, barbers and other trades that book work.
                </p>
              </PriceCard>
              {list.catalogue.map((band, i) => (
                <PriceCard key={band.tier} title={CATALOGUE_CLASSES[band.tier]?.label ?? 'Businesses'} price={amount(band.rate)} trialDays={list.pricing.trialDays}>
                  <p className="mt-2 text-sm text-[var(--swift-muted)]">
                    {CATALOGUE_CLASSES[band.tier]?.blurb} {itemRange(list.catalogue, i)}.
                  </p>
                </PriceCard>
              ))}
            </div>
            {/* [WEBSITE 30 Oct · owner] The note is short: the taxi and rider rules already sit on their cards. */}
            <p className="mt-6 max-w-3xl text-sm leading-relaxed text-[var(--swift-muted)]">
              {/* Said only when the server confirms it bills no multi-store
                  discount (franchise: null, owner ruling of 13 Oct 2026). A
                  server that still sends the old rule bills it, so the page
                  must not claim otherwise; it shows no discount either way. */}
              {list.pricing.franchise == null && (
                <>Each store pays its own weekly fee, however many stores its owner runs. </>
              )}
              {/* [R27] The weekly re-tier is OFF on the server (apps/api/src/modules/billing/weekly-retier.ts,
                  WEEKLY_RETIER_ON = false): a store is born on the first catalogue step and nothing moves it to
                  another. Only its free trial follows its catalogue. The page test pins the flag: turning the
                  re-tier back on must revisit this sentence. */}
              Today every new store pays the {CATALOGUE_CLASSES[list.catalogue[0]!.tier]?.label ?? 'Businesses'} rate (a
              services business pays the Services rate), whatever its size, and Swift does not move stores between rates.
              A rate agreed with Swift stays as agreed.
            </p>
          </>
        ) : (
          /* Rates come from the live config rather than a hardcoded table, so an
             API outage leaves this block with nothing to show. It must still say
             something true and actionable — and must not point at an app that
             does not exist yet [AC-10]. */
          <p className="text-[var(--swift-muted)]">
            We could not load this week&apos;s rates just now. The model stays the same: <b>one flat weekly fee</b>, a
            free trial from the day you are approved, and <b>zero commission</b> on anything you sell or earn. Email{' '}
            <a
              className="font-medium text-[var(--swift-red)] underline underline-offset-2"
              href={`mailto:${site.supportEmail}`}
            >
              {site.supportEmail}
            </a>{' '}
            for the current rates.
          </p>
        )}
      </Section>
    </>
  );
}
