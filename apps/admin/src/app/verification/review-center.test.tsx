import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VerificationPage from './page';
import { mockApi, renderWithQuery, requestsByMethod } from '@/test/test-utils';

const doc = (id: string, userId: string, firstName: string, type = 'national_id', role = 'MOVER') => ({
  id, userId, docType: type, role, status: 'PENDING', createdAt: '2026-09-01T00:00:00Z',
  user: { id: userId, firstName, lastName: 'Applicant', phone: '+5926477001', countryCode: 'GY' },
});
const alice = doc('a', 'u1', 'Alice');
const bob = doc('b', 'u2', 'Bob');
function fixture(options: { pages?: boolean; signed?: string; pending?: boolean; fail?: boolean } = {}) {
  return mockApi((r) => {
    if (r.url.pathname.endsWith('/queue/counts')) return { body: { data: { byLane: { PENDING: { operator: 3, customer: 1 } } } } };
    if (r.url.pathname.endsWith('/queue')) {
      if (r.url.searchParams.get('status') !== 'PENDING') return { body: { data: [], meta: { hasNext: false } } };
      const page = r.url.searchParams.get('page');
      return { body: { data: options.pages ? (page === '2' ? [doc('c', 'u1', 'Alice', 'police_clearance')] : [alice, bob]) : [alice, doc('c', 'u1', 'Alice', 'police_clearance'), bob], meta: { hasNext: !!options.pages && page !== '2', total: 3 } } };
    }
    if (r.url.pathname.includes('/users/')) return { body: { data: { vendorOwner: { vendors: [{ name: 'Demo grocery' }] } } } };
    if (r.url.pathname.endsWith('/custody')) return { body: { data: { timeline: [{ at: '2026-09-01T00:00:00Z', actor: 'reviewer', what: 'CASE OPENED' }] } } };
    if (r.url.pathname.endsWith('/document-url')) return { body: { data: { url: options.signed ?? '/api/v1/verification/render/a?expires=1&sig=fixture' } } };
    if (r.url.pathname.includes('/verification/render/')) return { body: { loaded: true } };
    if (r.method === 'PUT') return options.fail ? { status: 400, body: { error: { message: 'Decision refused' } } } : { body: { data: { ...alice, status: options.pending ? 'PENDING' : 'APPROVED' } } };
    throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
  });
}
async function openAlice(user: ReturnType<typeof renderWithQuery>['user']) {
  const [name] = await screen.findAllByText('Alice Applicant');
  await user.click(within(name!.closest('tr')!).getByRole('button', { name: 'Review' }));
}

describe('Review Center applicant workspace', () => {
  it('groups an applicant across server pages, masks phones, and filters without losing their other documents', async () => {
    const fetch = fixture({ pages: true });
    const { user } = renderWithQuery(<VerificationPage />);
    await screen.findByText('2 applicants');
    expect(screen.getAllByRole('button', { name: 'Review' })).toHaveLength(2);
    expect(screen.queryByText('+5926477001')).toBeNull();
    expect(requestsByMethod(fetch, 'GET').some(([url]) => String(url).includes('page=2'))).toBe(true);
    await user.selectOptions(screen.getByLabelText('Document type'), 'police_clearance');
    expect(screen.getAllByRole('button', { name: 'Review' })).toHaveLength(1);
    await openAlice(user);
    expect(screen.getByRole('button', { name: /national id.*PENDING/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /police clearance.*PENDING/i })).toBeTruthy();
    expect(await screen.findByText('Demo grocery')).toBeTruthy();
    expect(await screen.findByText('Review case opened')).toBeTruthy();
  });
  it('searches by name and phone and applies age and role filters', async () => {
    fixture();
    const { user } = renderWithQuery(<VerificationPage />);
    await screen.findByText('2 applicants');
    await user.type(screen.getByLabelText('Search applicants'), 'bob');
    expect(screen.getAllByRole('button', { name: 'Review' })).toHaveLength(1);
    await user.clear(screen.getByLabelText('Search applicants'));
    await user.type(screen.getByLabelText('Search applicants'), '6477001');
    expect(screen.getAllByRole('button', { name: 'Review' })).toHaveLength(2);
    await user.selectOptions(screen.getByLabelText('Waiting time'), '24');
    expect(screen.getAllByRole('button', { name: 'Review' })).toHaveLength(2);
    await user.selectOptions(screen.getByLabelText('Applicant role'), 'CUSTOMER');
    expect(screen.getByText('No applicants match these filters.')).toBeTruthy();
  });
  it('rejects an arbitrary signed path before fetching or rendering it', async () => {
    const fetch = fixture({ signed: 'https://outside.invalid/uploads/raw-document?sig=fixture&expires=1' });
    const { user } = renderWithQuery(<VerificationPage />);
    await openAlice(user);
    await user.click(screen.getByRole('button', { name: /View document/ }));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('/document-url'))).toBe(true));
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/uploads/'))).toBe(false);
    expect(await screen.findByText(/Document could not be displayed/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows inline evidence, waits for image load, and advances only after the server decision', async () => {
    const fetch = fixture();
    const { user } = renderWithQuery(<VerificationPage />);
    await openAlice(user);
    await user.click(screen.getByRole('button', { name: /View document/ }));
    const preview = await screen.findByAltText('National ID evidence');
    expect(preview.getAttribute('src')).toContain('/api/v1/verification/render/a?');
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.load(preview);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Decision note'), 'Matches the submitted identity');
    expect(requestsByMethod(fetch, 'PUT')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Bob Applicant' })).toBeTruthy());
    expect(screen.getByRole('status').textContent).toContain('Approved National ID');
    expect(JSON.parse(String(requestsByMethod(fetch, 'PUT')[0]![1]?.body))).toEqual({});
  });
  it('shows PENDING honestly after a fraud-class verdict and advances to the next applicant', async () => {
    fixture({ pending: true });
    const { user } = renderWithQuery(<VerificationPage />);
    await openAlice(user);
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await user.selectOptions(screen.getByLabelText('Reason code'), 'SUSPECTED_TAMPERING');
    expect(screen.getByText(/a different reviewer must confirm/i)).toBeTruthy();
    await user.type(screen.getByLabelText('Decision note'), 'The name area appears altered');
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/not rejected/i);
    await screen.findByRole('heading', { name: 'Bob Applicant' });
  });
  it('keeps a failed decision and its entered note open, without navigation', async () => {
    fixture({ fail: true });
    const { user } = renderWithQuery(<VerificationPage />);
    await openAlice(user);
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await user.selectOptions(screen.getByLabelText('Reason code'), 'UNREADABLE');
    await user.type(screen.getByLabelText('Decision note'), 'The photo is too dark to read');
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Decision refused');
    expect((screen.getByLabelText('Decision note') as HTMLTextAreaElement).value).toContain('too dark');
    expect(screen.getByRole('heading', { name: 'Alice Applicant' })).toBeTruthy();
  });
  it('supports J/K navigation but ignores shortcuts in text inputs', async () => {
    fixture();
    const { user } = renderWithQuery(<VerificationPage />);
    await openAlice(user);
    fireEvent.keyDown(window, { key: 'j' });
    await screen.findByRole('heading', { name: 'Bob Applicant' });
    fireEvent.keyDown(window, { key: 'k' });
    await screen.findByRole('heading', { name: 'Alice Applicant' });
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await user.type(screen.getByLabelText('Decision note'), 'jkr');
    expect(screen.getByRole('heading', { name: 'Alice Applicant' })).toBeTruthy();
  });
});
