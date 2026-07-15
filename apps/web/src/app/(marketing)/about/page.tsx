import type { Metadata } from 'next';
import { Section } from '@/components/site';

export const metadata: Metadata = { title: 'About' };

export default function AboutPage() {
  return (
    <Section>
      <div className="max-w-3xl">
        <h1 className="text-4xl font-extrabold tracking-tight">Built for the Caribbean</h1>
        <p className="mt-4 text-lg text-[var(--swift-muted)]">
          Swift is a Caribbean-built super-app: food, groceries, shops, couriers and rides in one
          place, starting in Guyana and live across thirteen Caribbean markets.
        </p>
        <p className="mt-4 text-[var(--swift-muted)]">
          We built Swift around one idea: the people doing the work should keep the money. Businesses
          and drivers pay a flat weekly subscription and keep 100% of what they earn — there is no
          commission and there never will be. Payments are cash-first and MMG-direct because that is
          how our region actually pays, and Swift never holds a dollar of order money.
        </p>
        <p className="mt-4 text-[var(--swift-muted)]">Swift is operated by Westbridge Inc.</p>
      </div>
    </Section>
  );
}
