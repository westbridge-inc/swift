import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVELOPMENT_BROWSER_API_ORIGIN, RELEASE_UPSTREAM_API_ORIGIN } from './browser-api-origin';

const mutableEnv = process.env as Record<string, string | undefined>;
const originalNodeEnv = mutableEnv['NODE_ENV'];
const originalApiUrl = mutableEnv['API_URL'];

function restoreServerEnv(): void {
  if (originalNodeEnv === undefined) delete mutableEnv['NODE_ENV'];
  else mutableEnv['NODE_ENV'] = originalNodeEnv;
  if (originalApiUrl === undefined) delete mutableEnv['API_URL'];
  else mutableEnv['API_URL'] = originalApiUrl;
}

afterEach(() => {
  restoreServerEnv();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('server API fetch origin', () => {
  it('executes development fetches against localhost and production fetches against only the canonical upstream', async () => {
    const cases = [
      { nodeEnv: 'development', apiUrl: undefined, expectedOrigin: DEVELOPMENT_BROWSER_API_ORIGIN },
      { nodeEnv: 'production', apiUrl: RELEASE_UPSTREAM_API_ORIGIN, expectedOrigin: RELEASE_UPSTREAM_API_ORIGIN },
    ] as const;

    for (const scenario of cases) {
      mutableEnv['NODE_ENV'] = scenario.nodeEnv;
      if (scenario.apiUrl === undefined) delete mutableEnv['API_URL'];
      else mutableEnv['API_URL'] = scenario.apiUrl;
      vi.resetModules();
      const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ data: { currencyCode: 'GYD' } }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const api = await import('./api');

      await api.fetchPricing('GY');
      expect(api.resolveServerApiOrigin()).toBe(scenario.expectedOrigin);
      expect(String(fetchMock.mock.calls[0]![0])).toBe(`${scenario.expectedOrigin}/api/v1/auth/pricing?country=GY`);
    }
  });

  it('refuses an absent production upstream before a server fetch can fall back to localhost or the public site', async () => {
    mutableEnv['NODE_ENV'] = 'production';
    delete mutableEnv['API_URL'];
    await expect(import('./api')).rejects.toThrow(/API_URL is required/);
  });
});
