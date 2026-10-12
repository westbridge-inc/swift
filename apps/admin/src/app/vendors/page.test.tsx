import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VendorsPage from './page';
import { mockApi, renderWithQuery, requestsByMethod } from '@/test/test-utils';

// [MISSION CONTROL · PR-1] The store list: a failed read says so (never an
// empty table that reads as "no stores"), statuses and ratings are words, and
// an approval's refusal arrives in the page with the next step.

const REASON = 'Checked the owner ID and the food licence against the originals';

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

  it('approve → 409 CHECKLIST_INCOMPLETE: the plain next step and the Review Center for that store’s owner', async () => {
    const fetchMock = mockApi((request) => {
      if (request.method === 'GET') return { body: { success: true, data: rows } };
      if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/vendors/vendor-new/approve') {
        return { status: 409, body: { success: false, error: { code: 'CHECKLIST_INCOMPLETE', message: "A store's required documents are not all approved and current — review them in the Verification queue first." } } };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    const { user } = renderWithQuery(<VendorsPage />);
    await user.click(await screen.findByRole('button', { name: /^Approve A Store With/ }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: /reason/i }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Approve store' }));

    expect(await within(dialog).findByText('Approve the required documents in Verification first')).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'Open in Review Center' }).getAttribute('href')).toBe('/verification?applicant=owner-new');
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
  });
});
