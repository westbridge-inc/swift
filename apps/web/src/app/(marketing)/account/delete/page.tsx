import type { Metadata } from 'next';
import Link from 'next/link';
import { Section } from '@/components/site';
import { site } from '@/site.config';
import { DELETION_GONE, DELETION_KEPT, DELETION_KEPT_LEAD } from '@/lib/account-deletion-words';

// Google Play's account-deletion policy requires a PUBLICLY reachable URL, in
// addition to the in-app path — reachable by someone who has already
// uninstalled the app or lost the phone, and it must name the app, state what
// is deleted, and state what is retained and why. Apple 5.1.1(v) is satisfied
// by the in-app flow this page points at; this page exists for Play and for
// people who cannot open the app.
//
// Deliberately NOT a self-serve form: an unauthenticated "delete this number"
// endpoint is an account-takeover primitive. Deletion is either performed by
// the signed-in person in the app or on the website (immediate; [WEB-DELETE]
// the website's signed-in flow is components/account-deletion) or requested by
// email with identity verification. Play accepts a documented request route.

export const metadata: Metadata = {
  title: 'Delete your Swift account',
  description:
    'How to delete your Swift account and what happens to your data — in the app, on the website, or by request if you can’t sign in.',
};

// [WEB-DELETE] The lists live in lib/account-deletion-words.ts: the website's delete flow shows the same ones.
const KEPT = DELETION_KEPT;
const GONE = DELETION_GONE;

export default function DeleteAccountPage() {
  return (
    <Section>
      <div className="max-w-3xl">
        <h1 className="text-4xl font-extrabold tracking-tight">Delete your Swift account</h1>
        <p className="mt-4 text-lg text-[var(--swift-muted)]">
          Swift is operated by {site.legalEntityName} (registration no. {site.registrationNo}), {site.address}, phone {site.phone}. You can delete your Swift account and its personal
          data at any time. This page explains how, and exactly what is removed and what we are
          required to keep.
        </p>

        <h2 className="mt-12 text-2xl font-bold tracking-tight">In the app or on the website — the fastest way</h2>
        <p className="mt-3 text-[var(--swift-muted)]">
          If you can sign in, delete the account yourself and it happens immediately. In the app:
        </p>
        <ol className="mt-4 list-decimal space-y-2 pl-5 text-[var(--swift-muted)]">
          <li>Open Swift and go to the <b>Profile</b> tab</li>
          <li>Tap <b>Personal data</b></li>
          <li>Tap <b>Delete my account</b> and confirm</li>
        </ol>
        <p className="mt-4 text-[var(--swift-muted)]">
          On the website, sign in at {site.domain} with your phone number and open:
        </p>
        <ul className="mt-4 list-disc space-y-2 pl-5 text-[var(--swift-muted)]">
          <li>A store: <b>Account</b>, then <b>Request account closure</b> (owners) or <b>Delete my account</b> (managers and staff)</li>
          <li>A rider or driver: <b>Account</b>, then <b>Delete my account</b></li>
          <li>A customer: <b>Account</b>, then <b>Personal details</b>, then <b>Delete my account</b></li>
        </ul>
        <p className="mt-4 text-[var(--swift-muted)]">
          The website shows what is deleted and what is kept, asks you to confirm, and may text a code to
          the phone on the account to check it is you.
        </p>
        <p className="mt-4 text-[var(--swift-muted)]">
          You will be asked to finish or cancel anything still in progress first — an open order or
          an unfinished job cannot be abandoned by deleting the account, because someone on the
          other side of it is waiting. The website lists each one.
        </p>

        <h2 className="mt-12 text-2xl font-bold tracking-tight">
          If you can&apos;t sign in
        </h2>
        <p className="mt-3 text-[var(--swift-muted)]">
          Email <b><a className="underline" href="mailto:privacy@swiftgy.com">privacy@swiftgy.com</a></b> from
          the address on your account, or include the phone number you signed up with, and ask for
          your account to be deleted. We verify that the request really comes from the account
          holder before acting on it — that check protects you, and it is why this page has no
          one-click form. You will get confirmation when it is done. We complete verified requests within one month.
        </p>

        <h2 className="mt-12 text-2xl font-bold tracking-tight">
          Business, driver and advertiser accounts
        </h2>
        <p className="mt-3 text-[var(--swift-muted)]">
          The same right applies. Because these accounts carry listings and payment-confirmation
          records, anything outstanding is resolved first — you will be told exactly what is
          outstanding rather than being left guessing. If a rider still holds a customer&apos;s cash from
          an order, the rider&apos;s account deletion waits until our operations team records it resolved,
          or for at most 90 days; the cash record is kept as part of the order record. A
          customer&apos;s own deletion is never blocked by this.
        </p>
        <p className="mt-3 text-[var(--swift-muted)]">
          A store owner closes the account by a request, in the app or on the website. The store
          stops taking new orders as soon as the request is sent; orders already placed still finish, and cancelling the request lifts the pause. Our team then
          takes the store off sale, removes its team members, stops the weekly fee (refunding any week
          paid for that has not started) and closes the account once every order and payment is
          settled. The owner keeps access until then.
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
          {DELETION_KEPT_LEAD}
        </p>
        <dl className="mt-4 space-y-5">
          {KEPT.map((row) => (
            <div key={row.what}>
              <dt className="font-semibold text-[var(--swift-ink)]">{row.what}</dt>
              <dd className="mt-1 text-[var(--swift-muted)]">{row.why} {row.howLong}</dd>
            </div>
          ))}
        </dl>

        <h2 className="mt-12 text-2xl font-bold tracking-tight">Your other rights</h2>
        <p className="mt-3 text-[var(--swift-muted)]">
          Guyana&apos;s Data Protection Act 2023 will give you the right, once in force, to access your data,
          correct it, restrict or object to how it is processed, and receive a copy in a portable
          form. Swift honours these rights now. You can export your data from the same <b>Personal data</b> screen in the app, or
          email <a className="underline" href="mailto:privacy@swiftgy.com">privacy@swiftgy.com</a>. The
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
