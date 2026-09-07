import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { placesApi, type PlaceSuggestion } from '../services/api';

type Point = { lat: number; lng: number };

async function unwrap<T = any>(p: Promise<any>): Promise<T> {
  const r = await p;
  return r?.data?.data as T;
}

/**
 * [LIC-002 · PROV-003] Who must be credited for these suggestions.
 *
 * OpenStreetMap's ODbL requires a visible credit wherever results derived from
 * its data are shown, and Google's Places terms require the Google mark. Which
 * one applies is SERVER configuration, so the server states it with every
 * response and the screen renders what it is told. A hardcoded credit would
 * become a lie the day `PLACES_PROVIDER` changed.
 */
export interface PlacesAttribution {
  text: string;
  url?: string;
  source: 'osm' | 'google' | 'swift';
}

async function unwrapWithAttribution<T>(p: Promise<any>): Promise<{ items: T; attribution: PlacesAttribution | null }> {
  const r = await p;
  return { items: r?.data?.data as T, attribution: (r?.data?.attribution ?? null) as PlacesAttribution | null };
}

/** Debounce a fast-changing value so we don't fire a request per keystroke. */
function useDebounced<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/**
 * Destination suggestions for the "Where to?" search. Debounced + React Query
 * cached; only queries once the term is meaningful (>= 2 chars). `near` biases
 * results toward the user's current location.
 */
export function usePlacesAutocomplete(query: string, near?: Point) {
  const q = useDebounced(query.trim());
  const enabled = q.length >= 2;
  return useQuery<{ items: PlaceSuggestion[]; attribution: PlacesAttribution | null }>({
    queryKey: ['places', 'autocomplete', q, near?.lat, near?.lng],
    queryFn: () => unwrapWithAttribution<PlaceSuggestion[]>(placesApi.autocomplete(q, near)),
    enabled,
    staleTime: 60_000,
  });
}

export function usePlaceDetails() {
  return (placeId: string) => unwrap<import('../services/api').PlaceDetail | null>(placesApi.details(placeId));
}
