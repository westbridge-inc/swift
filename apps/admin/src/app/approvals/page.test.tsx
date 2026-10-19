import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import ApprovalsPage from './page';
import {
  API_ORIGIN,
  mockApi,
  renderWithQuery,
  requestsByMethod,
  type ApiReply,
  type ApiRequest,
} from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [DS110-13 / DS110-14] The second signature sees the STORED body — amount and
// beneficiary, not an opaque id — and an APPROVED row offers exactly one way
// to execute it: the apply endpoint, which replays that same stored body.
// ---------------------------------------------------------------------------

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const APPROVED_WITH_BODY = {
  id: 'ap1',
  action: 'POST /billing/agent-payments/:id/attach',
  cls: 'C4',
  capability: 'billing.payment.attach',
  entityId: 'pay_1',
  fingerprint: 'f'.repeat(64),
  status: 'APPROVED',
  requestedBy: 'admin-1',
  reason: 'The deposit matches this subscription, amount and reference checked.',
  bodySnapshot: { params: { id: 'pay_1' }, body: { amount: 2500, subscriptionId: 'SUB-77', reason: 'the deposit matches' } },
  approvedBy: 'admin-2',
  decisionNote: 'Checked against the agent settlement file.',
  decidedAt: inHours(-1),
  appliedAt: null,
  expiresAt: inHours(12),
  createdAt: inHours(-2),
  // the viewer is the admin who asked; a second admin (admin-2) approved
  isOwnRequest: true,
};

const LEGACY_APPROVED = {
  ...APPROVED_WITH_BODY,
  id: 'ap-legacy',
  bodySnapshot: null,
  entityId: 'pay_legacy',
};

function approvalsHandler(
  mutate?: (_request: ApiRequest) => ApiReply | Promise<ApiReply>,
  approved: unknown[] = [APPROVED_WITH_BODY, LEGACY_APPROVED],
) {
  return (request: ApiRequest): ApiReply | Promise<ApiReply> => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/approvals') {
      const status = request.url.searchParams.get('status') ?? 'PENDING';
      return { body: { success: true, data: status === 'APPROVED' ? approved : [] } };
    }
    if (mutate) return mutate(request);
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
}

