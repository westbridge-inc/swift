import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import UserDetailPage from './page';
import { fulfilledParams, mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// Someone who cannot sign in is told to email us to delete their account. The owner can now act on a verified request
// from the person's page; the server keeps every rule, and this page offers the door only where it can work.

const person = (over: Record<string, unknown> = {}) => ({
  id: 'user-1', firstName: 'Mina', lastName: 'Person', phone: '•••••4567', email: null, status: 'ACTIVE', roles: ['CUSTOMER'],
  createdAt: '2026-08-01T00:00:00.000Z', lastActiveAt: null, isPhoneVerified: true, orders: [], strikes: [], addresses: [],
  _count: { orders: 0, strikes: 0 }, rider: null, driver: null, vendorOwner: null, ...over,
});

const REASON = 'Verified request by email, the person lost their phone';
const NOTE = 'Code texted to the account number came back by email';

function page(superAdmin: boolean | undefined, over: Record<string, unknown> = {}, onDelete?: (_request: ApiRequest) => { status?: number; body: unknown }) {
  const fetchMock = mockApi((request) => {
    if (request.url.pathname === '/api/v1/admin/users/user-1/verified-deletion') return onDelete?.(request) ?? { body: { success: true, data: { outcome: { deleted: true } } } };
    return { body: { success: true, data: person({ ...(superAdmin === undefined ? {} : { viewer: { superAdmin } }), ...over }) } };
  });
  const view = renderWithQuery(<UserDetailPage params={fulfilledParams({ id: 'user-1' })} />);
  return { fetchMock, ...view };
}

const deleteCalls = (fetchMock: ReturnType<typeof mockApi>) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/verified-deletion'));

async function fill(user: ReturnType<typeof page>['user'], note = NOTE) {
  await user.click(await screen.findByRole('button', { name: 'Delete account…' }));
  const panel = await screen.findByRole('dialog');
  await user.click(within(panel).getByRole('radio', { name: 'A code sent to the number on the account' }));
  fireEvent.change(within(panel).getByRole('textbox', { name: 'What was done' }), { target: { value: note } });
  fireEvent.change(within(panel).getByRole('textbox', { name: /reason/i }), { target: { value: REASON } });
  await user.click(within(panel).getByRole('button', { name: 'Ask to delete account' }));
  return panel;
}

describe('the verified deletion door on a person', () => {
  it('a super admin sees it and sends what was checked, with the reason', async () => {
    const { fetchMock, user } = page(true);
    await fill(user);
    await waitFor(() => expect(deleteCalls(fetchMock)).toHaveLength(1));
    const [, init] = deleteCalls(fetchMock)[0]!;
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ identityCheck: 'CODE_TO_ACCOUNT_NUMBER', identityNote: NOTE, reason: REASON });
    expect(await screen.findByText('Account closed.')).toBeTruthy();
  });

  it('an admin does not', async () => {
    page(false);
    await screen.findByRole('heading', { name: 'Profiles' });
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(screen.queryByRole('button', { name: 'Delete account…' })).toBeNull();
  });

  it('a server that does not say who is looking: it is not offered', async () => {
    page(undefined);
    await screen.findByRole('heading', { name: 'Profiles' });
    expect(screen.queryByRole('button', { name: 'Delete account…' })).toBeNull();
  });

  it.each([
    ['a staff account', { roles: ['ADMIN', 'CUSTOMER'] }],
    ['an account already closed', { status: 'DEACTIVATED' }],
    ['a banned account', { status: 'BANNED' }],
  ])('not on %s', async (_what, over) => {
    page(true, over);
    await screen.findByRole('heading', { name: 'Profiles' });
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(screen.queryByRole('button', { name: 'Delete account…' })).toBeNull();
  });

  it.each([
    ['a number long enough to be an ID', 'Passport 123456 matched the name'],
    ['a phone written with spaces', 'They answered on 600 1234 and agreed'],
    ['an email address', 'They wrote from someone@example.com'],
  ])('%s is refused in the panel and nothing is sent', async (_what, note) => {
    const { fetchMock, user } = page(true);
    const panel = await fill(user, note);
    expect(await within(panel).findByText(/no ID or phone numbers/i)).toBeTruthy();
    expect(deleteCalls(fetchMock)).toHaveLength(0);
  });

  it('says it waits for approval when the server queues it', async () => {
    const { user } = page(true, {}, () => ({ status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this before it happens. It is in the approvals queue.', details: { approvalId: 'a1' } } } }));
    await fill(user);
    expect(await screen.findByText(/approvals queue/i)).toBeTruthy();
  });

  it('a blocker the server names stays in the panel', async () => {
    const { user } = page(true, {}, () => ({ status: 409, body: { success: false, error: { code: 'ACCOUNT_DELETION_BLOCKED', message: 'There is a live order on this account.' } } }));
    const panel = await fill(user);
    expect(await within(panel).findByText(/There is a live order/)).toBeTruthy();
  });
});
