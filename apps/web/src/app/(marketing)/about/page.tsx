import type { Metadata } from 'next';
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
    address: { '@type': 'PostalAddress', streetAddress: site.address, addressCountry: 'GY' },
    areaServed: launch.markets.map((m) => ({ '@type': 'Place', name: m })),
    contactPoint: {
      '@type': 'ContactPoint',
      contactType: 'customer support',
      email: site.supportEmail,
      telephone: site.phone,
      areaServed: 'GY',
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
              and tip. The subscription is the entire business model — there is no commission line,
              no service fee taken from a driver, and no markup added to a customer&apos;s bill.
            </p>
            <p>
              Money moves the way it already moves here: cash at the door, or a direct transfer to
              the business or driver&apos;s own MMG. Swift never holds, processes or routes order
              money. That is a deliberate design decision, not a limitation — it keeps the platform a
              piece of software rather than a place your money sits.
            </p>
          </div>

          {/* AC-3: the legal entity name appears on About, on Contact, and in every
              footer. Read from site.config so it can never drift between pages. */}
          <div className="mt-10 rounded-2xl border border-[var(--swift-border)] bg-white p-6">
            <h2 className="text-sm font-semibold uppercase tracking-[0.1em] text-[var(--swift-muted)]">
              Company
            </h2>
            <p className="mt-3 text-lg">
              Swift is operated by{' '}
              <b className="font-semibold text-[var(--swift-ink)]">{site.legalEntityName}</b>.
            </p>
            <p className="mt-2 text-[var(--swift-muted)]">{site.address}</p>
            <p className="mt-1 text-[var(--swift-muted)]">
              <a className="hover:text-[var(--swift-ink)]" href={`tel:${site.phone.replace(/\s/g, '')}`}>
                {site.phone}
              </a>
              {' · '}
              <a className="hover:text-[var(--swift-ink)]" href={`mailto:${site.supportEmail}`}>
                {site.supportEmail}
              </a>
            </p>
          </div>

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
