import { TaxiFareEstimate } from './taxi-fare-estimate';

/**
 * [WEB-REDESIGN · Row 117] The Taxi screen: a real fare estimate from Swift's
 * own fare engine (owner 16 Oct 2026), and booking said plainly — in the Swift
 * app, and on the web only while the server's WEB_TAXI_BOOKING switch is on
 * (taxi-fare-estimate.tsx asks the server).
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
    </div>
  );
}
