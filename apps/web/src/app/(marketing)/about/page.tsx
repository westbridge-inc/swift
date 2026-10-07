import type { Metadata } from 'next';
import Link from 'next/link';
import { Section } from '@/components/site';
import { site, launch, SITE_ORIGIN } from '@/site.config';

export const metadata: Metadata = {
  title: 'About',
  description: `Swift is a super-app for food, groceries, shops, couriers, rides and services, operating in ${launch.markets[0]}. Businesses and movers keep 100% of what they earn.`,
  alternates: { canonical: `${SITE_ORIGIN}/about` },
};

/**
 * Organization JSON-LD [SITE-1.1 Part 5]. Fed entirely from site.config, so it
 * renders the token until the founder fills it and is correct the moment they
 * do. This is the machine-readable claim that the domain belongs to the
 * company — the same fact Apple checks by hand during enrollment.
 */
function organizationJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Swift',
    legalName: site.legalEntityName,
    url: SITE_ORIGIN,
    email: site.supportEmail,
    telephone: site.phone,
    address: { '@type': 'PostalAddress', streetAddress: site.address, addressLocality: site.registeredCity, addressCountry: site.countryCode },
    areaServed: launch.markets.map((m) => ({ '@type': 'Place', name: m })),
    contactPoint: {
      '@type': 'ContactPoint',
      contactType: 'customer support',
      email: site.supportEmail,
      telephone: site.phone,
      areaServed: site.countryCode,
      availableLanguage: 'en',
    },
  };
}

