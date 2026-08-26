import type { Metadata } from 'next';
import Link from 'next/link';
import { Mail, MapPin, Phone, LifeBuoy, ShieldAlert } from 'lucide-react';
import { Section } from '@/components/site';
import { site, SITE_ORIGIN } from '@/site.config';

export const metadata: Metadata = {
  title: 'Contact',
  description: `Reach Swift — ${site.supportEmail}, by phone, or by post. Support, business enquiries, data requests and child-safety reports.`,
  alternates: { canonical: `${SITE_ORIGIN}/contact` },
};

export default function ContactPage() {
  const dialable = site.phone.replace(/[^\d+]/g, '');

  return (
    <Section>
      <div className="max-w-3xl">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--swift-red)]">
          Contact
        </p>
        <h1 className="mt-4 text-4xl font-extrabold leading-[1.05] tracking-tight md:text-5xl">
          Talk to a person.
        </h1>
        <p className="mt-5 text-lg leading-relaxed text-[var(--swift-muted)]">
          You do not need the app, an account, or a ticket number to reach us.
        </p>

        {/* AC-4 / AC-5: a reviewer must find the address, the phone and the
            support inbox on one page without signing in. All three come from
            site.config, which the founder fills with the exact D&B values. */}
        <dl className="mt-9 grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-[var(--swift-border)] bg-white p-6">
            <dt className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.1em] text-[var(--swift-muted)]">
              <Mail className="h-4 w-4 text-[var(--swift-red)]" aria-hidden /> Email
            </dt>
            <dd className="mt-3">
              <a
                className="text-lg font-semibold text-[var(--swift-red)] underline underline-offset-2"
                href={`mailto:${site.supportEmail}`}
              >
                {site.supportEmail}
              </a>
              <p className="mt-2 text-sm text-[var(--swift-muted)]">
                Support, business enquiries and anything else. Answered by a person.
              </p>
            </dd>
          </div>

          <div className="rounded-2xl border border-[var(--swift-border)] bg-white p-6">
            <dt className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.1em] text-[var(--swift-muted)]">
              <Phone className="h-4 w-4 text-[var(--swift-red)]" aria-hidden /> Phone
            </dt>
            <dd className="mt-3">
              <a className="text-lg font-semibold" href={`tel:${dialable}`}>
                {site.phone}
              </a>
              <p className="mt-2 text-sm text-[var(--swift-muted)]">
                Business hours, {site.domain.replace('.com', '')} time.
              </p>
            </dd>
          </div>

          <div className="rounded-2xl border border-[var(--swift-border)] bg-white p-6 sm:col-span-2">
            <dt className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.1em] text-[var(--swift-muted)]">
              <MapPin className="h-4 w-4 text-[var(--swift-red)]" aria-hidden /> Registered office
            </dt>
            <dd className="mt-3">
              <p className="text-lg font-semibold">{site.legalEntityName}</p>
              <address className="mt-1 not-italic text-[var(--swift-muted)]">{site.address}</address>
            </dd>
          </div>
        </dl>

        <h2 className="mt-14 text-2xl font-bold tracking-tight">Specific things</h2>
        <ul className="mt-6 space-y-4">
          <li className="flex items-start gap-4 rounded-2xl bg-[var(--swift-subtle)] p-5">
            <LifeBuoy className="mt-0.5 h-5 w-5 shrink-0 text-[var(--swift-red)]" aria-hidden />
            <div>
              <h3 className="font-bold">A problem with an order or a ride</h3>
              <p className="mt-1 text-sm leading-relaxed text-[var(--swift-muted)]">
                Help &amp; Support inside the app is fastest — it opens a tracked ticket already
                attached to the order, so nobody has to ask you which one. Without the app, email{' '}
                <a className="underline underline-offset-2" href={`mailto:${site.supportEmail}`}>
                  {site.supportEmail}
                </a>
                .
              </p>
            </div>
          </li>
          <li className="flex items-start gap-4 rounded-2xl bg-[var(--swift-subtle)] p-5">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-[var(--swift-red)]" aria-hidden />
            <div>
              <h3 className="font-bold">Your personal data, or deleting your account</h3>
              <p className="mt-1 text-sm leading-relaxed text-[var(--swift-muted)]">
                Access, correction and deletion are covered on the{' '}
                <Link className="underline underline-offset-2" href="/account/delete">
                  delete your account
                </Link>{' '}
                page — no sign-in needed. Your rights under Guyana&apos;s Data Protection Act 2023
                are set out in the{' '}
                <Link className="underline underline-offset-2" href="/legal/privacy">
                  privacy policy
                </Link>
                .
              </p>
            </div>
          </li>
        </ul>

        <p className="mt-12 text-sm text-[var(--swift-muted)]">
          Swift is operated by{' '}
          <b className="font-semibold text-[var(--swift-ink)]">{site.legalEntityName}</b>.
        </p>
      </div>
    </Section>
  );
}
