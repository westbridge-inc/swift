import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [ADMIN-CONSOLE] The console is served on the internet (deploy/Caddyfile,
// ADMIN_HOST). The proxy adds no headers of its own (the Caddyfile contract),
// so every protective header comes from this config, on every path. And the
// self-hosted image (apps/admin/Dockerfile, SWIFT_ADMIN_IMAGE_BUILD=1) is the
// standalone server, built only for an https API origin.
// ---------------------------------------------------------------------------

type HeaderRule = { source: string; headers: { key: string; value: string }[] };

async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return (await import('../next.config')).default;
}

async function headerRules(env: Record<string, string | undefined> = {}): Promise<HeaderRule[]> {
  const config = await loadConfig({ NEXT_PUBLIC_API_URL: 'https://api-staging.example.com', ...env });
  return (await config.headers!()) as HeaderRule[];
}

function headersOf(rule: HeaderRule | undefined): Record<string, string> {
  return Object.fromEntries((rule?.headers ?? []).map((h) => [h.key, h.value]));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('[ADMIN-CONSOLE] every response of the internet-facing console protects itself', () => {
  it('is never indexed, never framed, sends no referrer and pins HTTPS, on every path', async () => {
    const rules = await headerRules();
    const all = headersOf(rules.find((rule) => rule.source === '/:path*'));
    expect(all['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(all['Referrer-Policy']).toBe('no-referrer');
    expect(all['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(all['X-Frame-Options']).toBe('DENY');
    const hsts = /max-age=(\d+)/.exec(all['Strict-Transport-Security'] ?? '');
    expect(Number(hsts?.[1])).toBeGreaterThanOrEqual(31_536_000);
  });

  it('the document render path changes only its CSP, never the rest', async () => {
    const rules = await headerRules();
    const render = rules.filter((rule) => rule.source !== '/:path*');
    expect(render.map((rule) => rule.source)).toEqual(['/api/v1/verification/render/:path*']);
    expect(Object.keys(headersOf(render[0]))).toEqual(['Content-Security-Policy']);
    expect(headersOf(render[0])['Content-Security-Policy']).toContain("frame-ancestors 'none'");
  });

  it('does not announce its framework', async () => {
    const config = await loadConfig({ NEXT_PUBLIC_API_URL: 'https://api-staging.example.com' });
    expect(config.poweredByHeader).toBe(false);
  });
});

describe('[ADMIN-CONSOLE] the self-hosted image', () => {
  it('is the standalone server when built for an https API origin', async () => {
    for (const origin of ['https://api-staging.example.com', 'https://localhost']) {
      const config = await loadConfig({ SWIFT_ADMIN_IMAGE_BUILD: '1', NEXT_PUBLIC_API_URL: origin });
      expect(config.output).toBe('standalone');
    }
  });

  it('refuses to build without an https API origin to call', async () => {
    for (const origin of [undefined, '', 'http://api-staging.example.com', 'http://localhost:3000',
      'https://api-staging.example.com/', 'https://api-staging.example.com/api', 'api-staging.example.com']) {
      await expect(loadConfig({ SWIFT_ADMIN_IMAGE_BUILD: '1', NEXT_PUBLIC_API_URL: origin }), String(origin))
        .rejects.toThrow(/NEXT_PUBLIC_API_URL/);
    }
  });

  it('leaves every other build (CI, development, Vercel) exactly as it was', async () => {
    const config = await loadConfig({ SWIFT_ADMIN_IMAGE_BUILD: undefined, NEXT_PUBLIC_API_URL: undefined });
    expect(config.output).toBeUndefined();
    expect(config.typescript?.ignoreBuildErrors).toBeUndefined();
    expect(config.eslint?.ignoreDuringBuilds).toBeUndefined();
  });
});