export default function AboutPage() {
  return (
    <>
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger -- structured data built from site.config, not user input
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd()) }}
      />
      <Section>
        <div className="max-w-3xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--swift-red)]">
            About Swift
          </p>
          <h1 className="mt-4 text-4xl font-extrabold leading-[1.05] tracking-tight md:text-5xl">
            The people doing the work should keep the money.
          </h1>

          <div className="mt-7 space-y-5 text-lg leading-relaxed text-[var(--swift-muted)]">
            <p>
              Swift is one app for the things a day actually needs: food and grocery delivery, local
              shops, taxi rides, parcels across town, and booking a tradesperson. It is built for{' '}
              {launch.markets[0]}, by people who live with the same streets, the same phones and the
              same payment habits as the people using it.
            </p>
            <p>
              Most delivery platforms take a percentage of every sale. Swift does not, and it is not
              a promotion that expires. Businesses and movers pay one flat weekly subscription and
              keep <b className="font-semibold text-[var(--swift-ink)]">100%</b> of every sale, fare
              and tip. Apart from advertising a business can choose to buy, the subscription is the entire
              business model — there is no commission line,
              no service fee taken from a driver, and no markup added to a customer&apos;s bill.
            </p>
            <p>
              Money moves the way it already moves here: cash at the door, or a direct transfer to
              the business or driver&apos;s own MMG. Swift never holds, processes or routes order
              money. That is a deliberate design decision, not a limitation — it keeps the platform a
              piece of software rather than a place your money sits.
            </p>
          </div>

          {/* [Q36] A complete description of the service, as the card bank asks.
              Every sentence is traced to the code in the lane evidence; the fee
              amounts are not repeated here — /pricing reads them live from the
              same rates Swift bills by, so there is one source, not two. */}
          <section aria-labelledby="what-swift-does" className="mt-12">
            <h2 id="what-swift-does" className="text-2xl font-bold tracking-tight">What Swift does</h2>
            <ul className="mt-5 space-y-4 text-[var(--swift-muted)]">
              <li>
                <b className="font-semibold text-[var(--swift-ink)]">Customers</b> order food, groceries and goods from
                local businesses for delivery or pickup, send parcels across town, book services, and book taxi rides
                in the {site.tradeName} mobile app. They pay for an order in cash when it is handed over, or by MMG
                straight to the business. {site.tradeName} never holds order money and charges customers nothing.
              </li>
              <li>
                <b className="font-semibold text-[var(--swift-ink)]">Businesses</b> (restaurants, supermarkets, shops
                and service providers) list what they sell, take orders and bookings, and keep every dollar of every sale.
              </li>
              <li>
                <b className="font-semibold text-[var(--swift-ink)]">Delivery riders</b> collect orders and parcels and
                deliver them. Every delivery fee and tip is theirs.
              </li>
              <li>
                <b className="font-semibold text-[var(--swift-ink)]">Taxi drivers</b> take rides booked in the{' '}
                {site.tradeName} mobile app. Every fare and tip is theirs.
              </li>
            </ul>
            <h3 className="mt-7 text-lg font-bold text-[var(--swift-ink)]">What {site.tradeName} charges</h3>
            <p className="mt-2 text-[var(--swift-muted)]">
              Businesses, riders and drivers pay {site.tradeName} a flat weekly fee for the software, in advance,
              after a free trial. A business can also choose to buy advertising on {site.tradeName}, under separate
              advertising terms. There is no commission on any sale, fare or tip, and nothing is added to a
              customer&apos;s bill. The current weekly fee for each kind of partner is on the{' '}
              <Link className="font-medium text-[var(--swift-red)] underline underline-offset-2" href="/pricing">
                pricing page
              </Link>
              , in {site.currencyCode}.
            </p>
          </section>

          {/* AC-3: the legal entity name appears on About, on Contact, and in every
              footer. [Q36] Beside it, every company fact the card bank asks the
              site to state. All read from site.config, so no page can drift. */}
          <section
            aria-labelledby="company-facts"
            className="mt-10 sw-card p-6"
          >
            <h2 id="company-facts" className="text-sm font-semibold uppercase tracking-[0.1em] text-[var(--swift-muted)]">
              Company facts
            </h2>
            <dl className="mt-4 grid gap-x-6 gap-y-3 text-[var(--swift-muted)] sm:grid-cols-[max-content_1fr]">
              <dt className="font-semibold text-[var(--swift-ink)]">Trade name</dt>
              <dd>
                {site.tradeName} (also written {site.tradeNameAlt})
              </dd>
              <dt className="font-semibold text-[var(--swift-ink)]">Operated by</dt>
              <dd>{site.legalEntityName}</dd>
              <dt className="font-semibold text-[var(--swift-ink)]">Registered and located in</dt>
              <dd>
                {site.registeredCity}, {site.country}
              </dd>
              <dt className="font-semibold text-[var(--swift-ink)]">Registered office</dt>
              <dd>{site.address}</dd>
              <dt className="font-semibold text-[var(--swift-ink)]">Domicile country</dt>
              <dd>{site.country}</dd>
              <dt className="font-semibold text-[var(--swift-ink)]">Transaction currency</dt>
              <dd>
                {site.currencyName} ({site.currencyCode})
              </dd>
              <dt className="font-semibold text-[var(--swift-ink)]">Export restrictions</dt>
              <dd>
                {site.tradeName} operates only in {site.country} and does not export goods. Nothing is delivered
                outside {site.country}.
              </dd>
              <dt className="font-semibold text-[var(--swift-ink)]">Customer service</dt>
              <dd>
                <a className="hover:text-[var(--swift-ink)]" href={`tel:${site.phone.replace(/[^\d+]/g, '')}`}>
                  {site.phone}
                </a>
                {' · '}
                <a className="hover:text-[var(--swift-ink)]" href={`mailto:${site.supportEmail}`}>
                  {site.supportEmail}
                </a>
              </dd>
            </dl>
          </section>

          {/* Truth rule [SITE-1.1 Part 5]: every availability claim matches the
              launch config. The site states exactly where Swift operates — no
              "across the Caribbean" until that is true of a real market. */}
          <div className="mt-6">
            <h2 className="text-sm font-semibold uppercase tracking-[0.1em] text-[var(--swift-muted)]">
              Where Swift operates
            </h2>
            <ul className="mt-3 flex flex-wrap gap-2">
              {launch.markets.map((m) => (
                <li
                  key={m}
                  className="rounded-full bg-[var(--swift-subtle)] px-4 py-1.5 text-sm font-medium"
                >
                  {m}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm text-[var(--swift-muted)]">
              More markets will be listed here when they open — not before.
            </p>
          </div>
        </div>
      </Section>
    </>
  );
}
