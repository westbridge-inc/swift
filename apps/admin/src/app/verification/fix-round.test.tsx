// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
// PDF frame events are dispatched explicitly; fixtures must never open a local network connection.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import VerificationPage from './page';
import { GlobalSearch } from '@/components/layout/GlobalSearch';
import { DocumentViewer } from '@/components/verification/DocumentViewer';
import { mockApi, renderWithQuery, requestsByMethod } from '@/test/test-utils';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
const applicant = { id: 'applicant', firstName: 'Demo', lastName: 'Applicant', phone: '+5926477001' };
const document = { id: 'doc', userId: applicant.id, user: applicant, docType: 'owner_national_id', role: 'VENDOR_OWNER', status: 'PENDING', createdAt: '2026-09-01T00:00:00Z' };
function fixture(missing = false, extraDocument = false) {
  return mockApi((r) => {
    if (r.url.pathname.endsWith('/queue/counts')) return { body: { data: { byLane: { PENDING: { operator: 1, customer: 0 } } } } };
    if (r.url.pathname.endsWith('/queue')) return { body: { data: r.url.searchParams.get('status') === 'PENDING' ? [document, ...(extraDocument ? [{ ...document, id: 'licence', docType: 'drivers_licence' }] : [])] : [], meta: { hasNext: false } } };
    if (r.url.pathname.endsWith('/users/reviewer-id')) return { body: { data: { firstName: 'Demo', lastName: 'Reviewer' } } };
    if (r.url.pathname.includes('/users/')) return { body: { data: { driver: { vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleType: 'CAR', licensePlate: 'HC 4417' } } } };
    if (r.url.pathname.endsWith('/custody')) return { body: { data: { timeline: [
      { at: '2026-09-01T00:00:00Z', actor: applicant.id, what: 'SUBMITTED owner_national_id as VENDOR_OWNER' },
      { at: '2026-09-01T00:01:00Z', actor: 'validator', what: 'V_PLATE_CLASS SKIP UNDETERMINABLE [blocking]' },
      { at: '2026-09-01T00:02:00Z', actor: 'reviewer-id', what: 'AUDIT ADMIN PUT /api/v1/admin/verification/:id/reject' },
    ] } } };
    if (r.url.pathname.endsWith('/document-url')) return missing ? { status: 400, body: { error: { code: 'VERIFICATION_OBJECT_UNAVAILABLE', message: 'This verification file is unavailable. Upload it again.' } } } : { body: { data: { url: '/api/v1/verification/render/doc?sig=fixture&expires=1' } } };
    if (r.method === 'PUT') return { body: { data: { status: 'REJECTED' } } };
    throw new Error(`Unexpected ${r.url.pathname}`);
  });
}
async function review(user: ReturnType<typeof renderWithQuery>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Review', exact: true }));
}
describe('coordinator screenshot fixes', () => {
  it('collapses phone filters by default and toggles them without clearing the selection', async () => {
    fixture();
    const { user } = renderWithQuery(<VerificationPage />);
    await screen.findByText('1 applicants');
    const toggle = screen.getByRole('button', { name: /Filters/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const panel = documentGlobal().getElementById(toggle.getAttribute('aria-controls')!);
    expect(panel).toBeTruthy();
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await user.type(screen.getByLabelText('Search applicants'), 'Demo');
    await user.click(toggle);
    await user.click(toggle);
    expect((screen.getByLabelText('Search applicants') as HTMLInputElement).value).toBe('Demo');
  });
  it('starts each newly selected document at the top of the reserved review pane', async () => {
    fixture(false, true);
    const { user } = renderWithQuery(<VerificationPage />);
    await review(user);
    const pane = screen.getByRole('navigation', { name: 'Applicant documents' }).parentElement!;
    pane.scrollTop = 800;
    await user.click(screen.getByRole('button', { name: /Driver's licence.*PENDING/ }));
    expect(pane.scrollTop).toBe(0);
  });
  it('offers a missing-file rejection using the existing unreadable contract and no operator upload instruction', async () => {
    const fetch = fixture(true);
    const { user } = renderWithQuery(<VerificationPage />);
    await review(user);
    await user.click(screen.getByRole('button', { name: 'View document' }));
    expect((await screen.findByRole('alert')).textContent).toContain('applicant must re-submit');
    expect(screen.queryByText(/Upload it again|Retry using/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Approve', exact: true }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Reject missing file' }));
    expect((screen.getByLabelText('Reason code') as HTMLSelectElement).value).toBe('UNREADABLE');
    await user.type(screen.getByLabelText('Decision note'), 'The file is missing; please re-submit it.');
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    await waitFor(() => expect(requestsByMethod(fetch, 'PUT')).toHaveLength(1));
    expect(JSON.parse(String(requestsByMethod(fetch, 'PUT')[0]![1]?.body))).toEqual({ reason: 'The file is missing; please re-submit it.', reasonCode: 'UNREADABLE' });
  });
  it('shows human labels and named actors instead of timeline internals', async () => {
    fixture();
    const { user } = renderWithQuery(<VerificationPage />);
    await review(user);
    expect(await screen.findByText('Submitted National ID as Business owner')).toBeTruthy();
    expect(screen.getByText('Plate class check: could not determine — blocking')).toBeTruthy();
    expect(await screen.findByText('Demo Reviewer')).toBeTruthy();
    expect(screen.getByText(/Toyota Allion · Car/)).toBeTruthy();
    const history = screen.getByRole('heading', { name: 'History and audit timeline' }).parentElement!;
    expect(history.textContent).not.toMatch(/reviewer-id|V_PLATE_CLASS|\/api\/|VENDOR_OWNER|owner_national_id/);
    expect(history.querySelectorAll('time')).toHaveLength(3);
  });
  it('keeps an audited new-tab PDF fallback visible and approval locked until the label row is checked', async () => {
    const fetch = vi.fn(async (...[url]: [string, RequestInit?]) => url.includes('/document-url')
      ? new Response(JSON.stringify({ data: { url: '/api/v1/verification/render/doc?sig=fixture&expires=1' } }), { headers: { 'content-type': 'application/json' } })
      : new Response('pdf', { headers: { 'content-type': 'application/pdf' } }));
    vi.stubGlobal('fetch', fetch);
    const viewed = vi.fn();
    const { user } = renderWithQuery(<DocumentViewer id="doc" label="National ID" onViewed={viewed} />);
    await user.click(screen.getByRole('button', { name: 'View document' }));
    const link = await screen.findByRole('link', { name: 'Open document in a new tab' });
    expect(link.getAttribute('href')).toBe('http://localhost:3000/api/v1/verification/render/doc?sig=fixture&expires=1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ cache: 'no-store', redirect: 'error' });
    expect(viewed).not.toHaveBeenCalledWith(true);
    fireEvent.error(screen.getByTitle('National ID evidence'));
    expect(screen.getByText('The inline PDF could not be displayed.')).toBeTruthy();
    expect(screen.queryByTitle('National ID evidence')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open document in a new tab' })).toBeTruthy();
    const check = screen.getByRole('checkbox');
    await user.click(check.closest('label')!);
    expect(viewed).toHaveBeenLastCalledWith(true);
  });
  it('uses a concise global search placeholder with a descriptive accessible label', () => {
    renderWithQuery(<GlobalSearch />);
    expect(screen.getByRole('textbox', { name: 'Search orders, users, vendors' }).getAttribute('placeholder')).toBe('Search');
  });
});
function documentGlobal() { return window.document; }
