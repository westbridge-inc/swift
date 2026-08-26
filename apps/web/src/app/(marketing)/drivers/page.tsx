import type { Metadata } from 'next';
import Link from 'next/link';
import { Banknote, ShieldCheck, MapPin, FileCheck2, PhoneCall, Radar } from 'lucide-react';
import { Section } from '@/components/site';
import { launch } from '@/site.config';

export const metadata: Metadata = {
  title: 'For riders and drivers',
  description:
    'Deliver or drive on Swift and keep 100% of every delivery fee, fare and tip. One flat weekly fee, paid by you — never a commission taken from your earnings.',
  alternates: { canonical: 'https://swiftgy.com/drivers' },
};

const DOCUMENTS = [
  { t: 'A government ID', b: 'Confirms you are who you say you are.' },
  { t: "A driver's licence", b: 'Valid, and matching the vehicle class you drive.' },
  { t: 'Vehicle registration', b: 'For the vehicle you will actually be working in.' },
  {
    t: 'Insurance with HIRE cover',
    b: 'This one matters most. A private policy does not cover carrying fare-paying passengers, so Swift reads the coverage class off your policy — it cannot be waved through.',
  },
];

const SAFETY = [
  {
    icon: ShieldCheck,
    title: 'A code before anyone gets in',
    body: 'Your passenger reads you a six-digit code and you enter it. It proves the person at your window is the person who booked — protection that runs in your direction, not just theirs.',
  },
  {
    icon: PhoneCall,
    title: 'An emergency button that dials 911',
    body: 'On a trip, one tap reaches emergency services directly and saves the alert with your location to the trip record. Either person can raise it — you are not the only one being looked after.',
  },
  {
    icon: Radar,
    title: 'Honest demand, never theatre',
    body: 'The map shows real waiting orders, coarsened so nobody can identify a customer from it. No invented cars, no fake surge zones. If it is quiet, the app says so.',
  },
  {
    icon: MapPin,
    title: 'The job stated before you accept',
    body: 'Distance, fare, tip and exactly what you collect and pay out — all on the offer, before the clock runs out. No post-hoc surprises.',
  },
];

export default function DriversPage() {
  return (
    <>
      <Section>
        <div className="max-w-3xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--swift-red)]">
            For riders and drivers
          </p>
          <h1 className="mt-4 text-4xl font-extrabold leading-[1.05] tracking-tight md:text-6xl">
            You keep the fare.{' '}
            <span className="text-[var(--swift-red)]">All of it.</span>
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-[var(--swift-muted)]">
            Swift does not take a percentage of your work. You pay one flat weekly fee and every
            delivery fee, every fare and every tip is yours — in your hand, the same day.
          </p>

          <div className="mt-9 rounded-2xl border border-[var(--swift-border)] bg-white p-6">
            <div className="flex items-start gap-3">
              <Banknote className="mt-0.5 h-5 w-5 shrink-0 text-[var(--swift-red)]" aria-hidden />
              <div>
                <h2 className="font-bold">How you actually get paid</h2>
                <ul className="mt-3 space-y-2 text-[15px] leading-relaxed text-[var(--swift-muted)]">
                  <li>
                    <b className="font-semibold text-[var(--swift-ink)]">Deliveries.</b> The customer
                    pays you the delivery fee in cash at the door. It is yours immediately — Swift
                    never sees it.
                  </li>
                  <li>
                    <b className="font-semibold text-[var(--swift-ink)]">Taxi fares.</b> Cash to you
                    at the end of the trip, or the passenger sends it to your own MMG.
                  </li>
                  <li>
                    <b className="font-semibold text-[var(--swift-ink)]">Tips.</b> One hundred
                    percent yours. Swift takes nothing from a tip, ever.
                  </li>
                  <li>
                    <b className="font-semibold text-[var(--swift-ink)]">Your weekly fee.</b> The one
                    charge, paid by card or cash at an MMG agent. That is the whole commercial
                    relationship.
                  </li>
                </ul>
                {/* Deliberate: "cash in hand", never "payout". Swift never pays movers —
                    using the word would describe a money movement that does not happen. */}
                <p className="mt-4 text-sm text-[var(--swift-muted)]">
                  Swift never pays you, because Swift never holds your money. Your earnings screen
                  says <b className="font-semibold text-[var(--swift-ink)]">cash in hand</b> for that
                  reason.
                </p>
              </div>
            </div>
          </div>
        </div>
      </Section>

      <Section tint>
        <h2 className="text-2xl font-bold tracking-tight md:text-3xl">Safety, built for you too</h2>
        <p className="mt-3 max-w-2xl text-[var(--swift-muted)]">
          Most platforms describe safety as something they do for the passenger. These are the parts
          that protect the person driving.
        </p>
        <ul className="mt-8 grid gap-4 md:grid-cols-2">
          {SAFETY.map(({ icon: Icon, title, body }) => (
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
          <h2 className="text-2xl font-bold tracking-tight md:text-3xl">What you need to sign up</h2>
          <p className="mt-3 text-[var(--swift-muted)]">
            Four documents. Photograph them with your phone — the camera frames each one for you.
            Most riders clear review within a day, and you can browse the whole app while you wait.
          </p>
          <ul className="mt-7 space-y-4">
            {DOCUMENTS.map((d) => (
              <li
                key={d.t}
                className="flex items-start gap-4 rounded-2xl border border-[var(--swift-border)] bg-white p-5"
              >
                <FileCheck2 className="mt-0.5 h-5 w-5 shrink-0 text-[var(--swift-red)]" aria-hidden />
                <div>
                  <h3 className="font-bold">{d.t}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-[var(--swift-muted)]">{d.b}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-sm text-[var(--swift-muted)]">
            Riding a bicycle? You will not be asked for a licence, registration or motor insurance.
          </p>

          <div className="mt-10">
            <Link
              href="/signup"
              className="inline-block rounded-full bg-[var(--swift-red)] px-6 py-3 font-semibold text-white transition-colors hover:bg-[var(--swift-red-600)]"
            >
              Start a driver account
            </Link>
            <p className="mt-3 text-sm text-[var(--swift-muted)]">
              Currently onboarding in {launch.markets[0]}.
            </p>
          </div>
        </div>
      </Section>
    </>
  );
}
