'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { MapPin } from 'lucide-react';
import { placesAutocomplete, placeDetails, type Place } from '@/lib/customer';
import { currentCoords } from '@/lib/geolocate';
import {
  STORE_MAP_START, STORE_PIN_OUTSIDE, mapPixel, pixelPoint, pinLookup,
  storePinAddress, storePinInMarket, storePinMoved, type StorePin, type StorePoint,
} from '@/lib/store-pin';
import styles from './store-location-picker.module.css';

/** A fixed entrance pin: drag the street map beneath it, as on the phone.
 * Search and GPS only suggest a start; only the confirm button returns a pin.
 * Remounted on every open so a cancelled draft never becomes a saved pin. */
export function StoreLocationPicker({ current, address, onConfirm, onClose }: {
  current: StorePin | null;
  address: string;
  onConfirm: (_pin: StorePin) => void;
  onClose: () => void;
}) {
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
    if (text.trim().length < 3) return;
    setSearching(true); setNotice(null);
    try {
      const results = await pinLookup(placesAutocomplete(`${text.trim().slice(0, 110)}, Guyana`, { lat: STORE_MAP_START.latitude, lng: STORE_MAP_START.longitude }));
      if (!mounted.current || ticket !== revision.current) return;
      setSuggestions(results);
      if (!results.length) setNotice('We couldn’t find that address on the map. Move the map to your store.');
    } catch {
      if (mounted.current && ticket === revision.current) setNotice('Address search is unavailable right now. Move the map to your store.');
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
        setAnnouncement(`${line ?? 'Store pin'}. Latitude ${point.latitude.toFixed(6)}, Longitude ${point.longitude.toFixed(6)}`);
      });
    }, 350);
    return () => { live = false; clearTimeout(timer); };
  }, [point]);

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
      if (mounted.current && ticket === revision.current) setNotice('We couldn’t find that address on the map. Move the map to your store.');
    }
  }

  async function locate() {
    const ticket = ++revision.current;
    setLocating(true); setNotice(null);
    try {
      const fix = await currentCoords('suggest a starting point for your store');
      if (!mounted.current || ticket !== revision.current) return;
      const next = { latitude: fix.lat, longitude: fix.lng };
      if (!storePinInMarket(next)) {
        setNotice('Your location is outside Guyana. Search for your store or move the map.');
        return;
      }
      setPoint(next); setBasis('device'); setZoom(17);
    } catch {
      if (mounted.current && ticket === revision.current) setNotice('Location access is unavailable. Search for your store or move the map.');
    } finally { if (mounted.current) setLocating(false); }
  }

  const pixel = mapPixel(point, zoom);
  const left = pixel.x - size.width / 2;
  const top = pixel.y - size.height / 2;
  const tiles = [];
  const count = 2 ** zoom;
  // Only the visible viewport is requested; browser caching and referrers
  // follow the OSM tile policy. No third-party script, key or offline prefetch.
  for (let y = Math.max(0, Math.floor(top / 256)); y <= Math.min(count - 1, Math.floor((top + size.height) / 256)); y++) {
    for (let x = Math.floor(left / 256); x <= Math.floor((left + size.width) / 256); x++) {
      const tileX = ((x % count) + count) % count;
      tiles.push({ key: `${zoom}/${x}/${y}`, src: `https://tile.openstreetmap.org/${zoom}/${tileX}/${y}.png`, x: x * 256 - left, y: y * 256 - top });
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
      <h2 id="store-map-title">Place your store on the map</h2>
      <p>Put the pin on your store’s entrance.</p>
      <p className={styles['copy']}>Riders and customers will come here.</p>
      <div className={styles['search']}>
        <label htmlFor="store-map-search">Search for your store’s address</label>
        <input id="store-map-search" autoFocus value={query} onChange={(event) => { revision.current++; setQuery(event.target.value); setSuggestions([]); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void search(query); } }} />
        <button type="button" className={styles['button']} disabled={searching || query.trim().length < 3} onClick={() => void search(query)}>{searching ? 'Finding the address…' : 'Find address'}</button>
      </div>
      {suggestions.length > 0 && <ul className={styles['results']} aria-label="Address suggestions">{suggestions.map((place) => <li key={place.placeId}><button type="button" className={styles['button']} onClick={() => void choose(place)}>{place.primary}{place.secondary ? `, ${place.secondary}` : ''}</button></li>)}</ul>}
      <button type="button" className={styles['button']} disabled={locating} onClick={() => void locate()}>{locating ? 'Getting your location…' : 'Use my location as a starting point'}</button>
      <p className={styles['copy']}>
        {basis === 'market' ? 'Starting in Georgetown. Move the map to your store.' : basis === 'device' ? 'Starting where your device is. If you’re not at the store, move the pin.' : basis === 'address' ? 'Starting at the address you typed.' : 'This is where your store’s pin is now.'}
      </p>
      {notice && <p role="status" className={styles['copy']}>{notice}</p>}
      <p id="store-map-help" className={styles['copy']}>Drag the map to place the pin. With the map focused, use arrow keys to nudge it; hold Shift for larger moves. Zoom in to find the entrance.</p>
      <div ref={map} className={styles['map']} tabIndex={0} role="application" aria-label="Store location map" aria-describedby="store-map-help store-map-readout"
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
          // eslint-disable-next-line @next/next/no-img-element
          <img key={`${tileAttempt}/${tile.key}`} src={tile.src} width={256} height={256} alt="" draggable={false} className={styles['tile']} style={{ left: tile.x, top: tile.y }} onLoad={() => setLoadedTiles((loaded) => new Set(loaded).add(tile.src))} onError={() => setMapFailed(true)} />
        ))}
        <MapPin className={styles['pin']} aria-hidden="true" fill="currentColor" stroke="white" />
      </div>
      <p className={styles['attribution']}>© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a></p>
      <div className={styles['controls']}>
        <button type="button" className={styles['button']} disabled={zoom >= 19} onClick={() => { revision.current++; setZoom(zoom + 1); }}>Zoom in</button>
        <button type="button" className={styles['button']} disabled={zoom <= 6} onClick={() => { revision.current++; setZoom(zoom - 1); }}>Zoom out</button>
      </div>
      <div id="store-map-readout" role="group" aria-label="Chosen store location" className={styles['readout']}>
        <span>Store address: {address}</span>
        <span>{line ?? (named?.point === point ? 'No street name found at this pin.' : 'Finding the address…')}</span>
        <span>Latitude {point.latitude.toFixed(6)}, Longitude {point.longitude.toFixed(6)}</span>
      </div>
      <p role="status" aria-live="polite" aria-atomic="true" className={styles['srOnly']}>{announcement}</p>
      {!inMarket && <p role="alert" className={styles['error']}>{STORE_PIN_OUTSIDE}</p>}
      {!mapReady && !mapFailed && <p role="status" className={styles['copy']}>Loading map…</p>}
      {mapFailed && <><p role="alert" className={styles['error']}>The map couldn’t load. Retry to check your store’s entrance before confirming.</p><button type="button" className={styles['button']} onClick={() => { setMapFailed(false); setLoadedTiles(new Set()); setTileAttempt(tileAttempt + 1); }}>Retry map</button></>}
      {basis === 'market' && !storePinMoved(point) && <p className={styles['copy']}>Move the map to your store</p>}
      <button type="button" className={`${styles['button']} ${styles['confirm']}`} disabled={!confirmable} onClick={() => { if (confirmable) onConfirm({ ...point, address: line }); }}>Confirm store location</button>
      <button type="button" className={styles['button']} onClick={onClose}>Close without placing the pin</button>
    </section>
  );
}
