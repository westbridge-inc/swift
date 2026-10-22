// SCAFFOLD (red-first): shells only, no behaviour yet.
import type { PlacesFailure, PlacesOp } from './places-failure';

export const PLACES_ALERT_FAILURES = 5;
export const PLACES_ALERT_WINDOW_MS = 10 * 60_000;
export const PLACES_PAGE_RETRY_MS = 5 * 60_000;
export const PLACES_PAGE_WINDOW_SECONDS = 3600;
export const PLACES_PAGE_TITLE = 'Address search is failing';
export const PLACES_PAGE_KEY = 'ops_page:places-failing';

export type PlacesStatus = 'unknown' | 'ok' | 'failing';
export interface PlacesReadiness { provider: string; status: PlacesStatus; since: string | null }

export class PlacesHealth {
  constructor(private readonly now: () => number = Date.now) {}
  recordOk(): { resolve: boolean } { void this.now; return { resolve: false }; }
  recordFailure(_op: PlacesOp, _failure: PlacesFailure): { page: boolean; failuresInWindow: number } { return { page: false, failuresInWindow: 0 }; }
  readiness(provider: string): PlacesReadiness { return { provider, status: 'unknown', since: null }; }
  detail(provider: string): Record<string, unknown> { return { provider }; }
}

let shared: PlacesHealth | undefined;
export function getPlacesHealth(): PlacesHealth { return (shared ??= new PlacesHealth()); }
export function resetPlacesHealthForTests(): void { shared = undefined; }
export function placesProviderName(env: Record<string, string | undefined> = process.env): string {
  return env['PLACES_PROVIDER'] ?? 'local';
}

export interface PlacesPageInput { key: string; windowSeconds: number; title: string; body: string; data: Record<string, unknown> }
export interface PlacesPager { page(input: PlacesPageInput): Promise<unknown>; resolve(): Promise<unknown> }
export type PlacesCallResult<T> = { ok: true; value: T } | { ok: false; failure: PlacesFailure };
export interface PlacesObserver { provider: string; health: PlacesHealth; pager: PlacesPager; log: { error: (obj: object, msg: string) => void } }

export async function observePlacesCall<T>(
  _ctx: PlacesObserver,
  _op: PlacesOp,
  _meta: { queryLength?: number },
  call: () => Promise<T>,
  _isEmpty: (value: T) => boolean,
): Promise<PlacesCallResult<T>> {
  return { ok: true, value: await call() };
}
