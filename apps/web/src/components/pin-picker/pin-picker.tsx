'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { LocateFixed, MapPin, Minus, Plus, Search } from 'lucide-react';
import { placeDetails, placesAutocomplete, type Place } from '@/lib/customer';
import { currentFix } from '@/lib/geolocate';
import { MAX_ACCURACY_M } from '@/lib/place';
import {
  STORE_MAP_START, mapPixel, pixelPoint, pinLookup, storePinAddress, storePinInMarket, type StorePoint,
} from '@/lib/store-pin';

// ---------------------------------------------------------------------------
// [WEB-PIN] ONE PIN PICKER FOR CUSTOMERS — the phone app's rules on the web.
//
// The phone puts a fixed pin in the middle of a street map and moves the map
// under it (LocationPickerScreen / PinConfirmScreen). The website already had
// exactly that for a store's entrance (components/store-location-picker.tsx);
// this is the same map — the same OpenStreetMap tiles, the same Web Mercator
// helpers and Guyana box (lib/store-pin.ts), the same reverse lookup through
// Swift's own API — for a customer's door and a parcel's two ends.
//
// What it promises its caller (`onChange`):
//   - a pin only once the customer could see it: every visible tile loaded;
//   - never the Georgetown centre the map opens on, a rough device fix, nor a
//     delivery zone's centre from search, until the customer has moved the
//     map themselves (the phone's WR-015);
//   - never a point outside Guyana, which it refuses in plain words;
//   - the address Swift's reverse lookup gives for THAT exact point, or null,
//     and whether that lookup has answered yet (`named`).
// The pin goes to Swift's API only. The tiles name the map square being
// viewed, as the store picker's do; no key, no third-party script.
//
// Styled with the site's global classes (sw-*) and utilities only: a CSS file
// of its own would make this lazy chunk carry CSS, and the runtime that loads
// CSS for a lazy chunk would then be added to every page's first load.
// ---------------------------------------------------------------------------

const SECONDARY = 'sw-btn sw-btn-outline sw-btn-md';

export type PinPoint = StorePoint;
/** `named`: Swift's lookup for THIS point has answered (`address` may still be null). */
export interface ChosenPin extends PinPoint { address: string | null; named: boolean }
/** A saved address offered as a starting point (signed-in customers). */
export interface SavedPin { id: string; label: string; addressLine1?: string | null; latitude: number | string; longitude: number | string }

export const PIN_OUTSIDE = 'That pin is outside Guyana, where Swift works today. Move it to a place in Guyana.';
export const PIN_CITY_CENTRE = 'This is a city-centre starting point — move the map to your spot first.';

const TOWN_ZOOM = 14;
const NEAR_ZOOM = 17;
const MIN_ZOOM = 6;
const MAX_ZOOM = 19;

/** The phone's rule: a start that cannot be a pin by itself counts once moved more than 1e-4°. */
function movedFrom(point: PinPoint, from: PinPoint): boolean {
  return Math.abs(point.latitude - from.latitude) > 1e-4 || Math.abs(point.longitude - from.longitude) > 1e-4;
}

