import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Section } from '@/components/site';
import { fetchPricing, type CataloguePriceBand, type CountryPricing, type MoverPriceQuote } from '@/lib/api';
import { formatAmount, parseAmount } from '@/lib/money';
import { catalogueRetierOf } from '@/lib/catalogue-retier';
import { site } from '@/site.config';

export const metadata: Metadata = { title: 'Pricing' };

// Every number on this page is the server's quote — resolved by the same
// function signup prices through — so what a partner reads here is what they
// are billed. [RETIER PR-A/C] A NEW store's fee and trial follow the step its own
// catalogue reaches when Swift approves it (its owner ticks the fee first);
// whether Swift moves a store between steps after that is the server's word
// (`catalogueRetier`): the paragraph under the cards says so. A mover reads the rate of the role their
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
  if (!next) return i === 0 ? 'Any number of items' : `${band.minItems.toLocaleString()}+ items`;
  if (i === 0) return `For fewer than ${next.minItems.toLocaleString()} items`;
  return `${band.minItems.toLocaleString()}–${(next.minItems - 1).toLocaleString()} items`;
}

/** A catalogue step's own free trial (a NEW store at that step when Swift approves it), else the list's. A value that
 *  is not a whole number of days above zero is not shown: the list's own trial stands. */
const bandTrialDays = (band: CataloguePriceBand, fallback: number) =>
  typeof band.trialDays === 'number' && Number.isInteger(band.trialDays) && band.trialDays > 0 ? band.trialDays : fallback;

// [ENTERPRISE-PAGE · owner 31 Oct 2026] What a chain gets today, each line true on main: one login runs every branch
// and a person approves each new one (partner.service addBranch, personApprovalRequired); one MMG checkout pays every
// branch fee DUE now (a branch in its free trial or not yet due is left out), or each pays its own
// (billing/chain-checkout.ts); a monthly fee statement (billing/chain-statement.ts);
// a weekly rate per branch agreed with Swift that never raises a branch's fee and ends or rises only after the
// 14-day notice (vendor/chain-deal.ts, billing/fee-rise-notice.ts); a branch limit per account (branchLimit). No
// chain rate is quoted and no discount promised: the rate is negotiated (owner, 29 Oct 2026; decision 49 stays).
const CHAIN_POINTS = [
  'One login runs all your branches. A person at Swift checks and approves each new branch before it goes live.',
  'Pay every branch fee that is due in one MMG checkout, or pay each branch on its own.',
  'A monthly fee statement lists every branch, the weeks it paid and its receipts.',
  "Swift agrees a weekly rate per branch with you. A branch never pays more than its own fee, and the rate ends or goes up only after 14 days' notice.",
  'Need more branches than one account allows? Contact sales.',
];
const SALES_SUBJECT = 'Chain / enterprise enquiry';

function ChainsAndEnterprise() {
  return (
    <Section>
      <div className="grid gap-8 md:grid-cols-[1fr_auto] md:items-start">
        <div>
          <h2 className="text-2xl font-extrabold tracking-tight">Chains and enterprise</h2>
          <p className="mt-3 max-w-2xl text-[var(--swift-muted)]">
            Run several stores or restaurants? Talk to us about a rate for all your branches.
          </p>
          <ul className="mt-5 max-w-3xl list-disc space-y-2 pl-5 text-sm leading-relaxed text-[var(--swift-muted)]">
            {CHAIN_POINTS.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col items-start gap-2">
          <a
            href={`mailto:${site.salesEmail}?subject=${encodeURIComponent(SALES_SUBJECT)}`}
            className="rounded-full bg-[var(--swift-red)] px-6 py-3 font-semibold text-[var(--swift-white)] transition-colors hover:bg-[var(--swift-red-600)]"
          >
            Contact sales
          </a>
          <p className="text-sm text-[var(--swift-muted)]">{site.salesEmail}</p>
        </div>
      </div>
    </Section>
  );
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
              {list.catalogue.map((band, i) => {
                const trialDays = bandTrialDays(band, list.pricing.trialDays);
                return (
                  <PriceCard key={band.tier} title={CATALOGUE_CLASSES[band.tier]?.label ?? 'Businesses'} price={amount(band.rate)} trialDays={trialDays}>
                    <p className="mt-2 text-sm text-[var(--swift-muted)]">
                      {CATALOGUE_CLASSES[band.tier]?.blurb} {itemRange(list.catalogue, i)}.
                    </p>
                    {trialDays !== list.pricing.trialDays && (
                      <p className="mt-2 text-sm text-[var(--swift-muted)]">
                        A new store with this many items when Swift approves it gets {trialDays} days free.
                      </p>
                    )}
                  </PriceCard>
                );
              })}
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
              {/* [RETIER PR-A · owner 30 Oct 2026] A new store's fee is born when Swift approves it, on the step its
                  OWN catalogue reaches then; above the first step its owner sees that exact fee and ticks it before
                  anything is charged (api partner/store-fee.ts). [RETIER PR-C · REVIEW-M N3] What happens after that
                  is the server's word (`catalogueRetier`, WEEKLY_RETIER_ON): off, nothing moves a store; on, a rise is
                  told in the app ahead with how to stop it and a fall applies after two weekly counts (api
                  billing.service recalculateVendorTiers + fee-rise-notice.ts); no word, no claim. */}
              {/* [WEBSITE 30 Oct · owner] The note is three short sentences at most: the same words, joined. */}
              When Swift approves a new store, its weekly fee is the rate for the items it has then, counting items taken off sale, changed or removed in the last 7 days (a services business pays the Services rate). The store
              sees that exact fee, and its owner ticks it
              before anything is charged
              {(() => {
                const retier = catalogueRetierOf(list.pricing);
                if (!retier) return null;
                return retier.on
                  ? <>; after that, Swift counts each store&apos;s items every week and tells the store in the app at least {retier.noticeDays} days before a higher rate applies, with how to stop it (a lower rate applies after two weekly counts a week apart, with a notice)</>
                  : <>; after that, Swift does not move a store to another rate as its items change</>;
              })()}
              , and a rate agreed with Swift stays as agreed.
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
      <ChainsAndEnterprise />
    </>
  );
}
