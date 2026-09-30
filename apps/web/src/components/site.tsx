import Link from 'next/link';
import { SwiftLogo } from './swift-logo';
import { site, showAppStoreBadges } from '@/site.config';
export { SiteNav } from './site-nav';

/** Shared marketing chrome: nav + footer, Swift red on a light canvas. */

export function SiteFooter() {
  return (
    <footer className="border-t border-black/5 bg-[var(--swift-subtle)]">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-12 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <SwiftLogo />
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-[var(--swift-muted)]">
            One app for food, groceries, shops, couriers, rides and trades — where the people doing
            the work keep 100% of what they earn.
          </p>
          {/* No store badges until an app actually exists in a store. A dead
              badge is a review flag and a small lie; showAppStoreBadges is the
              only switch, and it is driven by the launch config. */}
          {showAppStoreBadges ? null : (
            <p className="mt-4 text-xs text-[var(--swift-muted)]">
              Store ordering works in your browser. Taxi rides require the Swift mobile app.
            </p>
          )}
        </div>

        <nav aria-label="Company" className="text-sm">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--swift-ink)]">
            Company
          </h2>
          <ul className="mt-4 space-y-2.5 text-[var(--swift-muted)]">
            <li><Link href="/about" className="hover:text-[var(--swift-ink)]">About</Link></li>
            <li><Link href="/contact" className="hover:text-[var(--swift-ink)]">Contact</Link></li>
            <li><Link href="/vendors" className="hover:text-[var(--swift-ink)]">For businesses</Link></li>
            <li><Link href="/drivers" className="hover:text-[var(--swift-ink)]">For drivers</Link></li>
            <li><Link href="/faq" className="hover:text-[var(--swift-ink)]">Questions</Link></li>
          </ul>
        </nav>

        <nav aria-label="Legal" className="text-sm">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--swift-ink)]">
            Legal
          </h2>
          <ul className="mt-4 space-y-2.5 text-[var(--swift-muted)]">
            <li><Link href="/legal/privacy" className="hover:text-[var(--swift-ink)]">Privacy policy</Link></li>
            <li><Link href="/legal/terms" className="hover:text-[var(--swift-ink)]">Terms of service</Link></li>
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

      {/* AC-3: the legal entity name appears in EVERY footer, on every page.
          Read from site.config so it cannot drift between routes. */}
      <div className="border-t border-black/5">
        <div className="mx-auto flex max-w-6xl flex-col gap-1 px-5 py-5 text-xs text-[var(--swift-muted)] md:flex-row md:items-center md:justify-between">
          <p>
            Swift is operated by{' '}
            <span className="font-semibold text-[var(--swift-ink)]">{site.legalEntityName}</span>.
          </p>
          <p>
            © {new Date().getFullYear()} {site.legalEntityName}. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}

/** Section shell with the marketing rhythm baked in. */
export function Section({ children, tint = false }: { children: React.ReactNode; tint?: boolean }) {
  return (
    <section className={tint ? 'bg-[var(--swift-subtle)]' : ''}>
      <div className="mx-auto max-w-6xl px-5 py-16 md:py-20">{children}</div>
    </section>
  );
}
