import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogueApproverAccess } from './CatalogueApproverAccess';
import { mockApi, renderWithQuery, requestsByMethod } from '@/test/test-utils';

// [GUARDRAILS §8 · Opus S3-9] Showing an item a banned word is holding needs an explicit catalogue-approver grant;
// a super-admin may grant it to themselves with a recorded reason (owner, 14 Oct: "the same way as document
// reviewer"). These tests pin the console door to the API's grant route, so the catalogue check's Approve button
// never dead-ends at a refusal that points nowhere.

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const REASON = 'Owner runs the catalogue check himself this week';
const team = (meGranted: boolean) => [
  { userId: 'usr_me', name: 'Synthetic Owner', role: 'SUPER_ADMIN', active: true, documentReviewer: true, catalogueApprover: meGranted, you: true },
  { userId: 'usr_ops', name: 'Synthetic Operator', role: 'ADMIN', active: true, documentReviewer: false, catalogueApprover: true, you: false },
  { userId: 'usr_gone', name: 'Synthetic Former', role: 'ADMIN', active: false, documentReviewer: false, catalogueApprover: false, you: false },
];

describe('[§8 · S3-9] the catalogue approver grant in the Review Center', () => {
  it('stays hidden from an admin the list refuses (only a super-admin manages the grant)', async () => {
    const fetchMock = mockApi((r) => {
      if (r.url.pathname === '/api/v1/admin/staff/document-reviewers') {
        return { status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'Founder access required' } } };
      }
      throw new Error(`Unexpected ${r.url.pathname}`);
    });
    renderWithQuery(<CatalogueApproverAccess />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Catalogue approvers' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Grant/ })).toBeNull();
  });

  it('a super-admin without the grant is told so and grants it to themselves with a stated reason', async () => {
    let granted = false;
    const fetchMock = mockApi((r) => {
      if (r.url.pathname === '/api/v1/admin/staff/document-reviewers') return { body: { success: true, data: team(granted) } };
      if (r.method === 'PUT' && r.url.pathname === '/api/v1/admin/staff/usr_me/catalogue-approver') {
        granted = true;
        return { body: { success: true, data: { userId: 'usr_me', catalogueApprover: true, changed: true } } };
      }
      throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
    });
    const { user } = renderWithQuery(<CatalogueApproverAccess />);
    const panel = await screen.findByRole('region', { name: 'Catalogue approvers' });
    expect(within(panel).getByText(/You cannot approve items held by the catalogue check yet/)).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Grant myself the catalogue-approver permission' }));

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Grant permission' }));

    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(String(url)).toBe('http://admin-api.test/api/v1/admin/staff/usr_me/catalogue-approver');
    expect(JSON.parse(String(init?.body))).toEqual({ grant: true });
    expect((init?.headers as Record<string, string>)['x-swift-reason']).toBe(REASON);
    // The list is read again from the server: no optimistic "granted".
    expect(await within(panel).findByText(/You can approve items held by the catalogue check/)).toBeTruthy();
  });

  it('removing it from a colleague also needs a reason; an inactive admin has no button', async () => {
    const fetchMock = mockApi((r) => {
      if (r.url.pathname === '/api/v1/admin/staff/document-reviewers') return { body: { success: true, data: team(true) } };
      if (r.method === 'PUT' && r.url.pathname === '/api/v1/admin/staff/usr_ops/catalogue-approver') {
        return { body: { success: true, data: { userId: 'usr_ops', catalogueApprover: false, changed: true } } };
      }
      throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
    });
    const { user } = renderWithQuery(<CatalogueApproverAccess />);
    const panel = await screen.findByRole('region', { name: 'Catalogue approvers' });
    // The count is the catalogue grant's own (two active approvers here; only one document reviewer).
    expect(within(panel).getByRole('heading', { level: 2 }).textContent).toBe('Catalogue approvers 2 with the permission');
    const gone = within(panel).getByText('Synthetic Former').closest('li')!;
    expect(within(gone).queryByRole('button')).toBeNull();
    const row = within(panel).getByText('Synthetic Operator').closest('li')!;
    await user.click(within(row).getByRole('button', { name: 'Remove the catalogue-approver permission from Synthetic Operator' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Moved to support duties from Monday on');
    await user.click(within(dialog).getByRole('button', { name: 'Remove permission' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    expect(JSON.parse(String(requestsByMethod(fetchMock, 'PUT')[0]![1]?.body))).toEqual({ grant: false });
  });
});
