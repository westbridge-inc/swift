'use client';

import { useEffect, useState } from 'react';
import { TileMap } from '@/components/tile-map';
import { answerCheckin, outstandingCheckin, rideSos, type GuardianCheckin } from '@/lib/customer-rides';
import { mapLinkUrl, type Point } from '@/lib/live-tracking';

// ---------------------------------------------------------------------------
// [Row 117 · owner 16 Oct 2026] The trip page's safety half for a taxi ride,
// shown ONLY while the server says web booking is on (the same capabilities
// answer the Taxi page reads). Off, the page keeps pointing to the app.
//
// The phone's three pieces:
//   - the six-digit start code, while a driver is on the way and the code
//     has not been checked (GET /rides/:id — the customer's own ride only),
//     or the phone's warning not to begin the ride while it is missing;
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
  /** The driver's first name, as the phone says it ("Ann types it to start"). */
  driverName?: string | null;
}

/** The phone's rule (TaxiScreen RIDE_PIN_LENGTH): a start code is exactly six digits. */
const START_CODE = /^\d{6}$/;

type SosState = { kind: 'closed' } | { kind: 'asking' } | { kind: 'sending' } | { kind: 'paged' } | { kind: 'failed' };

/** [WEB-TAXI] How often the page asks whether Trip Guardian is waiting on this rider (the hard check gives 2 minutes). */
export const CHECKIN_POLL_MS = 5_000;

/**
 * [WEB-TAXI · owner 21 Oct 2026] Trip Guardian's check-in, on the web.
 *
 * The phone's card (TaxiScreen): raised by the order room's live event and by
 * asking the server on arrival. The website has no order-room socket, so the
 * page ASKS — on arrival, every few seconds while the ride is in progress, and
 * the moment the tab is shown again — and the server decides: a check-in that
 * was answered, escalated or belongs to another trip is null, and no card
 * shows. With the tab closed the rider is texted instead (the server's SMS
 * fallback), so the card is one door in, never the only one.
 */
function useGuardianCheckin(rideId: string, inProgress: boolean) {
  const [checkin, setCheckin] = useState<GuardianCheckin | null>(null);
  useEffect(() => {
    if (!inProgress) { setCheckin(null); return; }
    let live = true;
    const ask = () => {
      outstandingCheckin()
        .then((pending) => { if (live) setCheckin(pending && pending.orderId === rideId ? pending : null); })
        .catch(() => { /* offline or a failed read: the next ask, and the text, are the other ways in */ });
    };
    ask();
    const timer = window.setInterval(ask, CHECKIN_POLL_MS);
    const onShow = () => { if (document.visibilityState === 'visible') ask(); };
    document.addEventListener('visibilitychange', onShow);
    return () => { live = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onShow); };
  }, [rideId, inProgress]);
  return [checkin, setCheckin] as const;
}

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
  const [checkin, setCheckin] = useGuardianCheckin(rideId, status === 'RIDE_IN_PROGRESS');
  const [answering, setAnswering] = useState(false);
  const [answerNote, setAnswerNote] = useState<string | null>(null);
  // The phone's start-code ceremony: while a driver is coming and the code is
  // unchecked, the code — or, if it is missing, a warning not to begin.
  const codeDue = !facts?.ridePinVerified && CODE_STATUSES.includes(status);
  const code = codeDue && START_CODE.test(facts?.ridePin ?? '') ? facts!.ridePin! : null;
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

  // The phone's two answers. OK: the card closes (a failed send says so — the
  // check stays open on the server and asks again). I need help: the server
  // raises the SOS itself, and the emergency panel opens either way, with the
  // truth about whether Swift heard.
  async function answer(response: 'OK' | 'NEED_HELP') {
    if (answering) return;
    setAnswering(true);
    setAnswerNote(null);
    let sent = true;
    try {
      await answerCheckin(response);
    } catch {
      sent = false;
    }
    setAnswering(false);
    setCheckin(null);
    if (response === 'OK') {
      if (!sent) setAnswerNote('Couldn’t send that — Trip Guardian will check in again.');
      return;
    }
    if (!sent) setAnswerNote('Your answer didn’t send — if you need help, use Alert Swift now.');
    setSos(sent ? { kind: 'paged' } : { kind: 'asking' });
  }

  return (
    <section aria-labelledby="taxi-safety-title" className="flex flex-col gap-3 rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-card)] p-4">
      <h2 id="taxi-safety-title" className="sw-heading">Ride safety</h2>

      {checkin && (
        <div role="alertdialog" aria-labelledby="taxi-checkin-title" aria-describedby="taxi-checkin-body" className="flex flex-col gap-2 rounded-xl border border-[var(--swift-border)] p-3">
          <p id="taxi-checkin-title" className="font-semibold">Everything okay?</p>
          <p id="taxi-checkin-body" className="sw-caption">Swift’s Trip Guardian checks in when a trip pauses or changes route. Your driver can’t see your answer.</p>
          <button type="button" className="sw-btn sw-btn-block" disabled={answering} onClick={() => void answer('OK')}>I’m okay</button>
          <button type="button" className="sw-btn sw-btn-outline sw-btn-block" disabled={answering} onClick={() => void answer('NEED_HELP')}>I need help</button>
        </div>
      )}
      {answerNote && <p role="alert" className="sw-note sw-note-error">{answerNote}</p>}

      {codeDue && (
        <div className="flex flex-col gap-1">
          <p className="sw-eyebrow">Say this code to start the ride</p>
          {code ? (
            <p className="text-[28px] font-bold leading-9 tracking-[0.2em] tabular-nums" aria-label={`Start code. ${code.split('').join(', ')}`}>{code}</p>
          ) : (
            <p role="alert" className="sw-note sw-note-error">The six-digit start code isn’t available. Don’t begin the ride until it appears.</p>
          )}
          <p className="sw-caption">It proves this is your ride — {facts?.driverName?.trim() || 'the driver'} types it to start. Check the car and its plate first.</p>
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
            <p id="taxi-sos-title" className="font-semibold">Get emergency help?</p>
            {sos.kind !== 'paged' && (
              <p className="sw-caption">Call {POLICE_NUMBER} — your market’s emergency services — then alert Swift: it pages its safety team and saves this alert on this trip’s record. Use only in a real emergency.</p>
            )}
            <a href={`tel:${POLICE_NUMBER}`} className="sw-btn sw-btn-block">Call {POLICE_NUMBER}</a>
            {sos.kind === 'paged' ? (
              <p role="status" className="sw-note sw-note-info">Swift’s safety team has been paged. Stay on the line with the police if you called them.</p>
            ) : (
              <button type="button" className="sw-btn sw-btn-outline sw-btn-block" disabled={sos.kind === 'sending'} onClick={() => void alertSwift()}>
                {sos.kind === 'sending' ? 'Alerting Swift…' : sos.kind === 'failed' ? 'Try alerting Swift again' : 'Alert Swift now'}
              </button>
            )}
            {sos.kind === 'failed' && (
              <div role="alert" className="sw-note sw-note-error flex-col items-start gap-1">
                <p className="font-semibold">Swift was NOT alerted — the request failed.</p>
                <p>Your emergency call is unaffected. Check your connection and try again so Swift can track and record this emergency.</p>
              </div>
            )}
            {sos.kind === 'asking' && (
              <button type="button" className="sw-link-btn self-start" onClick={() => setSos({ kind: 'closed' })}>Close</button>
            )}
          </div>
        )
      )}

      {!codeDue && !engaged && (
        <p className="sw-caption">Your start code, your driver’s position and SOS appear here once a driver is on the way.</p>
      )}
    </section>
  );
}
