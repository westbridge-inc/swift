import { OpenSwiftApp } from '@/components/open-swift-app';
import { Pictogram, type PictogramName } from '@/components/glyphs';

const TIERS: { pictogram: PictogramName; label: string }[] = [
  { pictogram: 'sedan', label: 'Car' },
  { pictogram: 'estate', label: 'Estate' },
  { pictogram: 'van', label: 'Van' },
  { pictogram: 'bus', label: 'Minibus' },
];

/** [WEB-REDESIGN] The design's Taxi screen: rides are an app feature, said plainly. */
export default function TaxiPage() {
  return (
    <div className="mx-auto flex max-w-[720px] flex-col">
      <span className="sw-eyebrow">Taxi</span>
      <h1 className="sw-title mt-1">Rides are booked in the Swift app</h1>
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
    </div>
  );
}
