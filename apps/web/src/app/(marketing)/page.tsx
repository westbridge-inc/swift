import Link from 'next/link';
import {
  UtensilsCrossed, ShoppingBasket, Store, Car, Package, Wrench,
  BadgePercent, ShieldCheck, Banknote, Search, ClipboardCheck, MapPinned,
} from 'lucide-react';
import { Section } from '@/components/site';
import { launch, showAppStoreBadges } from '@/site.config';

/**
 * [SITE-1.1 Part 2] Every claim on this page reads from the launch config.
 * A visitor is told exactly where Swift works and what they can do today —
 * no region-wide claim, no store badge for an app that does not exist, and no
 * call-to-action that leads somewhere unfinished.
 */

const VERTICALS = [
  { icon: UtensilsCrossed, label: 'Food', blurb: 'Restaurants, delivered hot', key: 'food' as const },
  { icon: ShoppingBasket, label: 'Groceries', blurb: 'Supermarkets, shelf-picked', key: 'groceries' as const },
  { icon: Store, label: 'Shops', blurb: 'Local stores at your door', key: 'shops' as const },
  { icon: Car, label: 'Rides', blurb: 'PIN-verified taxis', key: 'rides' as const },
  { icon: Package, label: 'Parcels', blurb: 'Anything, across town', key: 'courier' as const },
  { icon: Wrench, label: 'Trades', blurb: 'Quoted, booked, paid on completion', key: 'services' as const },
];

const HOW = [
  {
    icon: Search,
    title: 'Look without signing up',
    body: 'Browse every store, every menu and every price with no account. You only sign in when you actually order, because someone has to know where to bring it.',
  },
  {
    icon: ClipboardCheck,
    title: 'Change your mind, free',
    body: 'After you order there is a window where the store has not been told yet. Cancelling inside it costs nothing, and the app shows the clock counting down.',
  },
  {
    icon: MapPinned,
    title: 'Watch it actually happen',
    body: 'Live tracking on every order and ride. The car on the map is the real car — no invented vehicles, no fake movement.',
  },
];

const PROMISES = [
  {
    icon: BadgePercent,
    title: 'Zero commission, ever',
    body: 'Businesses and movers pay one flat weekly fee and keep 100% of every sale, fare and tip. No percentage taken, no hidden cut, and no introductory rate that expires.',
  },
  {
    icon: Banknote,
    title: 'Cash-first, MMG-ready',
    body: 'Built for how people here actually pay: cash at the door, or straight to the store on their own MMG. Swift never holds a dollar of your order money.',
  },
  {
    icon: ShieldCheck,
    title: 'Verified people, honest orders',
    body: 'ID-verified partners, a six-digit code before a ride starts, and an emergency button that dials 911. Insurance is read off the policy, not ticked by an operator.',
  },
];

export default function HomePage() {
  const canOrderOnWeb = launch.webOrdering === 'live';

  return (
    <>
      <Section>
        <div className="max-w-3xl">
          <h1 className="text-4xl font-extrabold leading-[1.03] tracking-tight md:text-6xl">
            Everything your day needs.
            <br />
            <span className="text-[var(--swift-red)]">One app. Zero commission.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-[var(--swift-muted)]">
            Food, groceries, shops, parcels, rides and trades in {launch.markets[0]} — where the
            people serving you keep 100% of what they earn.
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            {/* Honest CTAs [AC-10]: the primary action only promises what the
                launch config says works. No dead paths, no coming-soon buttons
                dressed as live ones. */}
            {canOrderOnWeb ? (
              <Link
                href="/order"
                className="rounded-full bg-[var(--swift-red)] px-6 py-3 font-semibold text-white transition-colors hover:bg-[var(--swift-red-600)]"
              >
                Order on the web
              </Link>
            ) : (
              <Link
                href="/signup"
                className="rounded-full bg-[var(--swift-red)] px-6 py-3 font-semibold text-white transition-colors hover:bg-[var(--swift-red-600)]"
              >
                Join the waitlist
              </Link>
            )}
            <Link
              href="/vendors"
              className="rounded-full border border-[var(--swift-border-strong)] px-6 py-3 font-semibold transition-colors hover:bg-[var(--swift-subtle)]"
            >
              List your business
            </Link>
            <Link
              href="/drivers"
              className="rounded-full border border-[var(--swift-border-strong)] px-6 py-3 font-semibold transition-colors hover:bg-[var(--swift-subtle)]"
            >
              Drive with Swift
            </Link>
          </div>

          {/* No store badges until an app exists. Saying so plainly reads as
              confidence; a dead badge reads as carelessness — and is a review flag. */}
          {!showAppStoreBadges && (
            <p className="mt-6 text-sm text-[var(--swift-muted)]">
              No app needed — Swift runs in your phone&apos;s browser today, tracking included.
            </p>
          )}
        </div>
      </Section>

      <Section tint>
        <h2 className="text-2xl font-bold tracking-tight md:text-3xl">Six things, one app</h2>
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {VERTICALS.filter((v) => launch.verticals[v.key] !== 'soon').map(
            ({ icon: Icon, label, blurb }) => (
              <li key={label} className="rounded-2xl bg-white p-6 shadow-sm">
                <Icon className="h-6 w-6 text-[var(--swift-red)]" aria-hidden />
                <h3 className="mt-4 font-bold">{label}</h3>
                <p className="mt-1 text-sm text-[var(--swift-muted)]">{blurb}</p>
              </li>
            ),
          )}
        </ul>
      </Section>

      <Section>
        <h2 className="text-2xl font-bold tracking-tight md:text-3xl">How it works</h2>
        <ul className="mt-8 grid gap-8 md:grid-cols-3">
          {HOW.map(({ icon: Icon, title, body }) => (
            <li key={title}>
              <Icon className="h-6 w-6 text-[var(--swift-red)]" aria-hidden />
              <h3 className="mt-4 font-bold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-[var(--swift-muted)]">{body}</p>
            </li>
          ))}
        </ul>
        <p className="mt-8">
          <Link
            href="/how-it-works"
            className="font-semibold text-[var(--swift-red)] underline underline-offset-4"
          >
            The whole thing, step by step →
          </Link>
        </p>
      </Section>

      <Section tint>
        <h2 className="text-2xl font-bold tracking-tight md:text-3xl">Why it works this way</h2>
        <ul className="mt-8 grid gap-4 md:grid-cols-3">
          {PROMISES.map(({ icon: Icon, title, body }) => (
            <li key={title} className="rounded-2xl bg-white p-6 shadow-sm">
              <Icon className="h-6 w-6 text-[var(--swift-red)]" aria-hidden />
              <h3 className="mt-4 font-bold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-[var(--swift-muted)]">{body}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section>
        <div className="rounded-3xl bg-[var(--swift-red)] px-8 py-12 text-white md:px-14 md:py-16">
          <h2 className="max-w-2xl text-3xl font-extrabold leading-tight tracking-tight md:text-4xl">
            Run a business? The commission line simply is not there.
          </h2>
          <p className="mt-4 max-w-xl text-white/85">
            One flat weekly fee. You keep every dollar you sell, customers pay you directly, and the
            dashboard runs on the web today — no app to wait for.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/vendors"
              className="rounded-full bg-white px-6 py-3 font-semibold text-[var(--swift-red)] transition-opacity hover:opacity-90"
            >
              See what you get
            </Link>
            <Link
              href="/pricing"
              className="rounded-full border border-white/40 px-6 py-3 font-semibold text-white transition-colors hover:bg-white/10"
            >
              What it costs
            </Link>
          </div>
        </div>
      </Section>
    </>
  );
}
