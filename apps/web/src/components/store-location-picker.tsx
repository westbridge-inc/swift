'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { MapPin } from 'lucide-react';
import { placesAutocomplete, placeDetails, type Place } from '@/lib/customer-places';
import { currentCoords } from '@/lib/geolocate';
import {
  STORE_MAP_START, STORE_PIN_OUTSIDE, mapPixel, pixelPoint, pinLookup,
  storePinAddress, storePinInMarket, storePinMoved, type StorePin, type StorePoint,
} from '@/lib/store-pin';
import { MAP_TILES_UNAVAILABLE, mapTileSource } from '@/lib/map-tiles';
import { MapAttribution } from './map-attribution';
import styles from './store-location-picker.module.css';

/** A fixed entrance pin: drag the street map beneath it, as on the phone.
 * Search and GPS only suggest a start; only the confirm button returns a pin.
 * Remounted on every open so a cancelled draft never becomes a saved pin. */
/** [FLOW-QA2 F26] A Services business is not a shop: it is asked where it is based, never for a store's entrance. */
const PICKER_WORDS = {
  store: {
    title: 'Place your store on the map', lead: 'Put the pin on your store’s entrance.', note: 'Riders and customers will come here.' as string | null,
    search: 'Search for your store’s address', moveTo: 'Move the map to your store', fromDevice: 'Starting where your device is. If you’re not at the store, move the pin.',
    current: 'This is where your store’s pin is now.', searchOrMove: 'Search for your store or move the map.', mapLabel: 'Store location map', chosen: 'Chosen store location',
    addressLabel: 'Store address', pinName: 'Store pin', tilesNote: 'Your store’s entrance can’t be confirmed on it yet.', retry: 'Retry to check your store’s entrance before confirming.', locating: 'suggest a starting point for your store', confirm: 'Confirm store location', zoom: 'Zoom in to find the entrance.',
  },
  service: {
    title: 'Show where you’re based on the map', lead: 'Put the pin where you’re based.', note: null as string | null,
    search: 'Search for your address', moveTo: 'Move the map to where you’re based', fromDevice: 'Starting where your device is. If you’re not there now, move the pin.',
    current: 'This is where your pin is now.', searchOrMove: 'Search for your address or move the map.', mapLabel: 'Location map', chosen: 'Chosen location',
    addressLabel: 'Address', pinName: 'Pin', tilesNote: 'Your location can’t be confirmed on it yet.', retry: 'Retry to check where you’re based before confirming.', locating: 'suggest a starting point on the map', confirm: 'Confirm location', zoom: 'Zoom in to place it exactly.',
  },
} as const;
export type PickerWords = keyof typeof PICKER_WORDS;

