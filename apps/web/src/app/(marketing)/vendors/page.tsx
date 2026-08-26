import type { Metadata } from 'next';
import Link from 'next/link';
import { CheckCircle2, Store, ClipboardList, Boxes, QrCode, LineChart, Users } from 'lucide-react';
import { Section } from '@/components/site';
import { launch } from '@/site.config';

// NOTE [G-FEE]: this page may state subscription pricing. It must never be
// deep-linked from the iOS binary — Apple treats in-app links to external
// purchase pages as a payments violation. G-FEE owns that boundary; if a
// mobile screen ever needs to explain the fee, it explains it in-app.

export const metadata: Metadata = {
  title: 'For businesses',
  description:
    'Restaurants, supermarkets, shops and service businesses run on Swift for one flat weekly fee — zero commission, and every dollar of every sale stays yours.',
  alternates: { canonical: 'https://swiftgy.com/vendors' },
};

const DASHBOARD = [
  {
    icon: ClipboardList,
    title: 'A live order board',
    body: 'New orders arrive with a chime that repeats until someone answers, the short code readable across a kitchen. Accept, prepare, mark ready. Rejecting asks why, because a rejection with no reason teaches the platform nothing.',
  },
  {
    icon: Boxes,
    title: 'Inventory that keeps up',
    body: 'Add items one at a time, import a spreadsheet, or photograph a paper menu and let Swift read it. Sold-out hides instantly and comes back when you restock — and a live order holding that item asks the customer to swap rather than silently dropping it.',
  },
  {
    icon: LineChart,
    title: 'Numbers you can act on',
    body: 'Revenue by day, average order, acceptance rate, best sellers, your busiest hours. Reconciled figures only — a beautiful wrong number is still a lie.',
  },
  {
    icon: QrCode,
    title: 'A counter code that works',
    body: 'Print a card for your counter. A customer scans it, sees your live menu on the web and orders — no app install. Walk-in customers become delivery customers.',
  },
  {
    icon: Users,
    title: 'Staff, with real roles',
    body: 'Add the people who work your counter. Owners see every store; staff see exactly the stores you put them on, with the permissions you gave them.',
  },
  {
    icon: Store,
    title: 'More than one location',
    body: 'Each store gets its own board, its own menu and its own hours, under one login.',
  },
];

const MONEY = [
  'One flat weekly fee. Not a percentage — a fee.',
  'You keep 100% of every sale, every fare and every tip.',
  'Customers pay you directly: cash at the door, or your own MMG account.',
  'Swift never holds, processes or touches your money.',
];

export default function VendorsPage() {
  return (
    <>
      <Section>
        <div className="max-w-3xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--swift-red)]">
            For businesses
          </p>
          <h1 className="mt-4 text-4xl font-extrabold leading-[1.05] tracking-tight md:text-6xl">
            Your store, online —{' '}
            <span className="text-[var(--swift-red)]">every dollar stays yours</span>
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-[var(--swift-muted)]">
            Swift is the only delivery platform in {launch.markets[0]} that takes no cut of what you
            sell. One flat weekly fee, and the commission line on your P&amp;L simply is not there.
          </p>

          <div className="mt-9 grid gap-3 sm:grid-cols-2">
            {MONEY.map((m) => (
              <div
                key={m}
                className="flex items-start gap-3 rounded-2xl border border-[var(--swift-border)] bg-white p-4"
              >
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[var(--swift-red)]" aria-hidden />
                <span className="text-[15px] leading-relaxed">{m}</span>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section tint>
        <h2 className="text-2xl font-bold tracking-tight md:text-3xl">What the dashboard does</h2>
        <p className="mt-3 max-w-2xl text-[var(--swift-muted)]">
          Everything below runs today on the web — you do not need to wait for an app to start
          taking orders.
        </p>
        <ul className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {DASHBOARD.map(({ icon: Icon, title, body }) => (
            <li key={title} className="rounded-2xl bg-white p-6 shadow-sm">
              <Icon className="h-6 w-6 text-[var(--swift-red)]" aria-hidden />
              <h3 className="mt-4 font-bold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-[var(--swift-muted)]">{body}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section>
        <div className="max-w-3xl">
          <h2 className="text-2xl font-bold tracking-tight md:text-3xl">How to join</h2>
          <ol className="mt-7 space-y-5">
            {[
              {
                n: '1',
                t: 'Sign up as a business',
                b: 'Your phone number is your account. No paperwork to start.',
              },
              {
                n: '2',
                t: 'Send your documents',
                b: 'Owner ID, business registration, TIN and a photo of your storefront. Photograph them with your phone — the camera guides the frame.',
              },
              {
                n: '3',
                t: 'We review them',
                b: 'A person checks every document. Most businesses clear review within a day, and you can browse the whole dashboard while you wait.',
              },
              {
                n: '4',
                t: 'Your free trial starts on approval',
                b: 'The trial begins the day you are approved — not the day you applied — so review time never eats into it.',
              },
            ].map((s) => (
              <li key={s.n} className="flex gap-5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--swift-subtle)] text-sm font-bold text-[var(--swift-red)] tabular-nums">
                  {s.n}
                </span>
                <div>
                  <h3 className="font-bold">{s.t}</h3>
                  <p className="mt-1 text-[var(--swift-muted)]">{s.b}</p>
                </div>
              </li>
            ))}
          </ol>

          <div className="mt-10 flex flex-wrap gap-3">
            <Link
              href="/signup"
              className="rounded-full bg-[var(--swift-red)] px-6 py-3 font-semibold text-white transition-colors hover:bg-[var(--swift-red-600)]"
            >
              Start a business account
            </Link>
            <Link
              href="/pricing"
              className="rounded-full border border-[var(--swift-border-strong)] px-6 py-3 font-semibold transition-colors hover:bg-[var(--swift-subtle)]"
            >
              See what it costs
            </Link>
          </div>
        </div>
      </Section>
    </>
  );
}
