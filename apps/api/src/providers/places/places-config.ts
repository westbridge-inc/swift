import { isProduction } from '../../utils/runtime-mode';

/** Local saved addresses and zones are useful in development, but are not
 * a production address-search service. No local-only launch exception exists. */
export function assertPlacesConfig(env: Record<string, string | undefined> = process.env): void {
  if (!isProduction(env)) return;
  const provider = env['PLACES_PROVIDER'];
  if (provider !== 'osm' && provider !== 'google') {
    throw new Error('PLACES_PROVIDER must explicitly select osm or google in production; local-only address lookup is unavailable.');
  }
  if (provider === 'osm' && !env['PHOTON_URL']?.trim()) {
    throw new Error('PHOTON_URL is required when PLACES_PROVIDER=osm.');
  }
  if (provider === 'google' && !env['GOOGLE_MAPS_API_KEY_BACKEND']?.trim()) {
    throw new Error('GOOGLE_MAPS_API_KEY_BACKEND is required when PLACES_PROVIDER=google.');
  }
}
