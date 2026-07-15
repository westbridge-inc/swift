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
      </div>
    </Section>
  );
}
