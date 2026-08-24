import type { Metadata } from 'next';
import Link from 'next/link';
import { Section } from '@/components/site';

// Google Play's account-deletion policy requires a PUBLICLY reachable URL, in
// addition to the in-app path — reachable by someone who has already
// uninstalled the app or lost the phone, and it must name the app, state what
// is deleted, and state what is retained and why. Apple 5.1.1(v) is satisfied
// by the in-app flow this page points at; this page exists for Play and for
// people who cannot open the app.
//
// Deliberately NOT a self-serve form: an unauthenticated "delete this number"
// endpoint is an account-takeover primitive. Deletion is either performed by
// the signed-in person in the app (immediate) or requested by email with
// identity verification. Play accepts a documented request route.

export const metadata: Metadata = {
  title: 'Delete your Swift account',
  description:
    'How to delete your Swift account and what happens to your data — in the app, or by request if you no longer have it installed.',
};

const KEPT = [
  {
    what: 'Order, trip and delivery records',
    why: 'Kept in de-identified form for the period required for disputes, guarantees, tax and legal record-keeping. They stop being linked to a person.',
  },
  {
    what: 'Money records — payouts, invoices, settlement',
    why: 'Financial records have their own statutory retention duty. If money is still owed in either direction, that is settled before the account closes.',
  },
  {
    what: 'Safety and incident evidence',
    why: 'Where an incident or a legal hold exists, the case-bound evidence is retained under that hold rather than the account.',
  },
];

const GONE = [
  'Your name, phone number and email',
  'Your profile photo and verification selfie',
  'Your identity documents — the stored file is deleted and its encryption key destroyed, so the data cannot be recovered even from a backup',
  'Your saved addresses and precise locations',
  'Your cart, favourites, emergency contacts and any active trip-share links',
  'Your sign-in sessions and push notification tokens',
];

export default function DeleteAccountPage() {
  return (
    <Section>
      <div className="max-w-3xl">
        <h1 className="text-4xl font-extrabold tracking-tight">Delete your Swift account</h1>
        <p className="mt-4 text-lg text-[var(--swift-muted)]">
          Swift is operated by Westbridge Inc. You can delete your Swift account and its personal
          data at any time. This page explains how, and exactly what is removed and what we are
          required to keep.
        </p>

        <h2 className="mt-12 text-2xl font-bold tracking-tight">In the app — the fastest way</h2>
        <p className="mt-3 text-[var(--swift-muted)]">
          If you still have Swift installed and can sign in, delete the account yourself and it
          happens immediately:
        </p>
        <ol className="mt-4 list-decimal space-y-2 pl-5 text-[var(--swift-muted)]">
          <li>Open Swift and go to the <b>Profile</b> tab</li>
          <li>Tap <b>Personal data</b></li>
          <li>Tap <b>Delete my account</b> and confirm</li>
        </ol>
        <p className="mt-4 text-[var(--swift-muted)]">
          You will be asked to finish or cancel anything still in progress first — an open order or
          an unfinished job cannot be abandoned by deleting the account, because someone on the
          other side of it is waiting.
        </p>

        <h2 className="mt-12 text-2xl font-bold tracking-tight">
          If you no longer have the app
        </h2>
        <p className="mt-3 text-[var(--swift-muted)]">
          Email <b><a className="underline" href="mailto:privacy@swift.gy">privacy@swift.gy</a></b> from
          the address on your account, or include the phone number you signed up with, and ask for
          your account to be deleted. We verify that the request really comes from the account
          holder before acting on it — that check protects you, and it is why this page has no
          one-click form. You will get confirmation when it is done.
        </p>

        <h2 className="mt-12 text-2xl font-bold tracking-tight">
          Business, driver and advertiser accounts
        </h2>
        <p className="mt-3 text-[var(--swift-muted)]">
          The same right applies. Because these accounts carry payouts, listings and settlement
          records, anything outstanding is settled first — you will be told exactly what is
          outstanding rather than being left guessing.
        </p>

        <h2 className="mt-12 text-2xl font-bold tracking-tight">What is deleted</h2>
        <ul className="mt-4 space-y-2 text-[var(--swift-muted)]">
          {GONE.map((item) => (
            <li key={item} className="flex gap-3">
              <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--swift-brand)]" />
              <span>{item}</span>
            </li>
          ))}
        </ul>

        <h2 className="mt-12 text-2xl font-bold tracking-tight">
          What is kept, and why
        </h2>
        <p className="mt-3 text-[var(--swift-muted)]">
          We do not keep anything we are not required to. Where a legal duty applies, the record is
          retained but stripped of the person it belonged to.
        </p>
        <dl className="mt-4 space-y-5">
          {KEPT.map((row) => (
            <div key={row.what}>
              <dt className="font-semibold text-[var(--swift-ink)]">{row.what}</dt>
              <dd className="mt-1 text-[var(--swift-muted)]">{row.why}</dd>
            </div>
          ))}
        </dl>

        <h2 className="mt-12 text-2xl font-bold tracking-tight">Your other rights</h2>
        <p className="mt-3 text-[var(--swift-muted)]">
          Guyana&apos;s Data Protection Act 2023 also gives you the right to access your data,
          correct it, restrict or object to how it is processed, and receive a copy in a portable
          form. You can export your data from the same <b>Personal data</b> screen in the app, or
          email <a className="underline" href="mailto:privacy@swift.gy">privacy@swift.gy</a>. The
          full detail is in our{' '}
          <Link className="underline" href="/legal/privacy">
            privacy policy
          </Link>
          .
        </p>
      </div>
    </Section>
  );
}
