'use client';

// [PERF · web shared bundle] Ride calls, moved verbatim from lib/customer.ts;
// the order page (a ride's own status) and the Taxi page's fare estimate use them.
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

// ── [Row 117] Web taxi booking — used only while the server says it is on ────
// (GET /rides/capabilities answers webBooking:true to a browser session only
// while WEB_TAXI_BOOKING is on; the server refuses every web ride request
// otherwise, whatever this code does).
export interface RideCapabilities { maxStops?: number; webBooking?: boolean }
export async function rideCapabilities(): Promise<RideCapabilities> {
  return (await apiFetch('/api/v1/rides/capabilities', undefined, { redirectOnExpired: false })).data ?? {};
}
export interface WebRideRequest {
  pickup: { lat: number; lng: number };
  dropoff: { lat: number; lng: number };
  pickupAddress: string;
  dropoffAddress: string;
  passengerCount: 1;
  rideClass: string;
  /** The fare the customer was shown: the server books only at it (409 FARE_CHANGED otherwise). */
  expectedFare: number;
}
/** One booking intent, one key: a retry under the same key is answered with the first answer and never books twice. */
export async function requestRide(body: WebRideRequest, idempotencyKey: string): Promise<any> {
  return (await apiFetch('/api/v1/rides/request', { method: 'POST', body: JSON.stringify(body), headers: { 'Idempotency-Key': idempotencyKey } })).data;
}
/** The in-ride panic button: pages Swift's safety team (the server's one SOS engine). */
export async function rideSos(id: string, point: { lat: number; lng: number } | null): Promise<{ status?: string; sosAlertId?: string }> {
  return (await apiFetch(`/api/v1/rides/${encodeURIComponent(id)}/sos`, { method: 'POST', body: JSON.stringify(point ?? {}) })).data;
}
