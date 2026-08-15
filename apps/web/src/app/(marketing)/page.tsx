import Link from 'next/link';
import { UtensilsCrossed, ShoppingBasket, Store, Car, Package, Wrench, BadgePercent, ShieldCheck, Banknote } from 'lucide-react';
import { Section } from '@/components/site';

const VERTICALS = [
  { icon: UtensilsCrossed, label: 'Food', blurb: 'Restaurants, delivered hot' },
  { icon: ShoppingBasket, label: 'Groceries', blurb: 'Supermarkets, shelf-picked' },
  { icon: Store, label: 'Shops', blurb: 'Local stores at your door' },
  { icon: Car, label: 'Rides', blurb: 'PIN-verified taxis' },
  { icon: Package, label: 'Courier', blurb: 'Anything, A to B' },
  { icon: Wrench, label: 'Services', blurb: 'Bookable pros' },
];

const PROMISES = [
  {
    icon: BadgePercent,
    title: 'Zero commission, ever',
    body: 'Businesses and drivers pay one flat weekly fee and keep 100% of every sale, fare and tip. No percentage taken, no hidden cuts.',
  },
  {
    icon: Banknote,
    title: 'Cash-first, MMG-ready',
    body: 'Built for how the Caribbean actually pays: cash at the door, or pay the store directly on their own MMG — Swift never holds your money.',
  },
  {
    icon: ShieldCheck,
    title: 'Verified people, honest orders',
    body: 'ID-verified partners, PIN-verified rides, live tracking on every order and an early-cancel window before the store even starts (cash cancels free; MMG payments are refunded directly by the store).',
  },
];

export default function HomePage() {
  return (
    <>
      <Section>
        <div className="max-w-3xl">
          <h1 className="text-4xl font-extrabold leading-tight tracking-tight md:text-6xl">
            Everything your day needs.
            <br />
            <span className="text-[var(--swift-red)]">One app. Zero commission.</span>
          </h1>
          <p className="mt-5 max-w-xl text-lg text-[var(--swift-muted)]">
            Food, groceries, shops, couriers and rides across the Caribbean — where the people serving
            you keep 100% of what they earn.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/order"
              className="rounded-full bg-[var(--swift-red)] px-6 py-3 font-semibold text-white transition-colors hover:bg-[var(--swift-red-600)]"
            >
              Order now
            </Link>
            <Link
              href="/stores"
              className="rounded-full border border-black/10 px-6 py-3 font-semibold transition-colors hover:bg-[var(--swift-subtle)]"
            >
              Browse stores
            </Link>
            <Link
              href="/signup"
              className="rounded-full border border-black/10 px-6 py-3 font-semibold transition-colors hover:bg-[var(--swift-subtle)]"
            >
              Put your business on Swift
            </Link>
          </div>
        </div>
      </Section>

      <Section tint>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          {VERTICALS.map((v) => (
            <div key={v.label} className="rounded-2xl bg-white p-5 shadow-sm">
              <v.icon className="h-7 w-7 text-[var(--swift-red)]" />
              <p className="mt-3 font-bold">{v.label}</p>
              <p className="mt-1 text-sm text-[var(--swift-muted)]">{v.blurb}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section>
        <div className="grid gap-8 md:grid-cols-3">
          {PROMISES.map((p) => (
            <div key={p.title}>
              <p.icon className="h-8 w-8 text-[var(--swift-red)]" />
              <h3 className="mt-4 text-xl font-bold">{p.title}</h3>
              <p className="mt-2 text-[var(--swift-muted)]">{p.body}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section tint>
        <div className="flex flex-col items-start justify-between gap-6 rounded-3xl bg-[var(--swift-red)] p-10 text-white md:flex-row md:items-center">
          <div>
            <h2 className="text-2xl font-extrabold md:text-3xl">Earn on your own terms</h2>
            <p className="mt-2 max-w-lg text-white/85">
              Drive, deliver or sell — a 14-day free trial, then one flat weekly fee. Every dollar you
              make is yours.
            </p>
          </div>
          <div className="flex gap-3">
            <Link href="/for-drivers" className="rounded-full bg-white px-6 py-3 font-semibold text-[var(--swift-red)]">
              Drive & deliver
            </Link>
            <Link href="/pricing" className="rounded-full border border-white/40 px-6 py-3 font-semibold">
              See pricing
            </Link>
          </div>
        </div>
      </Section>
    </>
  );
}
