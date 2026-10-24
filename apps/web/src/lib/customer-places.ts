'use client';

// [PERF · web shared bundle] Place search and place details, moved verbatim from
// lib/customer.ts. Only the place box and the map pickers use them, and those
// load on demand on the shopping pages, so the pages' shared customer client
// does not carry them.
import { apiFetch } from './auth';

// ── Places (taxi pickup/dropoff search) ─────────────────────────────────────
export interface Place { placeId: string; primary: string; secondary?: string; label?: string; lat?: number; lng?: number; }
export async function placesAutocomplete(q: string, near?: { lat: number; lng: number }): Promise<Place[]> {
  const qs = new URLSearchParams({ q, ...(near ? { lat: String(near.lat), lng: String(near.lng) } : {}) });
  return (await apiFetch(`/api/v1/places/autocomplete?${qs}`)).data as Place[];
}
export async function placeDetails(placeId: string): Promise<{ lat: number; lng: number; label: string }> {
  return (await apiFetch(`/api/v1/places/details?placeId=${encodeURIComponent(placeId)}`)).data;
}
