import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import { useQuery } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { Providers } from '@/app/providers';
import { fetchConfig } from '@/lib/api';
import { retryUnlessRefused } from './query-retry';
import { mockApi } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S3-1] A refusal is an answer, not a hiccup.
//
// React Query retried every failed read three times: an ADMIN on a founder page,
// or a narrowed operator on most pages, watched ~7 s of "Loading…" before
// "You don't have permission". A 4xx is final at once; a network failure or a
// 5xx is still tried again (three times, as before).
// ---------------------------------------------------------------------------

const err = (status?: number) => Object.assign(new Error('x'), status === undefined ? {} : { status });

describe('[ADMIN-AUDIT S3-1] the retry rule', () => {
  it('never retries a 4xx', () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) expect(retryUnlessRefused(0, err(status)), String(status)).toBe(false);
  });
  it('retries a 5xx or a network failure, three times', () => {
    for (const e of [err(500), err(503), err(), new TypeError('Failed to fetch')]) {
      expect(retryUnlessRefused(0, e)).toBe(true);
      expect(retryUnlessRefused(2, e)).toBe(true);
      expect(retryUnlessRefused(3, e)).toBe(false);
    }
  });
});

function Probe() {
  const q = useQuery({ queryKey: ['probe-config'], queryFn: fetchConfig });
  return <p>{q.isError ? 'refused' : q.isLoading ? 'Loading…' : 'loaded'}</p>;
}

describe('[ADMIN-AUDIT S3-1] the console\'s own query client', () => {
  it('a 403 read is shown at once, asked once', async () => {
    const fetch = mockApi(() => ({ status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'Founder only' } } }));
    const t0 = Date.now();
    render(<Providers><Probe /></Providers>);
    expect(await screen.findByText('refused', {}, { timeout: 900 })).toBeTruthy();
    expect(Date.now() - t0).toBeLessThan(900);
    expect(fetch.mock.calls.length).toBe(1);
  });
  it('a 503 read is tried again', async () => {
    const fetch = mockApi(() => ({ status: 503, body: { success: false, error: { code: 'DOWN', message: 'unavailable' } } }));
    render(<Providers><Probe /></Providers>);
    await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 2500 });
    expect(screen.getByText('Loading…')).toBeTruthy();
  });
});

describe('[ADMIN-AUDIT S3-3] a wide table scrolls sideways inside its card', () => {
  it('.mc-table-wrap scrolls on x and never hides overflow outright (it beat Tailwind\'s overflow-x-auto)', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'app', 'globals.css'), 'utf8');
    const rule = css.match(/\.mc-table-wrap\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/overflow-x:\s*auto/);
    expect(rule).not.toMatch(/(^|;|\s)overflow:\s*hidden/);
  });
});
