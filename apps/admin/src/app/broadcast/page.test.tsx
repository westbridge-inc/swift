import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import BroadcastPage from './page';
import { mockApi, renderWithQuery, requestsByMethod, type ApiReply, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [U05] A broadcast needs a second admin (202 APPROVAL_REQUIRED), but the page
// said "Send failed — try again"; trying again filed a second approval, and if
// both were approved everyone got the message twice. The answer is now shown
// as what it is (queued), and the draft is cleared so nothing is left to press
// twice. A real refusal is still shown as a refusal.
// ---------------------------------------------------------------------------

const REASON = 'Planned maintenance notice agreed with operations';

function server(reply: () => ApiReply) {
  return mockApi((r: ApiRequest) => {
    if (r.method === 'POST' && r.url.pathname === '/api/v1/admin/notifications/broadcast') return reply();
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
}

async function compose(user: ReturnType<typeof renderWithQuery>['user']) {
  await user.type(screen.getByLabelText('Title (max 150)'), 'Maintenance tonight');
  await user.type(screen.getByLabelText('Message (max 1000)'), 'Swift is down for ten minutes at midnight.');
  await user.click(screen.getByRole('button', { name: /^Send to / }));
  const panel = await screen.findByRole('dialog');
  expect(panel.textContent).toContain('Maintenance tonight');
  await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), REASON);
  await user.click(within(panel).getByRole('button', { name: /^Send to / }));
  return panel;
}

describe('[U05] a broadcast shows "queued" honestly, and can never be asked twice', () => {
  it('a 202 reads as waiting for a second admin, never "Send failed"; the draft is cleared and Send is off', async () => {
    const fetchMock = server(() => ({ status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this before it happens.', details: { approvalId: 'apr_b1' } } } }));
    const { user } = renderWithQuery(<BroadcastPage />);
    await compose(user);

    expect(await screen.findByText(/Sent for a second admin.s approval/)).toBeTruthy();
    expect(screen.queryByText(/Send failed/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByLabelText('Title (max 150)') as HTMLInputElement).value).toBe('');
    const send = screen.getByRole('button', { name: /^Send to / }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await user.click(send);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1);
    const init = requestsByMethod(fetchMock, 'POST')[0]![1];
    expect(JSON.parse(String(init?.body))).toEqual({ title: 'Maintenance tonight', body: 'Swift is down for ten minutes at midnight.', category: 'service' });
    expect(new Headers(init?.headers).get('x-swift-reason')).toBe(REASON);
  });

  it('a second ask the server refuses because the first still stands also reads as waiting', async () => {
    server(() => ({ status: 409, body: { success: false, error: { code: 'APPROVAL_ALREADY_OPEN', message: 'This is already waiting for a second admin in Approvals.', details: { approvalId: 'apr_b1', approvalStatus: 'PENDING', askedByYou: true } } } }));
    const { user } = renderWithQuery(<BroadcastPage />);
    await compose(user);
    expect(await screen.findByText(/Already waiting for a second admin.s approval/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a real refusal stays in the panel with the draft kept, to fix or cancel', async () => {
    server(() => ({ status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message: 'Title is too long' } } }));
    const { user } = renderWithQuery(<BroadcastPage />);
    const panel = await compose(user);
    expect((await within(panel).findByRole('alert')).textContent).toContain('Title is too long');
    await user.click(within(panel).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((screen.getByLabelText('Title (max 150)') as HTMLInputElement).value).toBe('Maintenance tonight');
  });
});
