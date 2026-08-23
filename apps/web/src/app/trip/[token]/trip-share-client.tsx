'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// The polling client for the §6 public trip page. Renders exactly what the
// server said, marks how fresh it is, and degrades honestly: an expired or
// revoked share is a clear "no longer available", never a spinner forever.

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3000';
const POLL_MS = 5000;

interface TripView {
  status: string;
  ended: boolean;
  passengerFirstName: string;
  driver: {
    firstName: string;
    photoUrl: string | null;
    vehiclePhotoUrl: string | null;
    vehicle: string;
    plate: string;
  } | null;
  location: { lat: number; lng: number; at: string | null } | null;
  emergencyNote: string;
}

export function TripShareClient({ token }: { token: string }) {
  const [view, setView] = useState<TripView | null>(null);
  const [gone, setGone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/safety/public/trip/${encodeURIComponent(token)}`, { cache: 'no-store' });
      if (res.status === 404) {
        setGone(true);
        setView(null);
        if (timer.current) clearInterval(timer.current);
        return;
      }
      const body = await res.json();
      if (body?.success && body.data) {
        setView(body.data as TripView);
        setFetchedAt(Date.now());
        if (body.data.ended && timer.current) clearInterval(timer.current); // trip over — stop polling
      }
    } catch {
      // Network blip: keep the last-good view on screen; the freshness line
      // tells the truth about its age.
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
    timer.current = setInterval(() => void load(), POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [load]);

  const ageSeconds = fetchedAt ? Math.max(0, Math.round((Date.now() - fetchedAt) / 1000)) : null;

  return (
    <main className="min-h-screen bg-[#FBFBF9] text-[#211A1A]">
      <header className="bg-[#803B3B] px-5 py-4">
        <p className="text-lg font-bold text-white">Swift — live trip</p>
        {view ? (
          <p className="mt-0.5 text-sm text-white/85">
            {view.passengerFirstName} shared this trip with you
          </p>
        ) : null}
      </header>

      <div className="mx-auto max-w-md px-4 pb-12">
        {loading ? (
          <p className="pt-16 text-center text-sm text-[#786C6C]">Loading trip…</p>
        ) : gone ? (
          <div className="pt-16 text-center">
            <p className="text-lg font-semibold">This trip share is no longer available</p>
            <p className="mt-2 text-sm text-[#786C6C]">
              Shares end shortly after a trip finishes, or when the sharer turns them off.
            </p>
          </div>
        ) : !view ? (
          // [WR-012] Only a real 404 proves revocation. A failed FIRST load is
          // a connectivity problem on a safety surface — say that, keep
          // polling (the interval is still running), never dress it as "ended".
          <div className="pt-16 text-center">
            <p className="text-lg font-semibold">Can&apos;t reach this trip right now</p>
            <p className="mt-2 text-sm text-[#786C6C]">
              Check your connection — this page keeps retrying on its own.
            </p>
          </div>
        ) : (
          <>
            <div className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
              <p className="text-base font-semibold">{view.status}</p>
              {ageSeconds !== null && !view.ended ? (
                <p className="mt-0.5 text-xs text-[#786C6C]">Updated {ageSeconds < 3 ? 'just now' : `${ageSeconds}s ago`}</p>
              ) : null}
            </div>

            {view.driver ? (
              <div className="mt-3 flex items-center gap-3 rounded-2xl bg-white p-4 shadow-sm">
                {view.driver.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={view.driver.photoUrl} alt={`Driver ${view.driver.firstName}`} className="h-14 w-14 rounded-full object-cover" />
                ) : (
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#F5EBEC] text-lg font-bold text-[#803B3B]">
                    {view.driver.firstName.slice(0, 1)}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{view.driver.firstName}</p>
                  <p className="truncate text-sm text-[#786C6C]">{view.driver.vehicle}</p>
                </div>
                <div className="rounded-lg border-2 border-[#211A1A] px-2 py-1 font-mono text-sm font-bold">
                  {view.driver.plate}
                </div>
              </div>
            ) : null}

            {view.location ? (
              <div className="mt-3 overflow-hidden rounded-2xl bg-white shadow-sm">
                <iframe
                  title="Live trip location"
                  className="h-64 w-full border-0"
                  loading="lazy"
                  src={`https://www.openstreetmap.org/export/embed.html?bbox=${view.location.lng - 0.008}%2C${view.location.lat - 0.008}%2C${view.location.lng + 0.008}%2C${view.location.lat + 0.008}&layer=mapnik&marker=${view.location.lat}%2C${view.location.lng}`}
                />
                <a
                  className="block px-4 py-3 text-sm font-semibold text-[#803B3B]"
                  href={`https://www.openstreetmap.org/?mlat=${view.location.lat}&mlon=${view.location.lng}#map=16/${view.location.lat}/${view.location.lng}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open full map ↗
                </a>
              </div>
            ) : view.ended ? (
              <div className="mt-3 rounded-2xl bg-white p-4 text-sm text-[#786C6C] shadow-sm">
                The trip has ended — live location is off.
              </div>
            ) : (
              <div className="mt-3 rounded-2xl bg-white p-4 text-sm text-[#786C6C] shadow-sm">
                Waiting for the driver&apos;s location…
              </div>
            )}

            <div className="mt-3 rounded-2xl border border-[#EAE2E1] bg-white p-4 text-sm shadow-sm">
              <p className="font-semibold text-[#DC2626]">Emergency?</p>
              <p className="mt-1 text-[#786C6C]">{view.emergencyNote}</p>
              <a href="tel:911" className="mt-2 inline-block rounded-full bg-[#DC2626] px-4 py-2 text-sm font-semibold text-white">
                Call 911
              </a>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
