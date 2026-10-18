'use client';

import { useState } from 'react';
import { TileMap } from '@/components/tile-map';
import { rideSos } from '@/lib/customer-rides';
import { mapLinkUrl, type Point } from '@/lib/live-tracking';

// ---------------------------------------------------------------------------
// [Row 117 · owner 16 Oct 2026] The trip page's safety half for a taxi ride,
// shown ONLY while the server says web booking is on (the same capabilities
// answer the Taxi page reads). Off, the page keeps pointing to the app.
//
// The phone's three pieces:
//   - the six-digit ride code, while a driver is on the way and the code has
//     not been checked (GET /rides/:id — the customer's own ride only);
//   - where the driver is, from the ride read the page already polls;
//   - SOS: call the police first (Swift records evidence; it is not the
//     rescuer), and page Swift's safety team (POST /rides/:id/sos — the one
//     SOS engine: SUPER_ADMIN, the tenant's admins and the on-call phones).
// ---------------------------------------------------------------------------

/** Guyana's police line (site.config.ts supportHours: "Police 911, Fire 912, Ambulance 913"). */
export const POLICE_NUMBER = '911';

const CODE_STATUSES = ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'];
const DRIVER_ENGAGED = [...CODE_STATUSES, 'RIDE_IN_PROGRESS'];

export interface TaxiSafetyFacts {
  ridePin: string | null;
  ridePinVerified: boolean;
  driverAt: Point | null;
}

type SosState = { kind: 'closed' } | { kind: 'asking' } | { kind: 'sending' } | { kind: 'paged' } | { kind: 'failed' };

/** A fix only if the browser already allows it, and only if it comes quickly: help is never held up by a prompt. */
async function quickFixIfAllowed(): Promise<Point | null> {
  try {
    const permission = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    if (permission?.state !== 'granted' || !navigator.geolocation) return null;
    return await new Promise<Point | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 3000);
      navigator.geolocation.getCurrentPosition(
        (position) => { clearTimeout(timer); resolve({ lat: position.coords.latitude, lng: position.coords.longitude }); },
        () => { clearTimeout(timer); resolve(null); },
        { maximumAge: 60_000, timeout: 3000 },
      );
    });
  } catch {
    return null;
  }
}

export function TaxiTripSafety({ rideId, status, facts }: { rideId: string; status: string; facts: TaxiSafetyFacts | null }) {
  const [sos, setSos] = useState<SosState>({ kind: 'closed' });
  const showCode = Boolean(facts?.ridePin) && !facts?.ridePinVerified && CODE_STATUSES.includes(status);
  const engaged = DRIVER_ENGAGED.includes(status);
  const driverAt = engaged ? facts?.driverAt ?? null : null;

  async function alertSwift() {
    if (sos.kind === 'sending') return;
    setSos({ kind: 'sending' });
    try {
      await rideSos(rideId, await quickFixIfAllowed());
      setSos({ kind: 'paged' });
    } catch {
      setSos({ kind: 'failed' });
    }
  }

  return (
    <section aria-labelledby="taxi-safety-title" className="flex flex-col gap-3 rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-card)] p-4">
      <h2 id="taxi-safety-title" className="sw-heading">Ride safety</h2>

      {showCode && (
        <div className="flex flex-col gap-1">
          <p className="sw-eyebrow">Your ride code</p>
          <p className="text-[28px] font-bold leading-9 tracking-[0.2em] tabular-nums" aria-label={`Your ride code is ${facts!.ridePin!.split('').join(' ')}`}>{facts!.ridePin}</p>
          <p className="sw-caption">Check the car and its plate first. Tell your driver this code when you get in — they enter it before the ride starts.</p>
        </div>
      )}

      {driverAt && (
        <TileMap point={driverAt} label="Your driver’s position" linkHref={mapLinkUrl(driverAt)} linkLabel="Open map" />
      )}

      {engaged && (
        sos.kind === 'closed' ? (
          <button type="button" className="sw-btn sw-btn-block" onClick={() => setSos({ kind: 'asking' })}>Emergency — get help now</button>
        ) : (
          <div role="group" aria-labelledby="taxi-sos-title" className="flex flex-col gap-2">
            <p id="taxi-sos-title" className="font-semibold">Get help now</p>
            <a href={`tel:${POLICE_NUMBER}`} className="sw-btn sw-btn-block">Call Police {POLICE_NUMBER}</a>
            {sos.kind === 'paged' ? (
              <p role="status" className="sw-note sw-note-info">Swift’s safety team has been paged. Stay on the line with the police if you called them.</p>
            ) : (
              <button type="button" className="sw-btn sw-btn-outline sw-btn-block" disabled={sos.kind === 'sending'} onClick={() => void alertSwift()}>
                {sos.kind === 'sending' ? 'Alerting Swift…' : sos.kind === 'failed' ? 'Try alerting Swift again' : 'Alert Swift’s safety team'}
              </button>
            )}
            {sos.kind === 'failed' && (
              <p role="alert" className="sw-note sw-note-error">Swift was NOT alerted. Call the police now, then try again.</p>
            )}
            {sos.kind === 'asking' && (
              <button type="button" className="sw-link-btn self-start" onClick={() => setSos({ kind: 'closed' })}>Close</button>
            )}
          </div>
        )
      )}

      {!showCode && !engaged && (
        <p className="sw-caption">Your ride code, your driver’s position and SOS appear here once a driver is on the way.</p>
      )}
    </section>
  );
}
