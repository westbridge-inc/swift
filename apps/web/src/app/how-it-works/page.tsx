import type { Metadata } from 'next';
import { Section } from '@/components/site';

export const metadata: Metadata = { title: 'How it works' };

const CUSTOMER_STEPS = [
  ['Order', 'Pick a restaurant, supermarket or shop and order in the app — delivery or pickup.'],
  ['Change your mind, free', 'Every order has a short free-cancel window before the store even sees it. Nothing gets cooked or dispatched until it closes.'],
  ['The store gets to work', 'Restaurants cook; supermarkets shelf-pick your list item by item — if something is out of stock, you approve the substitute live.'],
  ['The nearest rider brings it', 'Dispatch pings the closest available rider, Uber-style. You watch every step on a live map.'],
  ['Pay at the door — or MMG', 'Cash at handover, or pay the store directly on their own MMG. Swift never holds your money.'],
];

const RIDE_STEPS = [
  ['Request', 'Set pickup and drop-off; see the fare before you book.'],
  ['Matched to the nearest driver', 'The closest available driver gets the ping and accepts.'],
  ['PIN handshake', 'Your driver enters the PIN from your app — proof the right person got in the right car.'],
  ['Ride and pay the driver', 'Cash or the driver’s own MMG. The fare is theirs, 100%.'],
];

export default function HowItWorksPage() {
  return (
    <>
      <Section>
        <h1 className="text-4xl font-extrabold tracking-tight">How Swift works</h1>
        <p className="mt-3 max-w-2xl text-lg text-[var(--swift-muted)]">
          One backend, one honest flow — from your tap to the door.
        </p>
      </Section>
      <Section tint>
        <h2 className="text-2xl font-bold">Ordering</h2>
        <ol className="mt-6 grid gap-6 md:grid-cols-2">
          {CUSTOMER_STEPS.map(([title, body], i) => (
            <li key={title} className="rounded-2xl bg-white p-6 shadow-sm">
              <span className="text-sm font-bold text-[var(--swift-red)]">Step {i + 1}</span>
              <h3 className="mt-1 text-lg font-bold">{title}</h3>
              <p className="mt-2 text-[var(--swift-muted)]">{body}</p>
            </li>
          ))}
        </ol>
      </Section>
      <Section>
        <h2 className="text-2xl font-bold">Rides</h2>
        <ol className="mt-6 grid gap-6 md:grid-cols-2">
          {RIDE_STEPS.map(([title, body], i) => (
            <li key={title} className="rounded-2xl border border-black/5 p-6">
              <span className="text-sm font-bold text-[var(--swift-red)]">Step {i + 1}</span>
              <h3 className="mt-1 text-lg font-bold">{title}</h3>
              <p className="mt-2 text-[var(--swift-muted)]">{body}</p>
            </li>
          ))}
        </ol>
      </Section>
    </>
  );
}
