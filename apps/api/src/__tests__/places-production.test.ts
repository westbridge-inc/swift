import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPlacesProvider } from '../providers/places/places-provider';
afterEach(() => vi.unstubAllEnvs());
describe('places provider configuration', () => {
  it.each([undefined, 'local'])('production factory refuses local-only choice %s', (provider) => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('PLACES_PROVIDER', provider);
    expect(() => getPlacesProvider({} as never)).toThrow(/PLACES_PROVIDER/);
  });
  it.each(['test', 'development'])('%s keeps the key-free local provider', (mode) => {
    vi.stubEnv('NODE_ENV', mode); vi.stubEnv('PLACES_PROVIDER', undefined);
    expect(() => getPlacesProvider({} as never)).not.toThrow();
  });
});
