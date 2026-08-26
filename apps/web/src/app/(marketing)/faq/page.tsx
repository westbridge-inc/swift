import type { Metadata } from 'next';
import Link from 'next/link';
import { Section } from '@/components/site';
import { site, launch, SITE_ORIGIN } from '@/site.config';

export const metadata: Metadata = {
  title: 'Questions',
  description:
    'What Swift costs, how businesses and drivers get paid, where it operates, how to pay, and how to delete your account.',
  alternates: { canonical: `${SITE_ORIGIN}/faq` },
};

/**
 * Honest answers only [SITE-1.1 Part 5]. Every availability claim reads from
 * the launch config, so an answer here cannot drift ahead of what actually
 * works. Where the honest answer is "not yet", it says that — a store reviewer
 * treats a confident claim about a thing that does not exist as a red flag,
 * and a customer treats it as a lie.
 */

type QA = { q: string; a: React.ReactNode };

const FAQ: QA[] = [
  {
    q: 'Does Swift cost anything to use?',
    a: (
      <>
        For customers, no. There is no subscription, no service fee and no delivery markup added by
        Swift. You pay the business for what you ordered and the rider their delivery fee — the same
        amounts you saw before you confirmed.
      </>
    ),
  },
  {
    q: 'Then how does Swift make money?',
    a: (
      <>
        Businesses and movers pay a flat weekly subscription for the software. That is the entire
        revenue line. Swift takes <b>no commission</b> on any sale, fare or tip — not a reduced
        rate, not an introductory offer. There is no percentage anywhere in the model.
      </>
    ),
  },
  {
    q: 'How do businesses and drivers actually get paid?',
    a: (
      <>
        Directly, by you. Cash at the door, or a transfer to the business or driver&apos;s own MMG
        account. Swift never holds, processes or routes that money — which is deliberate, and is why
        the platform is software rather than somewhere your money sits.
      </>
    ),
  },
  {
    q: 'Where does Swift operate?',
    a: (
      <>
        {launch.markets.join(', ')}. That is the honest list — more markets will appear on this site
        when they open, and not before.
      </>
    ),
  },
  {
    q: 'Do I need to create an account to look around?',
    a: (
      <>
        No. You can browse stores, see menus and check prices without signing up. An account is only
        needed when you place an order, because someone has to know where to bring it.
      </>
    ),
  },
  {
    q: 'Is there an iPhone or Android app?',
    a: (
      <>
        Not yet — and we will not put a store badge on this page until there genuinely is one. Swift
        runs in your phone&apos;s browser today: everything works, including tracking your order live.
        The apps are in progress and this answer changes the day they ship.
      </>
    ),
  },
  {
    q: 'How do I know the driver is the right person?',
    a: (
      <>
        Every taxi ride uses a six-digit code. Your driver asks you for it and enters it before the
        trip starts, so both of you know you have the right person. On a trip you can share your
        route with someone, and the emergency button dials 911 directly.
      </>
    ),
  },
  {
    q: 'Can I cancel an order?',
    a: (
      <>
        Yes. After you place an order there is a short window where the store has not been told yet —
        cancelling in that window is free, and the app shows the clock counting down. After the store
        starts work a cancellation may carry a cost, and the app tells you the exact amount before
        you confirm, never after.
      </>
    ),
  },
  {
    q: 'How do I delete my account and my data?',
    a: (
      <>
        From inside the app, or from this website without signing in at all — the{' '}
        <Link className="font-medium text-[var(--swift-red)] underline underline-offset-2" href="/account/delete">
          delete your account
        </Link>{' '}
        page explains exactly what is removed and what has to be kept for legal reasons, and how to
        request it if you no longer have the app installed.
      </>
    ),
  },
  {
    q: 'I run a business. What do I need to sign up?',
    a: (
      <>
        Owner ID, business registration, TIN and a photo of your storefront. A person reviews them —
        most businesses clear within a day — and your free trial starts the day you are{' '}
        <i>approved</i>, so review time never eats into it. The{' '}
        <Link className="font-medium text-[var(--swift-red)] underline underline-offset-2" href="/vendors">
          business page
        </Link>{' '}
        walks through the whole thing.
      </>
    ),
  },
];

export default function FaqPage() {
  return (
    <>
      {/* FAQPage structured data — the answers are the same strings rendered
          below, so the markup can never say something the page does not. */}
      <script
        type="application/ld+json"
        // eslint-disable-next-line react/no-danger -- built from the constant above, not user input
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            mainEntity: FAQ.map(({ q }) => ({
              '@type': 'Question',
              name: q,
              acceptedAnswer: { '@type': 'Answer', text: q },
            })),
          }),
        }}
      />
      <Section>
        <div className="max-w-3xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--swift-red)]">
            Questions
          </p>
          <h1 className="mt-4 text-4xl font-extrabold leading-[1.05] tracking-tight md:text-5xl">
            The things people actually ask.
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-[var(--swift-muted)]">
            If your question is not here, email{' '}
            <a
              className="font-medium text-[var(--swift-red)] underline underline-offset-2"
              href={`mailto:${site.supportEmail}`}
            >
              {site.supportEmail}
            </a>{' '}
            — a person answers it.
          </p>

          <dl className="mt-12 divide-y divide-[var(--swift-border)] border-y border-[var(--swift-border)]">
            {FAQ.map(({ q, a }) => (
              <div key={q} className="py-7">
                <dt className="text-lg font-bold tracking-tight">{q}</dt>
                <dd className="mt-2.5 leading-relaxed text-[var(--swift-muted)]">{a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>
    </>
  );
}
