import { OpenSwiftApp } from '@/components/open-swift-app';
import { Pictogram, type PictogramName } from '@/components/glyphs';
import { TaxiFareEstimate } from './taxi-fare-estimate';

const TIERS: { pictogram: PictogramName; label: string }[] = [
  { pictogram: 'sedan', label: 'Car' },
  { pictogram: 'estate', label: 'Estate' },
  { pictogram: 'van', label: 'Van' },
  { pictogram: 'bus', label: 'Minibus' },
];

/**
 * [WEB-REDESIGN · Row 117] The Taxi screen: a real fare estimate from Swift's
 * own fare engine (owner 16 Oct 2026), and booking said plainly — it is in the
 * Swift app, with the safety PIN, SOS and trip sharing.
 */
export default function TaxiPage() {
  return (
    <div className="flex flex-col">
      <span className="sw-eyebrow">Taxi</span>
      <h1 className="sw-title mt-1">See your taxi fare</h1>
      <p className="mt-2 max-w-[720px] text-[15px] leading-[22px] text-[var(--swift-muted)]">
        Choose your pickup and destination for a fare estimate, worked out by road the same way the Swift app does.
      </p>
      <div className="mt-5"><TaxiFareEstimate /></div>

      <section aria-labelledby="taxi-book-in-app" className="mt-8 flex max-w-[720px] flex-col">
        <h2 id="taxi-book-in-app" className="sw-heading">Book a taxi in the Swift app</h2>
        <p className="mt-2 text-[15px] leading-[22px] text-[var(--swift-muted)]">Taxi rides are booked in the Swift mobile app during the pilot.</p>
        <p className="mt-1 text-[15px] leading-[22px] text-[var(--swift-muted)]">
          Use the app for your safety PIN, SOS, trip sharing and driver checks.
          Taxi booking is unavailable on the web.
        </p>
        <ul className="mt-5 grid grid-cols-4 gap-2" aria-label="Ride types in the app">
          {TIERS.map((tier) => (
            <li key={tier.label} className="flex flex-col items-center gap-1.5 rounded-2xl bg-[var(--swift-sunken)] px-1 py-4 text-[13px] font-medium leading-[18px]">
              <Pictogram name={tier.pictogram} size={30} />
              {tier.label}
            </li>
          ))}
        </ul>
        <div className="mt-6"><OpenSwiftApp /></div>
      </section>
    </div>
  );
}
