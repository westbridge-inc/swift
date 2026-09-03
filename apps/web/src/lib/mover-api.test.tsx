import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataUnavailable } from '@/components/data-unavailable';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_ORIGIN, mockApi } from '@/test/test-utils';
import { getRiderCashSettlements, getRiderProfile, getRiderSubscription, getRiderSummary } from './mover-api';

// ---------------------------------------------------------------------------
// [W-10] S0 operational/money truth. The mover portal is where a rider or
// driver checks what they earned, what they owe, and what documents they still
// need. Every one of those reads went through:
//
//     const soft = (p) => p.then((r) => r.data).catch(() => null);
//
// so a 500, an offline phone, an expired session or a schema change was
// indistinguishable from "no debt", "no earnings" and "no store owes you
// anything" — and, worst of all, from "no earner profile on this account",
// which told a working mover they were not a driver.
//
// Absence is a fact the SERVER states, and it states it precisely: 404 when the
// profile does not exist, 403 when the account is not a mover. Those are
// knowledge. Everything else is ignorance, and must surface as an error.
// ---------------------------------------------------------------------------

const TOKEN_KEY = 'swift_web_token';

beforeEach(() => {
  // apiFetch attaches a bearer token; without one these reads never leave.
  localStorage.setItem(TOKEN_KEY, 'test-token');
});
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

/** Reply to every request with one status/body. */
function always(status: number, body: unknown) {
  return mockApi(() => ({ status, body }));
}

describe('[W-10] the server states absence; everything else is ignorance', () => {
  it('404 means the profile really does not exist', async () => {
    always(404, { success: false, error: { code: 'NOT_FOUND', message: 'Rider not found' } });
    await expect(getRiderProfile()).resolves.toBeNull();
  });

  it('403 means this account is not a mover — also a fact', async () => {
    always(403, { success: false, error: { code: 'FORBIDDEN', message: 'This account cannot access this resource' } });
    await expect(getRiderProfile()).resolves.toBeNull();
  });

  it.each([500, 502, 503, 400, 409])('%i is NOT absence — it reaches the page as an error', async (status) => {
    always(status, { success: false, error: { code: 'ERR', message: 'boom' } });
    await expect(getRiderProfile()).rejects.toThrow();
  });

  it('a network failure is not absence either', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(getRiderProfile()).rejects.toThrow();
  });

  it('a real answer still comes through', async () => {
    always(200, { success: true, data: { id: 'rider_1', vehicleType: 'MOTORCYCLE' } });
    await expect(getRiderProfile()).resolves.toMatchObject({ id: 'rider_1' });
  });
});

describe('[W-10] the money reads never invent an empty answer', () => {
  it('a failed settlements read does not resolve to "nothing owed"', async () => {
    always(500, { success: false, error: { message: 'db down' } });
    // the old `soft()` resolved null here, and the page rendered
    // `settlements.data?.unsettled ?? []` — an empty list, i.e. no debt at all
    await expect(getRiderCashSettlements()).rejects.toThrow();
  });

  it('a failed earnings read does not resolve to "no earnings"', async () => {
    always(503, { success: false, error: { message: 'unavailable' } });
    await expect(getRiderSummary()).rejects.toThrow();
  });

  it('a failed subscription read does not resolve to "no subscription"', async () => {
    always(500, { success: false, error: { message: 'unavailable' } });
    await expect(getRiderSubscription()).rejects.toThrow();
  });

  it('a genuinely absent subscription is still absent', async () => {
    always(404, { success: false, error: { message: 'none' } });
    await expect(getRiderSubscription()).resolves.toBeNull();
  });

  it('every request reaches the configured API origin', async () => {
    const fetchMock = always(200, { success: true, data: {} });
    await getRiderProfile();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(API_ORIGIN);
  });
});

describe('[W-10] the blanket catch is gone, and the pages say so', () => {
  /**
   * Strip comments before asserting. Every comment here QUOTES the defect it
   * replaced — "`.catch(() => null)` on every read", "No earner profile on this
   * account" — so a census run against the raw text matches the explanation and
   * grades nothing. This bit twice while writing these tests, which is the
   * point of removing it once, here.
   */
  const code = (text: string) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');

  const lib = code(readFileSync(join(process.cwd(), 'src/lib/mover-api.ts'), 'utf8'));
  const page = (p: string) => code(readFileSync(join(process.cwd(), 'src/app/portal', p), 'utf8'));

  it('mover-api has no catch that swallows every error', () => {
    expect(lib).not.toMatch(/catch\(\(\)\s*=>\s*null\)/);
    expect(lib).toMatch(/ABSENCE_STATUSES = new Set\(\[403, 404\]\)/);
  });

  it('the portal home refuses to claim "no earner profile" on a failed read', () => {
    const home = page('page.tsx');
    // the claim must be guarded by the profile reads having actually SUCCEEDED
    expect(home).toMatch(/if \(rider\.isError \|\| driver\.isError\)/);
    const gate = home.indexOf('No earner profile');
    const guard = home.indexOf('rider.isError || driver.isError');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(gate); // the outage branch is decided FIRST
  });

  it('every money surface on the portal home has an unavailable state', () => {
    const home = page('page.tsx');
    for (const q of ['summary.isError', 'settlements.isError', 'riderSub.isError', 'driverSub.isError', 'driverEarn.isError']) {
      expect(home, q).toContain(q);
    }
    expect(home.match(/<DataUnavailable/g) ?? []).not.toHaveLength(0);
  });

  it('history does not report an outage as "no deliveries yet"', () => {
    const h = page('history/page.tsx');
    expect(h).toMatch(/\{q\.isError && \(/);
    // the empty-state sentence is now reachable only when the read SUCCEEDED
    expect(h.match(/!q\.isLoading && !q\.isError && rows\.length === 0/g) ?? []).toHaveLength(2);
  });

  it('documents does not report an outage as "no obligations"', () => {
    expect(page('documents/page.tsx')).toMatch(/\{status\.isError && \(/);
  });
});

describe('[W-10] the unavailable surface says what it means', () => {
  it('names what failed, and denies being an all-clear', async () => {
    render(<DataUnavailable what="what stores owe you" />);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByText(/Couldn.t load what stores owe you/)).toBeTruthy();
    // the whole point: a reader must not take this for "nothing owed"
    const body = screen.getByRole('status').textContent ?? '';
    expect(body).toMatch(/not an all-clear/i);
    expect(body).toMatch(/could not check/i);
    // and it must never put a figure where the money belongs
    expect(body).not.toMatch(/\b0\b/);
    expect(body).not.toMatch(/\$/);
  });

  it('offers a retry only when there is something to retry, and calls it', async () => {
    const onRetry = vi.fn();
    const { unmount } = render(<DataUnavailable what="your earnings" onRetry={onRetry} />);
    await userEvent.click(screen.getByText('Try again'));
    expect(onRetry).toHaveBeenCalledOnce();
    unmount();
    render(<DataUnavailable what="your earnings" />);
    expect(screen.queryByText('Try again')).toBeNull();
  });

  it('shows the underlying reason when there is one', () => {
    render(<DataUnavailable what="your profile" error={new Error('Request failed (503)')} />);
    expect(screen.getByText(/Request failed \(503\)/)).toBeTruthy();
  });
});
