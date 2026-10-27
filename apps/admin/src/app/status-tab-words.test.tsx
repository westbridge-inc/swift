import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S4-1] The status tabs speak the console's words, not codes.
//
// Returns showed "refund_due" as a tab and "No refund_due returns.", Claims
// "pending review" / "auto approved", Subscribers "trial" / "past due": a code
// lower-cased is still a code. The tabs now use the same labels the rows use.
// ---------------------------------------------------------------------------

const nav = vi.hoisted(() => ({ pathname: '/', push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => nav, useSearchParams: () => new URLSearchParams() }));

import ReturnsPage from './returns/page';
import ClaimsPage from './claims/page';
import SubscriptionsPage from './subscriptions/page';
import SupportPage from './support/page';

const empty = () => mockApi(() => ({ body: { success: true, data: [], meta: { page: 1, limit: 50, total: 0, totalPages: 0, hasNext: false, hasPrev: false } } }));
const tabs = () => screen.getAllByRole('button').filter((b) => b.hasAttribute('aria-pressed')).map((b) => b.textContent);

describe('[ADMIN-AUDIT S4-1] status tabs in plain words', () => {
  it('Returns', async () => {
    empty();
    renderWithQuery(<ReturnsPage />);
    expect(await screen.findByText('No returns under “Requested”.')).toBeTruthy();
    expect(tabs()).toEqual(['Requested', 'Approved', 'Refund owed', 'Rejected', 'Refunded']);
    expect(document.body.textContent).not.toMatch(/refund_due|requested returns/);
  });
  it('Claims', async () => {
    empty();
    renderWithQuery(<ClaimsPage />);
    expect(await screen.findByText('No claims under “Waiting for review”.')).toBeTruthy();
    expect(tabs()).toEqual(expect.arrayContaining(['Waiting for review', 'Approved automatically', 'Approved', 'Paid', 'Rejected']));
    expect(document.body.textContent).not.toMatch(/pending review|auto approved/);
  });
  it('Support (REVIEW-F #2154 S4-3): the tabs say what the rows say', async () => {
    mockApi(() => ({ body: { success: true, data: { tickets: [], total: 0, page: 1, limit: 20 } } }));
    renderWithQuery(<SupportPage />);
    expect(await screen.findByText('No tickets under “Open”.')).toBeTruthy();
    expect(tabs()).toEqual(['Open', 'Being handled', 'Resolved']);
    expect(document.body.textContent).not.toMatch(/In progress|open tickets/);
  });
  it('Subscribers', async () => {
    empty();
    renderWithQuery(<SubscriptionsPage />);
    await screen.findAllByRole('button', { name: 'Free trial' });
    expect(tabs()).toEqual(expect.arrayContaining(['All', 'Free trial', 'Active', 'Past due', 'Suspended', 'Cancelled']));
    expect(tabs()).not.toContain('past due');
  });
});
