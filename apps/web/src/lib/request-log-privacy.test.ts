import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import { logRequests } from 'next/dist/server/dev/log-requests';
import { afterEach, describe, expect, it, vi } from 'vitest';

// [M013] The website's development server prints every request target and
// upstream fetch warning. Targets carry share and tracking tokens in the path
// (/trip/<token>, /track/<token>), payment replies (/pay/mmg/...) and signed
// upstream URLs, so the site turns Next's request logger off. These tests run
// Next's OWN logger the way its dev server does. All values are synthetic.

const PRIVATE_TARGETS = [
  '/trip/synthetic-trip-grant',
  '/track/synthetic-parcel-grant',
  '/pay/mmg/return?token=synthetic-payment-grant',
  '/login?next=/trip/synthetic-next-grant',
  '/missing/synthetic-path?code=synthetic-code-grant',
];

type LoggingConfig = NextConfig['logging'];

/** Next's dev server (next-dev-server.js) calls logRequests only when
 *  `nextConfig.logging !== false`; this mirrors that gate, pinned below. */
function devServerLog(logging: LoggingConfig, url: string, fetchUrl?: string): string {
  let output = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output += String(chunk); return true; });
  try {
    if (logging !== false) {
      logRequests({
        request: {
          url, method: 'GET',
          fetchMetrics: fetchUrl ? [{ url: fetchUrl, method: 'GET', status: 500, start: 0, end: 1, cacheStatus: 'skip', cacheReason: 'synthetic', cacheWarning: 'synthetic warning', idx: 0 }] : [],
        },
        response: { statusCode: 200 }, loggingConfig: logging, requestDurationInMs: 1,
      } as unknown as Parameters<typeof logRequests>[0]);
    }
  } finally { write.mockRestore(); }
  return output;
}

async function siteLogging(): Promise<LoggingConfig> {
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://localhost:3000');
  vi.resetModules();
  const { default: createNextConfig } = await import('../../next.config');
  return createNextConfig(PHASE_DEVELOPMENT_SERVER).logging;
}

afterEach(() => vi.unstubAllEnvs());

describe('[M013] web request log privacy', () => {
  it('the installed Next gates its whole request and fetch logger on logging !== false', () => {
    const require = createRequire(import.meta.url);
    const devServer = readFileSync(require.resolve('next/dist/server/dev/next-dev-server.js'), 'utf8');
    expect(devServer).toMatch(/if \(loggingConfig !== false\) \{[\s\S]{0,1200}logRequests\)\(/);
  });

  it('control: with a request logger on, Next prints a private target (the sensor sees output)', () => {
    const output = devServerLog({ incomingRequests: { ignore: [/^\/pay\/mmg\//] } }, '/trip/synthetic-control-grant');
    expect(output).toContain('synthetic-control-grant');
  });

  it.each(PRIVATE_TARGETS)('the site config prints nothing for %s', async (url) => {
    const output = devServerLog(await siteLogging(), url);
    expect(output).not.toContain('synthetic');
  });

  it('a failed upstream fetch with a signed URL is not printed either', async () => {
    const output = devServerLog(await siteLogging(), '/pay/mmg/return', 'https://api.example.invalid/render/synthetic-upstream-grant?sig=synthetic-signature');
    expect(output).not.toContain('synthetic-upstream-grant');
    expect(output).not.toContain('synthetic-signature');
  });
});
