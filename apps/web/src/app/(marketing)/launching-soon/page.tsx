import type { Metadata } from 'next';
import Link from 'next/link';
import { Section } from '@/components/site';
import { site, SITE_ORIGIN } from '@/site.config';
import { launchCity } from '@/lib/web-ordering';

/**
 * [Item 7] The front door the public site shows before ordering launches.
 * src/middleware.ts answers every ordering address with this page (the
 * address bar keeps the address asked for), so it is canonical at the root.
 * It promises nothing that does not work yet and points at everything that
 * does: the introduction, the company and every policy.
 */
export const metadata: Metadata = {
  title: `Launching soon in ${launchCity()}`,
  description: `${site.tradeName} is launching in ${launchCity()}: food, groceries, shops, parcels and rides, where the people serving you keep 100% of what they earn.`,
  alternates: { canonical: SITE_ORIGIN },
};

const ABOUT_SWIFT = [
  { href: '/welcome', label: `Why ${site.tradeName}` },
  { href: '/how-it-works', label: 'How it works' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/vendors', label: 'For businesses' },
  { href: '/drivers', label: 'For drivers' },
];

const COMPANY_AND_POLICIES = [
  { href: '/about', label: 'About the company' },
  { href: '/contact', label: 'Contact' },
  { href: '/legal/refunds', label: 'Refunds and cancellations' },
  { href: '/legal/delivery', label: 'Delivery policy' },
  { href: '/legal/terms', label: 'Terms of service' },
  { href: '/legal/privacy', label: 'Privacy policy' },
];

function LinkList({ label, links }: { label: string; links: Array<{ href: string; label: string }> }) {
  return (
    <nav aria-label={label} className="mt-8">
      <h2 className="text-sm font-semibold uppercase tracking-[0.1em] text-[var(--swift-muted)]">{label}</h2>
      <ul className="mt-3 flex flex-wrap gap-2">
        {links.map((l) => (
          <li key={l.href}>
            <Link
              href={l.href}
              className="inline-flex min-h-11 items-center rounded-full border border-[var(--swift-border-strong)] px-4 text-sm font-semibold transition-colors hover:bg-[var(--swift-subtle)]"
            >
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default function LaunchingSoonPage() {
  return (
    <Section>
      <div className="max-w-3xl">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--swift-red)]">{site.tradeName}</p>
        <h1 className="mt-4 text-4xl font-extrabold leading-[1.05] tracking-tight md:text-6xl">Launching soon in {launchCity()}</h1>
        <p className="mt-6 text-lg leading-relaxed text-[var(--swift-muted)]">
          Food, groceries, shops, parcels and rides from local businesses, where the people serving you keep 100% of
          what they earn. Ordering opens on this site soon; nothing can be ordered here yet.
        </p>
        <LinkList label={`About ${site.tradeName}`} links={ABOUT_SWIFT} />
        <LinkList label="Company and policies" links={COMPANY_AND_POLICIES} />
        <p className="mt-10 text-sm text-[var(--swift-muted)]">
          Questions:{' '}
          <a className="font-medium text-[var(--swift-red)] underline underline-offset-2" href={`mailto:${site.supportEmail}`}>
            {site.supportEmail}
          </a>{' '}
          or{' '}
          <a className="font-medium text-[var(--swift-red)] underline underline-offset-2" href={`tel:${site.phone.replace(/[^\d+]/g, '')}`}>
            {site.phone}
          </a>
          .
        </p>
      </div>
    </Section>
  );
}
