import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import CompliancePage from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S4-5 · privacy] The Compliance page showed each flagged mover's full phone number, while every other
// console list (Users, Riders, Drivers, Support, the Review Center) masks it with lib/review-center maskedPhone. Nobody
// is called from this page. The page masks it the same way, whatever the server sends (the server now masks it too).
// Fictional numbers.
// ---------------------------------------------------------------------------

function serve(violationPhone: string | null, reviewPhone: string | null) {
  mockApi((r) => {
    if (r.url.pathname === '/api/v1/admin/compliance') return { body: { success: true, data: { runs: [], openViolations: [
      { id: 'v1', user: { firstName: 'Ravi', lastName: 'Persaud', phone: violationPhone }, reason: 'docs', moverKind: 'DRIVER', actionTaken: 'FORCED_OFFLINE', createdAt: '2026-10-18T10:00:00.000Z', evidence: {} },
    ], reviewQueue: [
      { id: 'c1', user: { firstName: 'Asha', lastName: 'Singh', phone: reviewPhone }, dueAt: '2026-10-25T00:00:00.000Z' },
    ] } } };
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
}

describe('[ADMIN-AUDIT S4-5] the Compliance page masks phone numbers like every other list', () => {
  it('a full number from an older server is never shown: only its last four digits', async () => {
    serve('+5926000123', '+5926000456');
    renderWithQuery(<CompliancePage />);
    await screen.findByText(/Ravi/);
    expect(screen.getByText('••• ••• 0123')).toBeTruthy();
    expect(screen.getByText('••• ••• 0456')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/6000123|6000456/);
  });
  it('a number the server already masked reads the same way; no number says so', async () => {
    serve('+592•••••0123', null);
    renderWithQuery(<CompliancePage />);
    await screen.findByText(/Ravi/);
    expect(screen.getByText('••• ••• 0123')).toBeTruthy();
    expect(screen.getByText('No phone on file')).toBeTruthy();
  });
});
