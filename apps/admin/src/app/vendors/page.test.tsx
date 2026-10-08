import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VendorsPage from './page';
import { mockApi, renderWithQuery, requestsByMethod } from '@/test/test-utils';

// [MISSION CONTROL · PR-1] The store list: a failed read says so (never an
// empty table that reads as "no stores"), and statuses and ratings are words.
// [MC-PR2] The list no longer approves: activation follows the documents.

const rows = [
  {
    id: 'vendor-new', name: 'A Store With A Very Long Name That Would Have Wrapped Mid Word Across The Column',
    vendorType: 'RESTAURANT', status: 'PENDING_APPROVAL', city: 'Georgetown',
    averageRating: 5, totalRatings: 0, totalOrders: 0, owner: { user: { id: 'owner-new' } },
  },
  {
    id: 'vendor-live', name: 'Live Store', vendorType: 'SUPERMARKET', status: 'ACTIVE', city: 'Linden',
    averageRating: 4.56, totalRatings: 12, totalOrders: 30, owner: { user: { id: 'owner-live' } },
  },
];

const listPath = '/api/v1/admin/vendors';

describe('[MC-PR1] vendors list', () => {
  it('a failed read says it could not load, with a Retry — not "no stores"', async () => {
    let calls = 0;
    const fetchMock = mockApi((request) => {
      if (request.method === 'GET' && request.url.pathname === listPath) {
        calls += 1;
        return calls === 1
          ? { status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } } }
          : { body: { success: true, data: rows } };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    const { user } = renderWithQuery(<VendorsPage />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Couldn't load the store list");
    expect(alert.textContent).toContain("Something went wrong on Swift's server");
    expect(alert.textContent).toContain('Code INTERNAL_ERROR · HTTP 500');
    expect(screen.queryByText('No stores yet.')).toBeNull();

    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Live Store')).toBeTruthy();
    expect(requestsByMethod(fetchMock, 'GET')).toHaveLength(2);
  });

  it('shows plain words: status, type, and "New" for a store nobody has rated (not 5.0)', async () => {
    mockApi(() => ({ body: { success: true, data: rows } }));
    renderWithQuery(<VendorsPage />);
    const table = await screen.findByRole('table', { name: 'Stores' });
    expect(within(table).getByText('Waiting for approval')).toBeTruthy();
    expect(within(table).getByText('Restaurant')).toBeTruthy();
    expect(within(table).getByText('New')).toBeTruthy();
    expect(within(table).getByText('4.6 · 12 ratings')).toBeTruthy();
    expect(table.textContent).not.toMatch(/PENDING_APPROVAL|RESTAURANT|5\.0/);
    // a long name keeps its full text (title + DOM) and is styled to truncate
    const longName = within(table).getByText(rows[0]!.name);
    expect(longName.className).toContain('mc-truncate');
    expect(longName.getAttribute('title')).toBe(rows[0]!.name);
  });

  it('[MC-PR2] offers no Approve from the list: each store links to its page, where its document checklist is', async () => {
    const fetchMock = mockApi(() => ({ body: { success: true, data: rows } }));
    renderWithQuery(<VendorsPage />);
    const table = await screen.findByRole('table', { name: 'Stores' });
    expect(within(table).queryByRole('button')).toBeNull();
    expect(within(table).getByRole('link', { name: /^A Store With/ }).getAttribute('href')).toBe('/vendors/vendor-new');
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0));
  });
});
