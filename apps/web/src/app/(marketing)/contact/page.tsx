import type { Metadata } from 'next';
import { Section } from '@/components/site';

export const metadata: Metadata = { title: 'Contact' };

export default function ContactPage() {
  return (
    <Section>
      <div className="max-w-3xl">
        <h1 className="text-4xl font-extrabold tracking-tight">Contact</h1>
        <p className="mt-4 text-lg text-[var(--swift-muted)]">
          The fastest way to reach us is <b>Help &amp; Support inside the Swift app</b> — it opens a
          tracked ticket tied to your account and order, and our team works the queue daily.
        </p>
        <p className="mt-4 text-[var(--swift-muted)]">
          Business and partnership enquiries: choose <b>Business</b> at sign-up in the app, or speak
          to our onboarding team through the in-app support channel.
        </p>
        {/* Apple 1.5 expects a contact route that works for someone who does
            not have the app. Only addresses the privacy policy already
            publishes are listed here — an address we have not confirmed is
            live would be worse than none. */}
        <h2 className="mt-10 text-2xl font-bold tracking-tight">If you don&apos;t have the app</h2>
        <p className="mt-3 text-[var(--swift-muted)]">
          For anything about your personal data — access, correction, or deleting your account —
          email <b><a className="underline" href="mailto:privacy@swift.gy">privacy@swift.gy</a></b>.
          To report a child-safety concern, email{' '}
          <b><a className="underline" href="mailto:childsafety@swift.gy">childsafety@swift.gy</a></b>.
        </p>
        <p className="mt-4 text-[var(--swift-muted)]">
          Deleting your account is explained in full on the{' '}
          <a className="underline" href="/delete-account">
            delete your account
          </a>{' '}
          page.
        </p>
        <p className="mt-8 text-sm text-[var(--swift-muted)]">
          Swift is operated by Westbridge Inc.
        </p>
      </div>
    </Section>
  );
}
