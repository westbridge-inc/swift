import { describePlacesFailure, PlacesProviderError } from './places-failure';
import { GooglePlacesProvider, type PlacesProvider } from './places-provider';

// ---------------------------------------------------------------------------
// [PLACES-LOUD 22 Oct 2026] The launch smoke for address search.
//
// Production address search had never been called live with the real key.
// This runs three real calls, inside the production API container, at the
// launch deploy (deploy/PILOT-RUNBOOK.md section 12, "The first boot"):
//   1. autocomplete "Giftland", restricted to Guyana (the provider's own
//      includedRegionCodes), must return at least one place;
//   2. place details for the first suggestion must return a point in Guyana;
//   3. one reverse geocode of a public landmark must return an address.
// It prints PASS/FAIL per call with Google's status words only (never the
// key, never a place name, an address or Google's free-text message), and
// exits 0 only when all three pass. The compiled entrypoint is
// dist/scripts/places-smoke.js (src/scripts/places-smoke.ts).
// ---------------------------------------------------------------------------

export const SMOKE_QUERY = 'Giftland';
/** Stabroek Market, Georgetown: a public landmark. */
export const SMOKE_REVERSE_POINT = { lat: 6.8065, lng: -58.1626 };
/** Guyana's bounding box, generously: a details point outside it means the region restriction failed. */
const GUYANA = { minLat: 1, maxLat: 9, minLng: -62, maxLng: -56 };

export type PlacesSmokeCall = 'autocomplete' | 'details' | 'reverse';
export interface PlacesSmokeLine { call: PlacesSmokeCall; pass: boolean; detail: string }
export interface PlacesSmokeResult { pass: boolean; lines: PlacesSmokeLine[] }

function failureText(err: unknown): string {
  return err instanceof PlacesProviderError ? describePlacesFailure(err.failure) : 'unexpected error (no detail printed)';
}

export async function runPlacesSmoke(provider: PlacesProvider): Promise<PlacesSmokeResult> {
  const lines: PlacesSmokeLine[] = [];
  let firstPlaceId: string | undefined;

  try {
    const suggestions = await provider.autocomplete(SMOKE_QUERY);
    firstPlaceId = suggestions[0]?.placeId;
    lines.push(firstPlaceId
      ? { call: 'autocomplete', pass: true, detail: `${suggestions.length} suggestion(s) in Guyana` }
      : { call: 'autocomplete', pass: false, detail: 'Google answered with no place for the probe' });
  } catch (err) {
    lines.push({ call: 'autocomplete', pass: false, detail: failureText(err) });
  }

  if (!firstPlaceId) {
    lines.push({ call: 'details', pass: false, detail: 'not run: autocomplete gave no place id' });
  } else {
    try {
      const detail = await provider.details(firstPlaceId);
      if (!detail) {
        lines.push({ call: 'details', pass: false, detail: 'Google answered with no place for that id' });
      } else if (!(detail.lat >= GUYANA.minLat && detail.lat <= GUYANA.maxLat && detail.lng >= GUYANA.minLng && detail.lng <= GUYANA.maxLng)) {
        lines.push({ call: 'details', pass: false, detail: 'the place is outside Guyana' });
      } else {
        lines.push({ call: 'details', pass: true, detail: 'a point in Guyana' });
      }
    } catch (err) {
      lines.push({ call: 'details', pass: false, detail: failureText(err) });
    }
  }

  try {
    const address = await provider.reverseGeocode(SMOKE_REVERSE_POINT);
    lines.push(typeof address === 'string' && address.trim()
      ? { call: 'reverse', pass: true, detail: 'an address for the landmark' }
      : { call: 'reverse', pass: false, detail: 'Google answered with no address for the landmark' });
  } catch (err) {
    lines.push({ call: 'reverse', pass: false, detail: failureText(err) });
  }

  return { pass: lines.every((l) => l.pass), lines };
}

export function formatPlacesSmoke(result: PlacesSmokeResult): string[] {
  const out = result.lines.map((l) => `${l.pass ? 'PASS' : 'FAIL'} places ${l.call}: ${l.detail}`);
  const failed = result.lines.filter((l) => !l.pass).length;
  out.push(result.pass ? 'PLACES SMOKE PASS' : `PLACES SMOKE FAIL (${failed} of ${result.lines.length} calls failed)`);
  return out;
}

/** The command: 0 = all three passed, 1 = a call failed, 2 = not configured for Google here. */
export async function placesSmokeMain(
  env: Record<string, string | undefined>,
  print: (line: string) => void,
): Promise<number> {
  if (env['PLACES_PROVIDER'] !== 'google') {
    const named = ['local', 'osm'].includes(env['PLACES_PROVIDER'] ?? '') ? env['PLACES_PROVIDER'] : 'unset or unknown';
    print(`FAIL places smoke: PLACES_PROVIDER is ${named} in this container, not google`);
    return 2;
  }
  const key = env['GOOGLE_MAPS_API_KEY_BACKEND']?.trim();
  if (!key) {
    print('FAIL places smoke: GOOGLE_MAPS_API_KEY_BACKEND is not set in this container (GOOGLE_MAPS_API_KEY_BACKEND_FILE from the store)');
    return 2;
  }
  const result = await runPlacesSmoke(new GooglePlacesProvider(key));
  for (const line of formatPlacesSmoke(result)) print(line);
  return result.pass ? 0 : 1;
}
