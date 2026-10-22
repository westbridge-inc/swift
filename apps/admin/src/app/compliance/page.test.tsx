import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import CompliancePage from './page';
import { mockApi, renderWithQuery, requestsByMethod, type ApiReply, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [U28] Running the audit, deciding a re-verification and resolving a
// violation failed in SILENCE: each mutation only refetched, so a refusal
// looked like a button that did nothing. Each is now confirmed in the in-page
// panel, which keeps the server's refusal in view, and the answer stays on the
// page. Running the audit can force movers offline, so it is confirmed first.
// ---------------------------------------------------------------------------

const REASON = 'Documents re-checked against the issuing office';
const violation = { id: 'v1', user: { firstName: 'Ravi', lastName: 'Persaud', phone: '+5926000000' }, reason: 'LICENCE_EXPIRED', moverKind: 'DRIVER', actionTaken: 'FORCED_OFFLINE', createdAt: '2026-10-18T10:00:00.000Z', evidence: {} };
const review = { id: 'c1', user: { firstName: 'Asha', lastName: 'Singh', phone: '+5926000001' }, dueAt: '2026-10-25T00:00:00.000Z' };
const refusal = (message: string): ApiReply => ({ status: 409, body: { success: false, error: { code: 'CHECKLIST_INCOMPLETE', message } } });

function server(write: (_r: ApiRequest) => ApiReply) {
  return mockApi((r: ApiRequest) => {
    if (r.method === 'GET' && r.url.pathname === '/api/v1/admin/compliance') {
      return { body: { success: true, data: { runs: [], openViolations: [violation], reviewQueue: [review] } } };
    }
    if (r.method === 'POST') return write(r);
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
}

describe('[U28] compliance actions are never silent', () => {
  it('"Run audit now" is confirmed first, then its answer is shown', async () => {
    const fetchMock = server(() => ({ body: { success: true, data: { moversChecked: 4, violations: 0 } } }));
    const { user } = renderWithQuery(<CompliancePage />);
    await user.click(await screen.findByRole('button', { name: 'Run audit now' }));
    const panel = await screen.findByRole('dialog');
    expect(panel.textContent).toContain('forced offline');
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(0);
    await user.click(within(panel).getByRole('button', { name: 'Run audit' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    expect(await screen.findByText(/Audit run\./)).toBeTruthy();
  });

  it('a refused "Mark resolved" shows the server\'s words in the panel', async () => {
    server(() => refusal('Their checklist does not pass yet: the licence is still expired.'));
    const { user } = renderWithQuery(<CompliancePage />);
    await user.click(await screen.findByRole('button', { name: 'Mark resolved' }));
    const panel = await screen.findByRole('dialog');
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(panel).getByRole('button', { name: 'Mark resolved' }));
    expect((await within(panel).findByRole('alert')).textContent).toContain('the licence is still expired');
  });

  it('failing a re-verification needs the note, names the person, and sends note + reason', async () => {
    const fetchMock = server(() => ({ body: { success: true, data: {} } }));
    const { user } = renderWithQuery(<CompliancePage />);
    await user.click(await screen.findByRole('button', { name: /Fail — force offline/ }));
    const panel = await screen.findByRole('dialog');
    expect(panel.textContent).toContain('Asha Singh');
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(panel).getByRole('button', { name: 'Fail and force offline' }));
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(0); // the note is required to fail
    await user.type(within(panel).getByRole('textbox', { name: 'Note for the record' }), 'Insurance certificate is a copy of a lapsed policy');
    await user.click(within(panel).getByRole('button', { name: 'Fail and force offline' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(new URL(String(url)).pathname).toBe('/api/v1/admin/compliance/reviews/c1/decide');
    expect(JSON.parse(String(init?.body))).toEqual({ pass: false, note: 'Insurance certificate is a copy of a lapsed policy' });
    expect(new Headers(init?.headers).get('x-swift-reason')).toBe(REASON);
    expect(await screen.findByText(/Re-verification failed: they are offline\./)).toBeTruthy();
  });
});
