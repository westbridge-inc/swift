'use client';

// [PERF · web shared bundle] Ride calls, moved verbatim from lib/customer.ts;
// only the order page (a ride's own status) uses them.
import { apiFetch } from './auth';

export async function rideAvailability(lat: number, lng: number): Promise<{ level: 'GOOD' | 'LOW' | 'NONE'; nearestEtaMinutes?: number | null; gate?: boolean }> {
  return (await apiFetch(`/api/v1/rides/availability?lat=${lat}&lng=${lng}`)).data;
}
export async function rideEstimate(body: { pickup: { lat: number; lng: number }; dropoff: { lat: number; lng: number } }) {
  return (await apiFetch('/api/v1/rides/estimate', { method: 'POST', body: JSON.stringify(body) })).data;
}
export async function activeRide(): Promise<any> { return (await apiFetch('/api/v1/rides/active')).data; }
export async function getRide(id: string): Promise<any> { return (await apiFetch(`/api/v1/rides/${encodeURIComponent(id)}`)).data; }
export async function watchRide(body: { lat: number; lng: number }) {
  return apiFetch('/api/v1/rides/availability/watch', { method: 'POST', body: JSON.stringify(body) });
}
