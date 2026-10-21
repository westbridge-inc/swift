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

// ── [WEB-TAXI] Trip Guardian on the trip page ──────────────────────────────
// The phone raises its check-in card from the order room AND asks the server
// on arrival (GET /safety/guardian/checkin — the caller's own trip only); the
// page asks on every refresh. Answers go to the same endpoint the phone uses.
export interface GuardianCheckin { sessionId: string; orderId: string; level: 'SOFT' | 'HARD'; requestedAt: string; deadlineAt: string | null }
export async function outstandingCheckin(): Promise<GuardianCheckin | null> {
  return (await apiFetch('/api/v1/safety/guardian/checkin', undefined, { redirectOnExpired: false })).data ?? null;
}
export async function answerCheckin(response: 'OK' | 'NEED_HELP'): Promise<{ escalated: boolean }> {
  return (await apiFetch('/api/v1/safety/guardian/checkin', { method: 'POST', body: JSON.stringify({ response }) })).data;
}

// ── [WEB-TAXI] The phone's other trip-page safety calls ────────────────────
/** [S-16] Mint a live, expiring, revocable link to this trip (the phone's Share trip). */
export async function shareTrip(id: string): Promise<{ token: string; url: string; expiresAt: string }> {
  return (await apiFetch(`/api/v1/safety/trips/${encodeURIComponent(id)}/share`, { method: 'POST', body: '{}' })).data;
}
/** The caller's own live links for this trip (metadata only, never a token). */
export async function tripShares(id: string): Promise<Array<{ id: string; expiresAt: string }>> {
  return (await apiFetch(`/api/v1/safety/trips/${encodeURIComponent(id)}/shares`)).data ?? [];
}
/** Stop every live link for this trip. */
export async function stopTripShares(id: string): Promise<unknown> {
  return (await apiFetch(`/api/v1/safety/trips/${encodeURIComponent(id)}/shares`, { method: 'DELETE' })).data;
}
/** [§7.3] "This isn't my driver": releases the ride to a new driver, locks the driver for review, pages Swift safety. */
export async function reportNotMyDriver(id: string): Promise<unknown> {
  return (await apiFetch(`/api/v1/safety/rides/${encodeURIComponent(id)}/not-my-driver`, { method: 'POST', body: '{}' })).data;
}