function savedPoint(saved: SavedPin): PinPoint | null {
  const latitude = Number(saved.latitude);
  const longitude = Number(saved.longitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
}

export function PinPicker({ mapLabel, start = null, saved = [], onChange }: {
  /** The map's accessible name, e.g. "Delivery pin map". */
  mapLabel: string;
  /** A real point to begin at (an existing pin); without one the map opens on Georgetown. */
  start?: PinPoint | null;
  saved?: SavedPin[];
  /** The confirmable pin, or null while there is none. */
  onChange: (_pin: ChosenPin | null) => void;
}) {
  const id = useId();
  const [point, setPoint] = useState<PinPoint>(start ?? STORE_MAP_START);
  // The start the customer must move away from before it is a pin: the town
  // centre, or a device fix too rough to be a door. null = this is a real pin.
  const [anchor, setAnchor] = useState<{ point: PinPoint; reason: 'centre' | 'rough' | 'area' } | null>(
    start ? null : { point: STORE_MAP_START, reason: 'centre' },
  );
  const [zoom, setZoom] = useState(start ? NEAR_ZOOM : TOWN_ZOOM);
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [named, setNamed] = useState<{ point: PinPoint; line: string | null } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [mapFailed, setMapFailed] = useState(false);
  const [loadedTiles, setLoadedTiles] = useState<Set<string>>(() => new Set());
  const [tileAttempt, setTileAttempt] = useState(0);
  const [size, setSize] = useState({ width: 320, height: 300 });
  const map = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; pixel: { x: number; y: number } } | null>(null);
  // Any move by the customer outdates a pending search pick or device fix: a
  // late answer must never move the map under their hand.
  const revision = useRef(0);
  const searchTicket = useRef(0);
  // A search result or saved address already names its exact point.
  const chosenName = useRef<{ point: PinPoint; line: string } | null>(null);
  const mounted = useRef(true);
  const emit = useRef(onChange);
  useEffect(() => { emit.current = onChange; }, [onChange]);

  useEffect(() => {
    mounted.current = true;
    const element = map.current;
    const resize = () => { if (element) setSize({ width: element.clientWidth || 320, height: element.clientHeight || 300 }); };
    resize();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    if (element) observer?.observe(element);
    return () => { mounted.current = false; observer?.disconnect(); };
  }, []);

  // Name the pin once it settles — never on every frame of a drag.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      const chosen = chosenName.current?.point === point ? chosenName.current.line : null;
      const lookup = chosen ? Promise.resolve(chosen) : storePinAddress(point).catch(() => null);
      void lookup.then((line) => {
        if (!live) return;
        setNamed({ point, line });
        setAnnouncement(`${line ?? 'Pin'}. Latitude ${point.latitude.toFixed(5)}, Longitude ${point.longitude.toFixed(5)}`);
      });
    }, 350);
    return () => { live = false; clearTimeout(timer); };
  }, [point]);

  const pixel = mapPixel(point, zoom);
  const left = pixel.x - size.width / 2;
  const top = pixel.y - size.height / 2;
  const count = 2 ** zoom;
  const tiles: Array<{ key: string; src: string; x: number; y: number }> = [];
  // Only the visible viewport is requested; the browser caches the rest.
  for (let y = Math.max(0, Math.floor(top / 256)); y <= Math.min(count - 1, Math.floor((top + size.height) / 256)); y += 1) {
    for (let x = Math.floor(left / 256); x <= Math.floor((left + size.width) / 256); x += 1) {
      const tileX = ((x % count) + count) % count;
      tiles.push({ key: `${zoom}/${x}/${y}`, src: `https://tile.openstreetmap.org/${zoom}/${tileX}/${y}.png`, x: x * 256 - left, y: y * 256 - top });
    }
  }
  const inMarket = storePinInMarket(point);
  const placed = anchor === null || movedFrom(point, anchor.point);
  const mapReady = tiles.length > 0 && tiles.every((tile) => loadedTiles.has(tile.src));
  const confirmable = inMarket && placed && mapReady && !mapFailed;
  const settled = named?.point === point;
  const line = settled ? named.line : null;

  // In the same commit that draws the pin and its name: the caller never holds
  // a pin (or a missing name) different from the one on screen, even for the
  // moment between a paint and passive effects in which a tap can land.
  useLayoutEffect(() => {
    emit.current(confirmable ? { latitude: point.latitude, longitude: point.longitude, address: line, named: settled } : null);
  }, [confirmable, point, line, settled]);

  function move(next: PinPoint) {
    revision.current += 1;
    setPoint(next);
    setNotice(null);
  }

  /** Put the map on a point: a search result, a saved address or the device.
   *  `vague` (a rough fix, or an area such as a delivery zone) starts the map
   *  there, but only a move by the customer makes it a pin. */
  function jump(next: PinPoint, name: string | null, vague: 'rough' | 'area' | null = null) {
    revision.current += 1;
    chosenName.current = name ? { point: next, line: name } : null;
    setPoint(next);
    setAnchor(vague ? { point: next, reason: vague } : null);
    setZoom(NEAR_ZOOM);
    setSuggestions([]);
    setNotice(null);
  }

  async function search() {
    const text = query.trim();
    const ticket = ++searchTicket.current;
    setSuggestions([]);
    if (text.length < 3) return;
    setSearching(true);
    setNotice(null);
    try {
      const results = await pinLookup(placesAutocomplete(text.slice(0, 120), { lat: point.latitude, lng: point.longitude }));
      if (!mounted.current || ticket !== searchTicket.current) return;
      setSuggestions(results);
      if (!results.length) setNotice('Swift couldn’t find that place. Move the map to your spot instead.');
    } catch {
      if (mounted.current && ticket === searchTicket.current) setNotice('Place search isn’t working right now. Move the map to your spot instead.');
    } finally {
      if (mounted.current && ticket === searchTicket.current) setSearching(false);
    }
  }

  async function choose(place: Place) {
    const ticket = ++revision.current;
    try {
      const detail = place.lat != null && place.lng != null ? { lat: place.lat, lng: place.lng } : await pinLookup(placeDetails(place.placeId));
      if (!mounted.current || ticket !== revision.current) return;
      if (!detail || !Number.isFinite(detail.lat) || !Number.isFinite(detail.lng)) throw new Error('No point for that place');
      // [review S3] A delivery zone (the local provider's `zone:` results) is
      // an area: its point is the polygon's centre, which can be far from any
      // door. It starts the map; the customer moves the pin onto their spot.
      const area = place.placeId.startsWith('zone:');
      jump({ latitude: detail.lat, longitude: detail.lng }, area ? null : [place.primary, place.secondary].filter(Boolean).join(', '), area ? 'area' : null);
      if (area) setNotice(`${place.primary} is an area, not a door. Move the map so the pin is on your spot.`);
      map.current?.focus();
    } catch {
      if (mounted.current && ticket === revision.current) setNotice('Swift couldn’t put that place on the map. Move the map to your spot instead.');
    }
  }

  async function locate() {
    const ticket = ++revision.current;
    setLocating(true);
    setNotice(null);
    try {
      const fix = await currentFix('start the map where you are');
      if (!mounted.current || ticket !== revision.current) return;
      const next = { latitude: fix.lat, longitude: fix.lng };
      if (!storePinInMarket(next)) {
        setNotice('Your location is outside Guyana, where Swift works today. Search for a place or move the map.');
        return;
      }
      // A fix is only as good as the device says. Past this it is a
      // neighbourhood, not a door: start there, but the customer places the pin.
      const rough = fix.accuracyM === null || fix.accuracyM > MAX_ACCURACY_M;
      jump(next, null, rough ? 'rough' : null);
      setNotice(rough
        ? fix.accuracyM === null
          ? 'Your device didn’t say how accurate that is. Move the map so the pin is on your spot.'
          : `Your device placed you only within about ${Math.round(fix.accuracyM)} m. Move the map so the pin is on your spot.`
        : 'Starting where your device is. If you’re not there, move the map.');
    } catch (error) {
      if (mounted.current && ticket === revision.current) {
        setNotice(error instanceof Error ? error.message : 'Swift couldn’t get your location. Search for a place or move the map.');
      }
    } finally {
      if (mounted.current) setLocating(false);
    }
  }

  function changeZoom(next: number) {
    revision.current += 1;
    setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next)));
  }

  function stopDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  const savedPins = saved.flatMap((entry) => {
    const at = savedPoint(entry);
    return at ? [{ entry, at }] : [];
  });

  return (
    <div className="grid gap-3">
      <div>
        <label htmlFor={`${id}-search`} className="sw-field-label">Search for a street or place</label>
        <div className="flex gap-2">
          <input
            id={`${id}-search`}
            className="sw-input"
            value={query}
            autoComplete="off"
            // Typing outdates everything still pending — an older search, and a
            // picked place or device fix not yet answered — as in the store picker.
            onChange={(event) => { revision.current += 1; searchTicket.current += 1; setSearching(false); setQuery(event.target.value); setSuggestions([]); }}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void search(); } }}
          />
          <button type="button" className={`${SECONDARY} shrink-0`} disabled={searching || query.trim().length < 3} onClick={() => void search()}>
            <Search size={16} aria-hidden="true" />{searching ? 'Finding…' : 'Find'}
          </button>
        </div>
      </div>
      {suggestions.length > 0 ? (
        <ul className="m-0 grid list-none gap-1.5 p-0" aria-label="Places found">
          {suggestions.map((place) => (
            <li key={place.placeId}>
              <button type="button" className="w-full cursor-pointer rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-card)] px-4 py-3 text-left text-[15px] font-semibold leading-5 text-[var(--swift-ink)] hover:bg-[var(--swift-sunken)]" onClick={() => void choose(place)}>
                {place.primary}{place.secondary ? `, ${place.secondary}` : ''}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div>
        <button type="button" className={SECONDARY} disabled={locating} onClick={() => void locate()}>
          <LocateFixed size={16} aria-hidden="true" />{locating ? 'Finding you…' : 'Use my location'}
        </button>
      </div>
      {savedPins.length > 0 ? (
        <div className="sw-chip-row" role="group" aria-label="Your saved addresses">
          {savedPins.map(({ entry, at }) => (
            <button key={entry.id} type="button" className="sw-chip" onClick={() => { jump(at, entry.addressLine1?.trim() || entry.label); map.current?.focus(); }}>
              {entry.label}{entry.addressLine1 ? ` — ${entry.addressLine1}` : ''}
            </button>
          ))}
        </div>
      ) : null}
      {notice ? <p role="status" className="sw-caption m-0">{notice}</p> : null}
      <p id={`${id}-help`} className="sw-caption m-0">
        Drag the map to put the pin on the spot. With the map focused, the arrow keys move it (hold Shift for bigger steps) and + or − zooms.
      </p>
      <div
        ref={map}
        className="relative h-[300px] w-full cursor-grab touch-none select-none overflow-hidden rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-sunken)] outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--swift-red)] active:cursor-grabbing"
        tabIndex={0}
        role="application"
        aria-label={mapLabel}
        aria-describedby={`${id}-help ${id}-readout`}
        onKeyDown={(event) => {
          if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(zoom + 1); return; }
          if (event.key === '-' || event.key === '_') { event.preventDefault(); changeZoom(zoom - 1); return; }
          const step = event.shiftKey ? 80 : 12;
          const offset: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
          const delta = offset[event.key];
          if (!delta) return;
          event.preventDefault();
          move(pixelPoint(pixel.x + delta[0], pixel.y + delta[1], zoom));
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || drag.current) return;
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          revision.current += 1;
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, pixel };
        }}
        onPointerMove={(event) => {
          const from = drag.current;
          if (from?.id !== event.pointerId) return;
          move(pixelPoint(from.pixel.x - (event.clientX - from.x), from.pixel.y - (event.clientY - from.y), zoom));
        }}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onLostPointerCapture={() => { drag.current = null; }}
      >
        {tiles.map((tile) => (
          // Raster tiles keep their exact 256 px geometry and the browser's cache.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={`${tileAttempt}/${tile.key}`}
            src={tile.src}
            width={256}
            height={256}
            alt=""
            draggable={false}
            // OpenStreetMap's tile policy needs a Referer from browsers: the
            // site's origin only, never the page's path (pinned here so a
            // stricter page policy cannot strip it).
            referrerPolicy="strict-origin-when-cross-origin"
            className="pointer-events-none absolute max-w-none select-none"
            style={{ left: tile.x, top: tile.y, width: 256, height: 256 }}
            onLoad={() => setLoadedTiles((loaded) => (loaded.has(tile.src) ? loaded : new Set(loaded).add(tile.src)))}
            onError={() => setMapFailed(true)}
          />
        ))}
        {/* Lucide's marker tip sits at y=22 of 24: anchor the tip itself on the chosen point. */}
        <MapPin
          className="pointer-events-none absolute left-1/2 top-1/2 h-9 w-9 text-[var(--swift-red)]"
          style={{ transform: 'translate(-50%, calc(-100% + 3px))', filter: 'drop-shadow(0 1px 2px #fff)' }}
          aria-hidden="true"
          fill="currentColor"
          stroke="white"
        />
      </div>
      <div className="flex gap-2">
        <button type="button" className={`${SECONDARY} flex-1`} disabled={zoom <= MIN_ZOOM} onClick={() => changeZoom(zoom - 1)}>
          <Minus size={16} aria-hidden="true" />Zoom out
        </button>
        <button type="button" className={`${SECONDARY} flex-1`} disabled={zoom >= MAX_ZOOM} onClick={() => changeZoom(zoom + 1)}>
          <Plus size={16} aria-hidden="true" />Zoom in
        </button>
      </div>
      <p className="m-0 text-right text-[11px] leading-[14px] text-[var(--swift-muted)]">
        © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="underline">OpenStreetMap contributors</a>
      </p>
      <div id={`${id}-readout`} role="group" aria-label="Chosen pin" className="grid gap-0.5 rounded-2xl bg-[var(--swift-sunken)] px-3 py-2.5 text-[14px] font-medium leading-5 text-[var(--swift-ink)] [overflow-wrap:anywhere]">
        <span>{settled ? (line ? `Near ${line}` : 'No street name found at this pin.') : 'Finding the address…'}</span>
        <span className="text-[12px] font-normal leading-4 text-[var(--swift-muted)] tabular-nums">Latitude {point.latitude.toFixed(5)}, Longitude {point.longitude.toFixed(5)}</span>
      </div>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</p>
      {!inMarket ? <p role="alert" className="sw-note sw-note-error m-0">{PIN_OUTSIDE}</p> : null}
      {inMarket && !placed && anchor?.reason === 'centre' ? <p className="sw-caption m-0">{PIN_CITY_CENTRE}</p> : null}
      {!mapReady && !mapFailed ? <p className="sw-caption m-0">Loading map…</p> : null}
      {mapFailed ? (
        <>
          <p role="alert" className="sw-note sw-note-error m-0">The map couldn’t load. Retry it to check where the pin is before you use it.</p>
          <button type="button" className={SECONDARY} onClick={() => { setMapFailed(false); setLoadedTiles(new Set()); setTileAttempt((attempt) => attempt + 1); }}>Retry map</button>
        </>
      ) : null}
    </div>
  );
}
