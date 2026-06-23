import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { placesApi, type PlaceSuggestion } from '../services/api';

type Point = { lat: number; lng: number };

async function unwrap<T = any>(p: Promise<any>): Promise<T> {
  const r = await p;
  return r?.data?.data as T;
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
  return useQuery<PlaceSuggestion[]>({
    queryKey: ['places', 'autocomplete', q, near?.lat, near?.lng],
    queryFn: () => unwrap<PlaceSuggestion[]>(placesApi.autocomplete(q, near)),
    enabled,
    staleTime: 60_000,
  });
}

export function usePlaceDetails() {
  return (placeId: string) => unwrap<import('../services/api').PlaceDetail | null>(placesApi.details(placeId));
}