export function StoreLocationPicker({ current, address, onConfirm, onClose, words = 'store' }: {
  current: StorePin | null;
  address: string;
  onConfirm: (_pin: StorePin) => void;
  onClose: () => void;
  /** 'service': a Services business, asked where it is based (the sign-up's own words for it). */
  words?: PickerWords;
}) {
  const w = PICKER_WORDS[words];
  const [point, setPoint] = useState<StorePoint>(current ?? STORE_MAP_START);
  const [basis, setBasis] = useState<'current' | 'address' | 'device' | 'market'>(current ? 'current' : 'market');
  const [zoom, setZoom] = useState(current ? 17 : 14);
  const [query, setQuery] = useState(address);
  const [suggestions, setSuggestions] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [named, setNamed] = useState<{ point: StorePoint; line: string | null } | null>(current ? { point: current, line: current.address } : null);
  const [announcement, setAnnouncement] = useState('');
  const [mapFailed, setMapFailed] = useState(false);
  const [loadedTiles, setLoadedTiles] = useState<Set<string>>(() => new Set());
  const [tileAttempt, setTileAttempt] = useState(0);
  const [size, setSize] = useState({ width: 320, height: 320 });
  const map = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; pixel: { x: number; y: number } } | null>(null);
  // Any owner action invalidates a pending suggestion/fix. No late GPS,
  // details or old search response can move the map under the owner's hand.
  const revision = useRef(0);
  const searchRequest = useRef(0);
  const selectedName = useRef(named);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const element = map.current;
    const resize = () => { if (element) setSize({ width: element.clientWidth || 320, height: element.clientHeight || 320 }); };
    resize();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    if (element) observer?.observe(element);
    return () => { mounted.current = false; observer?.disconnect(); };
  }, []);

  async function search(text: string) {
    const ticket = ++revision.current;
    searchRequest.current = ticket;
    setSuggestions([]);
    if (text.trim().length < 3) { setSearching(false); return; }
    setSearching(true); setNotice(null);
    try {
      const results = await pinLookup(placesAutocomplete(`${text.trim().slice(0, 110)}, Guyana`, { lat: STORE_MAP_START.latitude, lng: STORE_MAP_START.longitude }));
      if (!mounted.current || ticket !== revision.current) return;
      setSuggestions(results);
      if (!results.length) setNotice(`We couldn’t find that address on the map. ${w.moveTo}.`);
    } catch {
      if (mounted.current && ticket === revision.current) setNotice(`Address search is unavailable right now. ${w.moveTo}.`);
    } finally { if (mounted.current && searchRequest.current === ticket) setSearching(false); }
  }

  useEffect(() => {
    if (!current) void search(address);
    // Opening address is a snapshot; its form fields are disabled while open.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      const selected = selectedName.current?.point === point ? selectedName.current.line : null;
      // A selected search result already names this exact point. A failed
      // reverse lookup must not erase its label or change a confirmed address.
      const lookup = selected ? Promise.resolve(selected) : storePinAddress(point).catch(() => null);
      void lookup.then((line) => {
        if (!live) return;
        setNamed({ point, line });
        // Announce only once the pin settles, never on each drag frame.
        setAnnouncement(`${line ?? w.pinName}. Latitude ${point.latitude.toFixed(6)}, Longitude ${point.longitude.toFixed(6)}`);
      });
    }, 350);
    return () => { live = false; clearTimeout(timer); };
  }, [point, w.pinName]);

  function move(next: StorePoint) {
    revision.current++;
    setPoint(next);
    setNotice(null);
  }

  async function choose(place: Place) {
    const ticket = ++revision.current;
    try {
      const detail = place.lat != null && place.lng != null ? place : await pinLookup(placeDetails(place.placeId));
      if (!mounted.current || ticket !== revision.current) return;
      if (!Number.isFinite(detail.lat) || !Number.isFinite(detail.lng)) throw new Error('No coordinates');
      const next = { latitude: detail.lat!, longitude: detail.lng! };
      setPoint(next); setBasis('address'); setZoom(17); setSuggestions([]); setNotice(null);
      selectedName.current = { point: next, line: [place.primary, place.secondary].filter(Boolean).join(', ') };
      setNamed(selectedName.current);
      map.current?.focus();
    } catch {
      if (mounted.current && ticket === revision.current) setNotice(`We couldn’t find that address on the map. ${w.moveTo}.`);
    }
  }

  async function locate() {
    const ticket = ++revision.current;
    setLocating(true); setNotice(null);
    try {
      const fix = await currentCoords(w.locating);
      if (!mounted.current || ticket !== revision.current) return;
      const next = { latitude: fix.lat, longitude: fix.lng };
      if (!storePinInMarket(next)) {
        setNotice(`Your location is outside Guyana. ${w.searchOrMove}`);
        return;
      }
      setPoint(next); setBasis('device'); setZoom(17);
    } catch {
      if (mounted.current && ticket === revision.current) setNotice(`Location access is unavailable. ${w.searchOrMove}`);
    } finally { if (mounted.current) setLocating(false); }
  }

  const pixel = mapPixel(point, zoom);
  const left = pixel.x - size.width / 2;
  const top = pixel.y - size.height / 2;
  const tiles = [];
  const count = 2 ** zoom;
  const tileSource = mapTileSource();
  // Only the visible viewport is requested, from the one tile source
  // (lib/map-tiles.ts); the browser caches the rest. No third-party script or
  // offline prefetch; the only key is MapTiler's public browser key. A built
  // site without it has no tiles, so no entrance can be confirmed on this map.
  if (tileSource) {
    for (let y = Math.max(0, Math.floor(top / 256)); y <= Math.min(count - 1, Math.floor((top + size.height) / 256)); y++) {
      for (let x = Math.floor(left / 256); x <= Math.floor((left + size.width) / 256); x++) {
        tiles.push({ key: `${zoom}/${x}/${y}`, src: tileSource.tileUrl(zoom, x, y), x: x * 256 - left, y: y * 256 - top });
      }
    }
  }
  const inMarket = storePinInMarket(point);
  const mapReady = tiles.length > 0 && tiles.every((tile) => loadedTiles.has(tile.src));
  const confirmable = inMarket && mapReady && !mapFailed && (basis !== 'market' || storePinMoved(point));
  const line = named?.point === point ? named.line : null;

  function stopDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <section className={styles['picker']} aria-labelledby="store-map-title">
      <h2 id="store-map-title">{w.title}</h2>
      <p>{w.lead}</p>
      {w.note ? <p className={styles['copy']}>{w.note}</p> : null}
      <div className={styles['search']}>
        <label htmlFor="store-map-search">{w.search}</label>
        <input id="store-map-search" autoFocus value={query} onChange={(event) => { revision.current++; setQuery(event.target.value); setSuggestions([]); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void search(query); } }} />
        <button type="button" className={styles['button']} disabled={searching || query.trim().length < 3} onClick={() => void search(query)}>{searching ? 'Finding the address…' : 'Find address'}</button>
      </div>
      {suggestions.length > 0 && <ul className={styles['results']} aria-label="Address suggestions">{suggestions.map((place) => <li key={place.placeId}><button type="button" className={styles['button']} onClick={() => void choose(place)}>{place.primary}{place.secondary ? `, ${place.secondary}` : ''}</button></li>)}</ul>}
      <button type="button" className={styles['button']} disabled={locating} onClick={() => void locate()}>{locating ? 'Getting your location…' : 'Use my location as a starting point'}</button>
      <p className={styles['copy']}>
        {basis === 'market' ? `Starting in Georgetown. ${w.moveTo}.` : basis === 'device' ? w.fromDevice : basis === 'address' ? 'Starting at the address you typed.' : w.current}
      </p>
      {notice && <p role="status" className={styles['copy']}>{notice}</p>}
      <p id="store-map-help" className={styles['copy']}>Drag the map to place the pin. With the map focused, use arrow keys to nudge it; hold Shift for larger moves. {w.zoom}</p>
      <div ref={map} className={styles['map']} tabIndex={0} role="application" aria-label={w.mapLabel} aria-describedby="store-map-help store-map-readout"
        onKeyDown={(event) => {
          const step = event.shiftKey ? 80 : 12;
          const offset: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
          const delta = offset[event.key];
          if (!delta) return;
          event.preventDefault(); move(pixelPoint(pixel.x + delta[0], pixel.y + delta[1], zoom));
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || drag.current) return;
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          revision.current++;
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, pixel };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start?.id !== event.pointerId) return;
          move(pixelPoint(start.pixel.x - (event.clientX - start.x), start.pixel.y - (event.clientY - start.y), zoom));
        }}
        onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={() => { drag.current = null; }}>
        {tiles.map((tile) => (
          // Raster tiles must retain their exact 256px geometry and browser cache.
          // The MapTiler key is restricted to the site's origins, read from the
          // Referer: the origin only, pinned so a stricter page policy cannot strip it.
          // eslint-disable-next-line @next/next/no-img-element
          <img key={`${tileAttempt}/${tile.key}`} src={tile.src} width={256} height={256} alt="" draggable={false} referrerPolicy="strict-origin-when-cross-origin" className={styles['tile']} style={{ left: tile.x, top: tile.y }} onLoad={() => setLoadedTiles((loaded) => new Set(loaded).add(tile.src))} onError={() => setMapFailed(true)} />
        ))}
        <MapPin className={styles['pin']} aria-hidden="true" fill="currentColor" stroke="white" />
      </div>
      <MapAttribution source={tileSource} className={styles['attribution']} />
      <div className={styles['controls']}>
        <button type="button" className={styles['button']} disabled={zoom >= 19} onClick={() => { revision.current++; setZoom(zoom + 1); }}>Zoom in</button>
        <button type="button" className={styles['button']} disabled={zoom <= 6} onClick={() => { revision.current++; setZoom(zoom - 1); }}>Zoom out</button>
      </div>
      <div id="store-map-readout" role="group" aria-label={w.chosen} className={styles['readout']}>
        <span>{w.addressLabel}: {address}</span>
        <span>{line ?? (named?.point === point ? 'No street name found at this pin.' : 'Finding the address…')}</span>
        <span>Latitude {point.latitude.toFixed(6)}, Longitude {point.longitude.toFixed(6)}</span>
      </div>
      <p role="status" aria-live="polite" aria-atomic="true" className={styles['srOnly']}>{announcement}</p>
      {!inMarket && <p role="alert" className={styles['error']}>{STORE_PIN_OUTSIDE}</p>}
      {!tileSource && <p role="alert" className={styles['error']}>{MAP_TILES_UNAVAILABLE} {w.tilesNote}</p>}
      {tileSource && !mapReady && !mapFailed && <p className={styles['copy']}>Loading map…</p>}
      {mapFailed && <><p role="alert" className={styles['error']}>The map couldn’t load. {w.retry}</p><button type="button" className={styles['button']} onClick={() => { setMapFailed(false); setLoadedTiles(new Set()); setTileAttempt(tileAttempt + 1); }}>Retry map</button></>}
      {basis === 'market' && !storePinMoved(point) && <p className={styles['copy']}>{w.moveTo}</p>}
      <button type="button" className={`${styles['button']} ${styles['confirm']}`} disabled={!confirmable} onClick={() => { if (confirmable) onConfirm({ ...point, address: line }); }}>{w.confirm}</button>
      <button type="button" className={styles['button']} onClick={onClose}>Close without placing the pin</button>
    </section>
  );
}
