import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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

    await user.click(screen.getByRole('button', { name: 'Execute the approved action' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
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
