import { OpenSwiftApp } from '@/components/open-swift-app';

export default function TaxiPage() {
  return (
    <div className="mx-auto max-w-lg space-y-5">
      <h1 className="text-2xl font-extrabold">Taxi rides in the Swift app</h1>
      <p>Taxi rides are booked in the Swift mobile app during the pilot.</p>
      <p className="text-[var(--swift-muted)]">
        Use the app for your safety PIN, SOS, trip sharing and driver checks.
        Taxi booking is unavailable on the web.
      </p>
      <OpenSwiftApp />
    </div>
  );
}