describe('the approval card shows what executes', () => {
  it('renders the stored amount and beneficiary, and Apply calls the apply endpoint', async () => {
    const fetchMock = mockApi(
      approvalsHandler((request) => {
        if (request.method === 'POST' && request.url.pathname === '/api/v1/admin/approvals/ap1/apply') {
          return { body: { success: true, data: { id: 'ap1', status: 'APPLIED', appliedAt: inHours(0) } } };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(<ApprovalsPage />);
    await user.click(await screen.findByRole('button', { name: 'Approved' }));

    // the amount and beneficiary come from the stored body, field by field
    expect(await screen.findByText('2500')).toBeTruthy();
    expect(screen.getByText('SUB-77')).toBeTruthy();
    expect(screen.getByText('Amount')).toBeTruthy();
    expect(screen.getByText('Subscription Id')).toBeTruthy();

    // [U63] one click asks first: nothing runs until the panel is confirmed
    await user.click(screen.getByRole('button', { name: 'Execute the approved action' }));
    const panel = await screen.findByRole('dialog');
    expect(panel.textContent).toMatch(/runs the approved request now/);
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(0);
    await user.click(within(panel).getByRole('button', { name: 'Execute it' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    expect(await screen.findByText('Executed.')).toBeTruthy();
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(String(url)).toBe(`${API_ORIGIN}/api/v1/admin/approvals/ap1/apply`);
    expect(init?.method).toBe('POST');
  });

  it('a legacy APPROVED row cannot be executed — there is no stored body to replay', async () => {
    mockApi(approvalsHandler());
    const { user } = renderWithQuery(<ApprovalsPage />);
    await user.click(await screen.findByRole('button', { name: 'Approved' }));

    expect(await screen.findByText(/predates body capture/i)).toBeTruthy();
    // exactly ONE apply button exists (the row that has a body) — the legacy row has none
    expect(screen.getAllByRole('button', { name: 'Execute the approved action' })).toHaveLength(1);
  });

  it('an approved action another admin asked for is theirs to execute — no button here', async () => {
    mockApi(approvalsHandler(undefined, [{ ...APPROVED_WITH_BODY, isOwnRequest: false }]));
    const { user } = renderWithQuery(<ApprovalsPage />);
    await user.click(await screen.findByRole('button', { name: 'Approved' }));

    // the body is still readable, but the server would refuse this admin (403)
    expect(await screen.findByText('2500')).toBeTruthy();
    expect(screen.getByText('Approved. Only the admin who asked can execute it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Execute the approved action' })).toBeNull();
  });

  it('a PENDING row is a decision to make, not an action to execute', async () => {
    mockApi(approvalsHandler());
    renderWithQuery(<ApprovalsPage />);
    expect(await screen.findByText(/Nothing is waiting/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Execute the approved action' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// [OWNER #13] SOLO MODE on your own pending request: the wait and its Cancel,
// starting the wait, and — once it has ended — the decision behind a fresh
// sign-in code. The server re-checks everything; the screen shows where the
// request stands and never skips the code.
// ---------------------------------------------------------------------------

const OWN_PENDING = {
  ...APPROVED_WITH_BODY,
  id: 'ap-solo',
  status: 'PENDING',
  approvedBy: null,
  decisionNote: null,
  decidedAt: null,
  expiresAt: inHours(30),
  isOwnRequest: true,
};

function pendingHandler(row: unknown, mutate: (_request: ApiRequest) => ApiReply | Promise<ApiReply>) {
  return (request: ApiRequest): ApiReply | Promise<ApiReply> => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/approvals') {
      const status = request.url.searchParams.get('status') ?? 'PENDING';
      return { body: { success: true, data: status === 'PENDING' ? [row] : [] } };
    }
    return mutate(request);
  };
}

describe('[OWNER #13] solo approval on your own request', () => {
  it('during the wait: shows when it can be approved, and Cancel withdraws the request', async () => {
    const fetchMock = mockApi(pendingHandler(
      { ...OWN_PENDING, solo: { state: 'waiting', availableAt: inHours(11) } },
      (request) => {
        if (request.method === 'POST' && request.url.pathname === '/api/v1/admin/approvals/ap-solo/cancel') {
          return { body: { success: true, data: { id: 'ap-solo', status: 'CANCELLED' } } };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      },
    ));
    const { user } = renderWithQuery(<ApprovalsPage />);
    expect(await screen.findByText(/^Solo approval: available after /)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve it myself' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Cancel this request' }));
    const panel = await screen.findByRole('dialog');
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(0);
    await user.click(within(panel).getByRole('button', { name: 'Cancel the request' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    expect(String(requestsByMethod(fetchMock, 'POST')[0]![0])).toBe(`${API_ORIGIN}/api/v1/admin/approvals/ap-solo/cancel`);
  });

  it('when solo is available: explains the wait and starts it', async () => {
    const fetchMock = mockApi(pendingHandler(
      { ...OWN_PENDING, solo: { state: 'available', coolOffHours: 12 } },
      (request) => {
        if (request.method === 'POST' && request.url.pathname === '/api/v1/admin/approvals/ap-solo/solo') {
          return { body: { success: true, data: { id: 'ap-solo', soloEligibleAt: inHours(12) } } };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      },
    ));
    const { user } = renderWithQuery(<ApprovalsPage />);
    expect(await screen.findByText(/12-hour wait/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Start the wait to approve it myself' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    expect(String(requestsByMethod(fetchMock, 'POST')[0]![0])).toBe(`${API_ORIGIN}/api/v1/admin/approvals/ap-solo/solo`);
  });

  it('when solo is unavailable: says why, and offers no way round it', async () => {
    mockApi(pendingHandler(
      { ...OWN_PENDING, solo: { state: 'unavailable', why: 'no-email', message: 'Add an email address to your admin account first.' } },
      (request) => { throw new Error(`Unexpected request: ${request.method} ${request.url}`); },
    ));
    renderWithQuery(<ApprovalsPage />);
    expect(await screen.findByText(/Add an email address to your admin account first/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start the wait to approve it myself' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve it myself' })).toBeNull();
  });

  it('after the wait: the server asks for a fresh code; the code is sent, confirmed, and the decision goes again', async () => {
    let decideCalls = 0;
    const fetchMock = mockApi(pendingHandler(
      { ...OWN_PENDING, solo: { state: 'ready', availableAt: inHours(-1) } },
      (request) => {
        const path = request.url.pathname;
        if (request.method === 'POST' && path === '/api/v1/admin/approvals/ap-solo/decide') {
          decideCalls += 1;
          return decideCalls === 1
            ? { status: 403, body: { success: false, error: { code: 'STEP_UP_REQUIRED', message: 'Confirm it’s you first' } } }
            : { body: { success: true, data: { id: 'ap-solo', status: 'APPROVED' } } };
        }
        if (request.method === 'POST' && path === '/api/v1/auth/step-up') {
          return { body: { success: true, data: { sentTo: '+592•••••0000', validForSeconds: 300 } } };
        }
        if (request.method === 'POST' && path === '/api/v1/auth/step-up/verify') {
          return { body: { success: true, data: { validForSeconds: 600 } } };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      },
    ));
    const { user } = renderWithQuery(<ApprovalsPage />);
    expect(await screen.findByText(/^Solo approval: available now/)).toBeTruthy();
    await user.type(screen.getByPlaceholderText(/still right after the wait/), 'Checked the numbers again this morning');
    await user.click(screen.getByRole('button', { name: 'Approve it myself' }));

    expect(await screen.findByText('Confirm it is you')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Send me a code' }));
    await user.type(screen.getByLabelText('Sign-in code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirm and approve' }));

    await waitFor(() => expect(decideCalls).toBe(2));
    const paths = requestsByMethod(fetchMock, 'POST').map(([url]) => new URL(String(url)).pathname);
    expect(paths).toEqual([
      '/api/v1/admin/approvals/ap-solo/decide',
      '/api/v1/auth/step-up',
      '/api/v1/auth/step-up/verify',
      '/api/v1/admin/approvals/ap-solo/decide',
    ]);
    const verifyBody = JSON.parse(String(requestsByMethod(fetchMock, 'POST')[2]![1]?.body));
    expect(verifyBody).toEqual({ code: '123456' });
  });
});

describe('[DS1111] your own decided request does not tell you it needs a second person', () => {
  it('an APPROVED own row offers Execute, without the "needs a second person" copy', async () => {
    mockApi(approvalsHandler(undefined, [{ ...APPROVED_WITH_BODY, decidedSolo: true, approvedBy: 'admin-1' }]));
    const { user } = renderWithQuery(<ApprovalsPage />);
    await user.click(await screen.findByRole('button', { name: 'Approved' }));
    expect(await screen.findByRole('button', { name: 'Execute the approved action' })).toBeTruthy();
    expect(screen.getByText(/Approved in solo mode/)).toBeTruthy();
    expect(screen.queryByText(/needs a second person/)).toBeNull();
  });
});
