import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import DiscoveryPage from './page';
import { API_ORIGIN, mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// Eight admin discovery routes existed and `git grep discovery apps/admin/src`
// returned nothing, so a customer-facing taxonomy had no curator and a queue of
// vendor requests had nobody standing at it. The measurable consequence: 1 of
// 57 live retail items carried a discovery tag, because the backfill that would
// tag them is admin-triggered and no admin could trigger it.
//
// These assert the three decisions reach the endpoints that actually move
// state, that the payload shapes the routes DEMAND are the ones sent, and that
// the one expected operational failure — workers off — is reported in those
// words rather than as a generic error.
// ---------------------------------------------------------------------------

const category = {
  id: 'cat-1',
  slug: 'hardware-tools',
  name: 'Hardware & Tools',
  emoji: '🔧',
  iconKey: null,
  aliases: ['tools', 'hardware'],
  kind: 'RETAIL',
  vertical: 'RETAIL',
  status: 'ACTIVE',
  sortWeight: 10,
  mergedIntoId: null,
};

const request = {
  id: 'req-1',
  vendorId: 'ven-1',
  vendorName: 'City Hardware',
  proposedName: 'Power Tools',
  note: 'We sell drills and grinders',
  status: 'PENDING',
  createdAt: '2026-08-29T00:00:00.000Z',
  resolutionNote: null,
};

function handler(extra?: (_r: ApiRequest) => { body: unknown; status?: number } | undefined) {
  return (r: ApiRequest) => {
    if (r.url.pathname === '/api/v1/admin/discovery/categories' && r.method === 'GET') {
      return { body: { success: true, data: [category] } };
    }
    if (r.url.pathname === '/api/v1/admin/discovery/requests') {
      return { body: { success: true, data: [request] } };
    }
    const handled = extra?.(r);
    if (handled) return handled;
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  };
}

describe('the discovery taxonomy finally has a curator', () => {
  it('maps a request onto an existing category rather than minting a near-duplicate', async () => {
    const fetchMock = mockApi(handler((r) => (
      r.method === 'POST' && r.url.pathname === '/api/v1/admin/discovery/requests/req-1/map'
        ? { body: { success: true, data: { mappedTo: 'hardware-tools' } } }
        : undefined
    )));
    const { user } = renderWithQuery(<DiscoveryPage />);

    expect(await screen.findByText('Power Tools')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Decide' }));

    // Map is offered FIRST and its target is a select of real categories — a
    // free-text slug is how you get two categories meaning the same thing, and
    // a slug is never edited afterwards.
    const mapButton = screen.getByRole('button', { name: 'Map' }) as HTMLButtonElement;
    expect(mapButton.disabled).toBe(true);
    await user.selectOptions(screen.getByRole('combobox', { name: '' }) ?? screen.getAllByRole('combobox')[0]!, 'hardware-tools');
    await user.click(screen.getByRole('button', { name: 'Map' }));

    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/discovery/requests/req-1/map`);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ targetSlug: 'hardware-tools' });
  });

  it('will not create a category without the emoji the route requires', async () => {
    mockApi(handler());
    const { user } = renderWithQuery(<DiscoveryPage />);

    await screen.findByText('Power Tools');
    await user.click(screen.getByRole('button', { name: 'Decide' }));

    // The route's schema makes emoji mandatory. Disabled here rather than
    // discovered as a 400 at the moment someone tries to approve.
    const create = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
  });

  it('sends kind and vertical as enum values, never free text', async () => {
    const fetchMock = mockApi(handler((r) => (
      r.method === 'POST' && r.url.pathname === '/api/v1/admin/discovery/requests/req-1/approve'
        ? { body: { success: true, data: category } }
        : undefined
    )));
    const { user } = renderWithQuery(<DiscoveryPage />);

    await screen.findByText('Power Tools');
    await user.click(screen.getByRole('button', { name: 'Decide' }));
    await user.type(screen.getByLabelText('Emoji'), '🔩');
    await user.selectOptions(screen.getByLabelText('Kind'), 'RETAIL');
    await user.selectOptions(screen.getByLabelText('Vertical'), 'RETAIL');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const body = JSON.parse(String((requestsByMethod(fetchMock, 'POST')[0]![1] as RequestInit).body));
    expect(body).toEqual({ emoji: '🔩', kind: 'RETAIL', vertical: 'RETAIL' });
  });

  it('refuses to reject until there is a reason, because the vendor reads it verbatim', async () => {
    const fetchMock = mockApi(handler((r) => (
      r.method === 'POST' && r.url.pathname === '/api/v1/admin/discovery/requests/req-1/reject'
        ? { body: { success: true, data: { rejected: true } } }
        : undefined
    )));
    const { user } = renderWithQuery(<DiscoveryPage />);

    await screen.findByText('Power Tools');
    await user.click(screen.getByRole('button', { name: 'Decide' }));

    const reject = screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement;
    expect(reject.disabled).toBe(true);

    await user.type(screen.getByLabelText('Rejection reason'), 'Covered by Hardware & Tools');
    await user.click(reject);

    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const body = JSON.parse(String((requestsByMethod(fetchMock, 'POST')[0]![1] as RequestInit).body));
    expect(body).toEqual({ reason: 'Covered by Hardware & Tools' });
  });

  it('says the workers are off in those words, instead of a generic failure', async () => {
    // 503 QUEUES_OFF is not a fault to hide. It means nothing would have
    // processed the job, and the operator needs to know that specifically.
    mockApi(handler((r) => (
      r.method === 'POST' && r.url.pathname === '/api/v1/admin/discovery/backfill'
        ? { status: 503, body: { success: false, error: { code: 'QUEUES_OFF', message: 'Background workers are not running' } } }
        : undefined
    )));
    const { user } = renderWithQuery(<DiscoveryPage />);

    await screen.findByText('Power Tools');
    await user.click(screen.getByRole('button', { name: 'Run the backfill' }));

    expect(await screen.findByText(/background workers are not running/i)).toBeTruthy();
  });
});
