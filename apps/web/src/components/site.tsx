import Link from 'next/link';
import { SwiftLogo } from './swift-logo';
import { BrowserOrderingNote } from './browser-ordering-note';
import { site, launch, showAppStoreBadges } from '@/site.config';
export { SiteNav } from './site-nav';

/** Shared marketing chrome: nav + footer, Swift red on a light canvas. */

/**
 * [Q36] How money moves, in one honest line. Orders are paid to the business —
 * cash, or the store's own MMG — and the API refuses any other order payment.
 * Visa and Mastercard are for Swift's own charges (the weekly partner fee, and
 * advertising a business chooses to buy). They are listed only once
 * launch.cardPayments says the card rail is live: a method that does not work
 * yet is never shown or teased (the partner checkout census enforces it).
 */
export function PaymentMethods() {
  const cardsLive = launch.cardPayments === 'live';
  const methods = ['Cash', 'MMG', ...(cardsLive ? ['Visa', 'Mastercard'] : [])];
  return (
    <section aria-label="Payment methods" className="mx-auto max-w-6xl px-5 py-5 text-xs text-[var(--swift-muted)]">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-5">
        <h2 className="sw-eyebrow">Payment methods</h2>
        <ul className="flex flex-wrap gap-2">
          {methods.map((name) => (
            <li key={name} className="inline-flex items-center rounded-full border border-[var(--swift-border)] bg-[var(--swift-card)] px-3 py-1 text-[13px] font-semibold leading-[18px] text-[var(--swift-ink)]">
              {name}
            </li>
          ))}
        </ul>
      </div>
      <p className="mt-3 max-w-3xl leading-relaxed">
        Orders are paid to the business itself, in cash or by MMG.
        {cardsLive ? " Visa and Mastercard are for Swift's own charges, the weekly partner fee and advertising." : null}
      </p>
    </section>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-[var(--swift-border)] bg-[var(--swift-card)]">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-12 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <SwiftLogo />
          <p className="mt-3 max-w-xs text-[13px] leading-[18px] text-[var(--swift-muted)]">
            One app for food, groceries, shops, couriers, rides and trades — where the people doing
            the work keep 100% of what they earn.
          </p>
          {/* No store badges until an app actually exists in a store. A dead
              badge is a review flag and a small lie; showAppStoreBadges is the
              only switch, and it is driven by the launch config. */}
          {showAppStoreBadges ? null : (
            <p className="mt-4 text-xs text-[var(--swift-muted)]">
              <BrowserOrderingNote /> Taxi rides require the Swift mobile app.
            </p>
          )}
        </div>

        <nav aria-label="Company" className="text-sm">
          <h2 className="sw-eyebrow">
            Company
          </h2>
          <ul className="mt-3 space-y-2.5 text-[13px] leading-[18px] text-[var(--swift-muted)]">
            <li><Link href="/about" className="hover:text-[var(--swift-ink)]">About</Link></li>
            <li><Link href="/contact" className="hover:text-[var(--swift-ink)]">Contact</Link></li>
            <li><Link href="/vendors" className="hover:text-[var(--swift-ink)]">For businesses</Link></li>
            <li><Link href="/drivers" className="hover:text-[var(--swift-ink)]">For drivers</Link></li>
            <li><Link href="/faq" className="hover:text-[var(--swift-ink)]">Questions</Link></li>
          </ul>
        </nav>

        <nav aria-label="Legal" className="text-sm">
          <h2 className="sw-eyebrow">
            Legal
          </h2>
          <ul className="mt-3 space-y-2.5 text-[13px] leading-[18px] text-[var(--swift-muted)]">
            {/* [Q36] Every policy the card bank asks for is one tap from every footer. */}
            <li><Link href="/legal/terms" className="hover:text-[var(--swift-ink)]">Terms of service</Link></li>
            <li><Link href="/legal/privacy" className="hover:text-[var(--swift-ink)]">Privacy policy</Link></li>
            <li><Link href="/legal/refunds" className="hover:text-[var(--swift-ink)]">Refunds and cancellations</Link></li>
            <li><Link href="/legal/delivery" className="hover:text-[var(--swift-ink)]">Delivery policy</Link></li>
            {/* [STORE-003] Play wants the child-safety standard reachable from a
                public page, not only from inside the app. */}
            <li><Link href="/legal/child-safety" className="hover:text-[var(--swift-ink)]">Child safety</Link></li>
            {/* Google Play's deletion policy wants this reachable without the app
                installed — a footer link on every page is the plainest way to
                satisfy "easy to find". */}
            <li><Link href="/account/delete" className="hover:text-[var(--swift-ink)]">Delete your account</Link></li>
            <li>
              <a href={`mailto:${site.supportEmail}`} className="hover:text-[var(--swift-ink)]">
                {site.supportEmail}
              </a>
            </li>
          </ul>
        </nav>
      </div>

      <div className="border-t border-[var(--swift-border)]">
        <PaymentMethods />
      </div>

      {/* AC-3: the legal entity name appears in EVERY footer, on every page.
          [Q36] With it: the trade name, where the company is registered, and
          the transaction currency. All read from site.config. */}
      <div className="border-t border-[var(--swift-border)]">
        <div className="mx-auto flex max-w-6xl flex-col gap-1 px-5 py-5 text-xs text-[var(--swift-muted)] md:flex-row md:items-center md:justify-between">
          <p>
            {site.tradeName} is a trade name of{' '}
            <span className="font-semibold text-[var(--swift-ink)]">{site.legalEntityName}</span>, {site.registeredCity},{' '}
            {site.country}. Prices in {site.currencyCode}.
          </p>
          <p>
            © {new Date().getFullYear()} {site.legalEntityName}
            {/* "Inc." already ends the sentence; never print a second full stop. */}
            {site.legalEntityName.endsWith('.') ? '' : '.'} All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}

/** Section shell with the marketing rhythm baked in. */
export function Section({ children, tint = false }: { children: React.ReactNode; tint?: boolean }) {
  return (
    <section className={tint ? 'bg-[var(--swift-sunken)]' : ''}>
      <div className="mx-auto max-w-6xl px-5 py-16 md:py-20">{children}</div>
    </section>
  );
}
