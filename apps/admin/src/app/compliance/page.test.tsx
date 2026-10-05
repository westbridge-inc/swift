import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import CompliancePage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [ADMIN-TRUTH] The compliance page is the operator's proof that nobody is on
// the road with a broken document checklist. When its read FAILED, it fell
// through to the empty-state sentences — "Nobody is operating outside the
// rules — and the run log below proves it", "No open cases", "No runs yet" —
// so a timeout or a 403 looked exactly like a clean audit. A failed read must
// say it failed, and must not print the all-clear.
// ---------------------------------------------------------------------------

const ALL_CLEAR = /Nobody is operating outside the rules/;
const NO_CASES = /No open cases/;
const NO_RUNS = /No runs yet/;

function complianceServer(reply: () => { status?: number; body: unknown }) {
  return mockApi((request: ApiRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/compliance') return reply();
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
}

describe('[ADMIN-TRUTH] a failed compliance read is not an all-clear', () => {
  it.each([
    ['a server error', () => ({ status: 500, body: { success: false, error: { code: 'INTERNAL', message: 'boom' } } })],
    ['a refusal', () => ({ status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'Not allowed' } } })],
  ])('after %s the page says the read failed and prints no empty-state sentence', async (_name, reply) => {
    complianceServer(reply);
    renderWithQuery(<CompliancePage />);

    expect(await screen.findByText(/Compliance data could not be loaded/)).toBeTruthy();
    expect(screen.getByText(/not an all-clear/i)).toBeTruthy();
    expect(screen.queryByText(ALL_CLEAR)).toBeNull();
    expect(screen.queryByText(NO_CASES)).toBeNull();
    expect(screen.queryByText(NO_RUNS)).toBeNull();
    // No count may read as a real zero.
    expect(screen.queryByText('(0)')).toBeNull();
    expect(screen.queryByText(/queue \(0\)/)).toBeNull();
  });

  it('a successful read with nothing in it still shows the real all-clear', async () => {
    complianceServer(() => ({ body: { success: true, data: { runs: [], openViolations: [], reviewQueue: [] } } }));
    renderWithQuery(<CompliancePage />);

    expect(await screen.findByText(ALL_CLEAR)).toBeTruthy();
    expect(screen.getByText(NO_CASES)).toBeTruthy();
    expect(screen.getByText(NO_RUNS)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });
});
