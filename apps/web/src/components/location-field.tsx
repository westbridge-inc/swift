'use client';

import { useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { placesAutocomplete, placeDetails, type Place } from '@/lib/customer';
import { createSequence } from '@/lib/live-tracking';
import { pickedPlaceMatches, type PickedPlace } from '@/lib/place';

// ---------------------------------------------------------------------------
// THE TEXT IN THE BOX IS THE PLACE, OR THERE IS NO PLACE.
//
// [W-19] The courier form kept the two apart: pick "42 Lamaha Street", edit the
// box to "9 Camp Road" without tapping a suggestion, and it still submitted
// Lamaha's coordinates. [W-18] The taxi form had the identical defect and its
// own copy of the search box — pick a dropoff, edit the visible text, and the
// driver was dispatched to the place the passenger had just replaced, while
// the screen showed the new one.
//
// So there is ONE field, and typing INVALIDATES the selection. There is no path
// through this component where the box shows one address and the form holds
// another. It is SHARED rather than copied, because a second copy is exactly
// how the taxi page came to still have the bug the courier page had fixed.
// ---------------------------------------------------------------------------

export function LocationField({
  label,
  text,
  place,
  onChange,
  near,
}: {
  label: string;
  text: string;
  place: PickedPlace | null;
  onChange: (_text: string, _place: PickedPlace | null) => void;
  near?: PickedPlace | null;
}) {
  const [sugg, setSugg] = useState<Place[]>([]);
  const [searchFailed, setSearchFailed] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // [W-19] A slow response for an earlier query must never replace the
  // suggestions for a later one — picking from a stale list chooses a place
  // for text that is no longer in the box.
  const seq = useRef(createSequence());

  function edit(v: string) {
    // Typing INVALIDATES the selection. There is no path where the box shows
    // one address and the form holds another.
    onChange(v, pickedPlaceMatches(place, v) ? place : null);
    if (debounce.current) clearTimeout(debounce.current);
    if (v.trim().length < 3) { setSugg([]); setSearchFailed(false); return; }
    const mine = seq.current.next();
    debounce.current = setTimeout(() => {
      placesAutocomplete(v.trim(), near ? { lat: near.lat, lng: near.lng } : undefined)
        .then((r) => { if (seq.current.accept(mine)) { setSugg(r); setSearchFailed(false); } })
        .catch(() => { if (seq.current.accept(mine)) { setSugg([]); setSearchFailed(true); } });
    }, 250);
  }

  async function pick(p: Place) {
    setSugg([]); setSearchFailed(false);
    try {
      const d = p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : await placeDetails(p.placeId);
      onChange(p.primary, { label: p.primary, lat: d.lat, lng: d.lng, placeId: p.placeId });
    } catch {
      // The details lookup failed, so there is no point — say so rather than
      // leaving the name in the box with nothing behind it.
      onChange(p.primary, null);
      setSearchFailed(true);
    }
  }

  return (
    <div className="relative rounded-2xl border border-black/5 bg-white p-3">
      <p className="text-xs font-semibold text-[var(--swift-muted)]">{label}</p>
      <div className="flex items-center gap-2">
        <Search className="h-4 w-4 text-[var(--swift-muted)]" />
        {/* the box shows the text and NOTHING else — the old
            `q || value?.label` put a cleared address back on screen */}
        <input
          value={text}
          onChange={(e) => edit(e.target.value)}
          placeholder="Search address…"
          className="w-full py-1 outline-none"
        />
      </div>
      {text.trim().length >= 3 && !place && !searchFailed && sugg.length === 0 && (
        <p className="mt-1 text-xs text-[var(--swift-muted)]">Choose an address from the list — we send to the pin, not the words.</p>
      )}
      {searchFailed && (
        <p role="alert" className="mt-1 text-xs font-semibold text-[var(--swift-red)]">Address search is unavailable right now, so we can&apos;t place this on the map.</p>
      )}
      {sugg.length > 0 && (
        <ul className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-xl border border-black/10 bg-white shadow-lg">
          {sugg.map((s) => (
            <li key={s.placeId}>
              <button onClick={() => pick(s)} className="w-full px-3 py-2.5 text-left hover:bg-[var(--swift-subtle)]">
                {s.primary}{s.secondary && <span className="block text-xs text-[var(--swift-muted)]">{s.secondary}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
