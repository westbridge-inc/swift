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
const MOVER_CLASSES: ReadonlyArray<{ tier: MoverPriceQuote['tier']; label: string; blurb: string }> = [
  { tier: 'courier', label: 'Delivery & courier riders', blurb: 'Deliveries and parcels — every delivery fee and tip is yours.' },
  { tier: 'taxi', label: 'Taxi drivers', blurb: 'One taxi rate, whatever you drive — every fare and tip is yours.' },
  { tier: 'courierHeavy', label: 'Heavy delivery', blurb: 'Canters and box trucks for large and bulky loads.' },
];

const CATALOGUE_CLASSES: Record<CataloguePriceBand['tier'], { label: string; blurb: string }> = {
  small: { label: 'Businesses', blurb: 'Restaurants, groceries and shops.' },
  large: { label: 'Large catalogues', blurb: 'Supermarkets and stores with a wide range.' },
  department: { label: 'Department stores', blurb: 'Full department-store scale.' },
};

const isRate = (value: unknown) => {
  const amount = parseAmount(value);
  return amount !== null && amount > 0;
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
    <div className="rounded-2xl bg-white p-7 shadow-sm">
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
          One weekly subscription. Zero commission. Customers pay nothing to Swift — partners keep
          100% of every sale, fare and tip.
        </p>
      </Section>
      <Section tint>
        {list ? (
          <>
            <p className="text-sm font-semibold text-[var(--swift-muted)]">
              {list.pricing.countryCode} · prices in {list.pricing.currencyCode}
            </p>
            <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {MOVER_CLASSES.map((c) => {
                const quotes = list.movers.filter((q) => q.tier === c.tier);
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
                  Plumbers, electricians, mechanics, barbers — trades that book work rather than sell a catalogue.
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
            {list.pricing.franchise && (
              <div className="mt-6 rounded-2xl bg-white p-7 shadow-sm">
                <h3 className="font-bold">Franchises</h3>
                <p className="mt-3 text-3xl font-extrabold">
                  {list.pricing.franchise.discountPct}% off
                  <span className="text-base font-medium text-[var(--swift-muted)]"> every location</span>
                </p>
                <p className="mt-2 text-sm text-[var(--swift-muted)]">
                  With {list.pricing.franchise.minLocations} or more stores under one owner, every location takes{' '}
                  {list.pricing.franchise.discountPct}% off its own weekly rate — a store on the first step pays{' '}
                  {amount(Math.round(list.catalogue[0]!.rate * (1 - list.pricing.franchise.discountPct / 100)))} a week.
                  It applies to whichever tier a store is on, however large its catalogue.
                </p>
              </div>
            )}
            <p className="mt-6 text-sm text-[var(--swift-muted)]">
              A taxi driver pays the taxi rate whatever the vehicle; a delivery rider&apos;s rate follows the
              vehicle they register. A business moves between catalogue tiers automatically as its active items
              change — nothing to apply for. A rate agreed with Swift stays as agreed.
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
