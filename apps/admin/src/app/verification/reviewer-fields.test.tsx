import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VerificationPage from './page';
import { DocumentViewer } from '@/components/verification/DocumentViewer';
import { mockApi, renderWithQuery, requestsByMethod } from '@/test/test-utils';

function fixture(docType: string, reviewerTypes: string[]) {
  return mockApi((r) => {
    if (r.url.pathname.endsWith('/queue/counts')) return { body: { data: {} } };
    if (r.url.pathname.endsWith('/queue')) return { body: { data: [{ id: 'synthetic-doc', userId: 'synthetic-user', docType, reviewerTypes,
      role: 'MOVER', status: 'PENDING', user: { id: 'synthetic-user', firstName: 'Synthetic', lastName: 'Applicant' } }], meta: { hasNext: false } } };
    if (r.url.pathname.includes('/users/')) return { body: { data: {} } };
    if (r.url.pathname.endsWith('/custody')) return { body: { data: { timeline: [] } } };
    if (r.url.pathname.endsWith('/document-url')) return { body: { data: { url: '/api/v1/verification/render/synthetic-doc?sig=fixture&expires=1' } } };
    if (r.url.pathname.includes('/verification/render/')) return { body: {} };
    if (r.method === 'PUT') return { body: { data: { status: 'APPROVED' } } };
    throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
  });
}

describe('reviewer fields required by the approval route', () => {
  it.each(['national_id', 'owner_national_id', 'passport', 'identity_l2', 'drivers_licence'])('%s sends the number the reviewer read', async (docType) => {
    const fetch = fixture(docType, ['documentNumber']);
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'View document' }));
    fireEvent.load(await screen.findByRole('img'));
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Document number'), 'SYNTH-1234');
    if (docType === 'drivers_licence') fireEvent.change(screen.getByLabelText('Expiry printed on the document'), { target: { value: '2028-01-01' } });
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Decision note'), 'Synthetic evidence checked');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(requestsByMethod(fetch, 'PUT')).toHaveLength(1));
    expect(JSON.parse(String(requestsByMethod(fetch, 'PUT')[0]![1]?.body))).toMatchObject({ documentNumber: 'SYNTH-1234' });
  });

  it('police clearance asks for its issue date rather than an invented expiry', async () => {
    const fetch = fixture('police_clearance', ['issuedOn']);
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'View document' }));
    fireEvent.load(await screen.findByRole('img'));
    expect(screen.queryByLabelText('Expiry printed on the document')).toBeNull();
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Issue date printed on the document'), { target: { value: '2026-09-01' } });
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await user.type(screen.getByLabelText('Decision note'), 'Synthetic evidence checked');
    await user.click(screen.getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(requestsByMethod(fetch, 'PUT')).toHaveLength(1));
    expect(JSON.parse(String(requestsByMethod(fetch, 'PUT')[0]![1]?.body))).toEqual({ issuedOn: '2026-09-01T00:00:00.000Z' });
  });
});

describe('PDF approval requires confirmed inline evidence', () => {
  const settings = (window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings;
  let previous: boolean;
  beforeEach(() => { previous = settings.disableIframePageLoading; settings.disableIframePageLoading = true; });
  afterEach(() => { settings.disableIframePageLoading = previous; });
  it.each([false, true])('only an inline load followed by confirmation unlocks the PDF (failed=%s)', async (failed) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/document-url')
      ? new Response(JSON.stringify({ data: { url: '/api/v1/verification/render/synthetic-doc?sig=fixture&expires=1' } }), { headers: { 'content-type': 'application/json' } })
      : new Response('pdf', { headers: { 'content-type': 'application/pdf' } })));
    const viewed = vi.fn();
    const { user } = renderWithQuery(<DocumentViewer id="synthetic-doc" label="Document" onViewed={viewed} />);
    await user.click(screen.getByRole('button', { name: 'View document' }));
    const frame = await screen.findByTitle('Document evidence');
    const check = screen.getByRole('checkbox') as HTMLInputElement;
    expect(check.disabled).toBe(true);
    expect(viewed).not.toHaveBeenCalledWith(true);
    if (failed) {
      fireEvent.error(frame);
      await user.click(screen.getByRole('link', { name: 'Open document in a new tab' }));
      expect(check.disabled).toBe(true);
      expect(viewed).not.toHaveBeenCalledWith(true);
    } else {
      fireEvent.load(frame);
      expect(check.disabled).toBe(false);
      expect(viewed).not.toHaveBeenCalledWith(true);
      await user.click(check);
      expect(viewed).toHaveBeenLastCalledWith(true);
    }
  });
});
