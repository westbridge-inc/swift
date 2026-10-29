import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ClaimsPage from './page';
import {
  API_ORIGIN,
  mockApi,
  renderWithQuery,
  requestsByMethod,
  type ApiReply,
  type ApiRequest,
} from '@/test/test-utils';

const firstClaim = {
  id: 'claim-other',
  orderId: 'order-other',
  amount: 1200,
  status: 'APPROVED',
  reason: 'CUSTOMER_NO_SHOW',
  flags: [],
  gpsLat: 6.8013,
  gpsLng: -58.1551,
  photoUrl: null,
  createdAt: '2026-08-01T00:00:00.000Z',
};

const targetClaim = {
  ...firstClaim,
  id: 'claim-target',
  orderId: 'order-target',
  amount: 3400,
  reason: 'CUSTOMER_REFUSED',
};

function claimsHandler(
  mutation: (_request: ApiRequest) => ApiReply | Promise<ApiReply>,
  approvedClaims = [firstClaim, targetClaim],
) {
  return (request: ApiRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/cash-rules/claims') {
      const status = request.url.searchParams.get('status');
      return {
        body: {
          success: true,
          data: status === 'APPROVED' ? approvedClaims : [],
        },
      };
    }
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/cash-rules/rlp/reserve') {
      return { body: { success: true, data: { countryCode: 'GY', balance: 12000, floor: 52250, low: true, provisionedThisPeriod: false, entries: [{ id: 'e1', kind: 'ADJUSTMENT', amount: '12000', periodKey: null, claimId: null, note: 'seed', createdAt: '2026-09-01T00:00:00.000Z' }] } } };
    }
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/cash-rules/metrics') {
      return {
        body: {
          success: true,
          data: {
            failedPaymentPct: 0,
            guaranteePayoutsThisWeek: { total: 0, count: 0 },
            claimsByRider: [],
          },
        },
      };
    }
    return mutation(request);
  };
}

async function showApprovedClaims(user: ReturnType<typeof renderWithQuery>['user']) {
  await user.click(within(await screen.findByRole('group', { name: 'Show claims' })).getByRole('button', { name: 'Approved' }));
  return screen.findAllByRole('button', { name: 'Mark paid' });
}

function claimReads(fetchMock: ReturnType<typeof mockApi>) {
  return requestsByMethod(fetchMock, 'GET').filter(([url]) =>
    String(url).includes('/api/v1/admin/cash-rules/claims?'),
  );
}

function deferredReply() {
  let resolve!: (_reply: ApiReply) => void;
  const promise = new Promise<ApiReply>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('claim payout mutation', () => {
  it('requires evidence, confirms the visible claim, and pays the exact claim id', async () => {
    // [A-11] the panel asks for the reference AND the amount the payer actually
    // transferred, naming the claim first. Closing it stops there.
    const fetchMock = mockApi(
      claimsHandler((request) => {
        if (
          request.method === 'PUT' &&
          request.url.pathname === '/api/v1/admin/cash-rules/claims/claim-target/paid'
        ) {
          return { body: { success: true, data: { ...targetClaim, status: 'PAID' } } };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(<ClaimsPage />);
    const paidButtons = await showApprovedClaims(user);
    const targetButton = paidButtons[1]!;

    await user.click(targetButton);
    let panel = await screen.findByRole('dialog');
    expect(panel.textContent).toContain('$3,400');
    expect(panel.textContent).toContain('order-target');
    await user.click(within(panel).getByRole('button', { name: 'Cancel' }));
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);

    // a missing amount sends nothing
    await user.click(targetButton);
    panel = await screen.findByRole('dialog');
    await user.type(within(panel).getByLabelText(/Payment reference/), '  PAY-REF-TARGET  ');
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), '  Payout matches the claim evidence  ');
    await user.click(within(panel).getByRole('button', { name: 'Mark paid' }));
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);

    await user.type(within(panel).getByLabelText(/Amount you actually transferred/), '  3400  ');
    await user.click(within(panel).getByRole('button', { name: 'Mark paid' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/cash-rules/claims/claim-target/paid`);
    expect(init?.method).toBe('PUT');
    // the amount rides with the reference — the server refuses a payout that
    // does not name the figure actually sent; it is what was typed, never pre-filled
    expect(JSON.parse(String(init?.body))).toEqual({ reference: 'PAY-REF-TARGET', amount: 3400 });
    expect(await screen.findByText('Payout recorded.')).toBeTruthy();
  });

  it('surfaces the claim state rejection in the server own words without fake success', async () => {
    const fetchMock = mockApi(
      claimsHandler((request) => {
        if (
          request.method === 'PUT' &&
          request.url.pathname === '/api/v1/admin/cash-rules/claims/claim-target/paid'
        ) {
          return {
            status: 400,
            body: {
              success: false,
              error: {
                code: 'INVALID_CLAIM_STATE',
                message: 'Claim is PAID; expected AUTO_APPROVED/APPROVED',
              },
            },
          };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(<ClaimsPage />);
    const paidButtons = await showApprovedClaims(user);

    await user.click(paidButtons[1]!);
    const panel = await screen.findByRole('dialog');
    await user.type(within(panel).getByLabelText(/Payment reference/), 'PAY-REF-REJECTED');
    await user.type(within(panel).getByLabelText(/Amount you actually transferred/), '3400');
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), 'Payout matches the claim evidence');
    await user.click(within(panel).getByRole('button', { name: 'Mark paid' }));

    expect((await within(panel).findByRole('alert')).textContent).toContain('Claim is PAID; expected AUTO_APPROVED/APPROVED');
    expect(screen.queryByText('Payout recorded.')).toBeNull();
    expect(screen.getByText('$3,400')).toBeTruthy();
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);
    expect(claimReads(fetchMock)).toHaveLength(2);
  });

  it('disables payout controls while pending and cannot double-fire the money mutation', async () => {
    const pending = deferredReply();
    const fetchMock = mockApi(
      claimsHandler((request) => {
        if (
          request.method === 'PUT' &&
          request.url.pathname === '/api/v1/admin/cash-rules/claims/claim-target/paid'
        ) {
          return pending.promise;
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }, [targetClaim]),
    );
    const { user } = renderWithQuery(<ClaimsPage />);
    const [paidButton] = await showApprovedClaims(user);

    await user.click(paidButton!);
    const panel = await screen.findByRole('dialog');
    await user.type(within(panel).getByLabelText(/Payment reference/), 'PAY-REF-ONCE');
    await user.type(within(panel).getByLabelText(/Amount you actually transferred/), '3400');
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), 'Payout matches the claim evidence');
    const send = within(panel).getByRole('button', { name: 'Mark paid' });
    await user.click(send);
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    expect((within(panel).getByRole('button', { name: 'Sending…' }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(within(panel).getByRole('button', { name: 'Sending…' }));
    await user.click(paidButton!);
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);

    pending.resolve({ body: { success: true, data: { ...targetClaim, status: 'PAID' } } });
    await waitFor(() => expect(claimReads(fetchMock)).toHaveLength(3));
  });

  it('[U28] a 202 is the queued answer, never a red failure, and the claim cannot be asked twice', async () => {
    const fetchMock = mockApi(
      claimsHandler((request) => {
        if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/cash-rules/claims/claim-target/paid') {
          return { status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this before it happens.', details: { approvalId: 'apr_c1' } } } };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }, [targetClaim]),
    );
    const { user } = renderWithQuery(<ClaimsPage />);
    const [paidButton] = await showApprovedClaims(user);
    await user.click(paidButton!);
    const panel = await screen.findByRole('dialog');
    await user.type(within(panel).getByLabelText(/Payment reference/), 'PAY-REF-Q1');
    await user.type(within(panel).getByLabelText(/Amount you actually transferred/), '3400');
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), 'Payout matches the claim evidence');
    await user.click(within(panel).getByRole('button', { name: 'Mark paid' }));

    const queued = await screen.findAllByRole('status');
    expect(queued.map((n) => n.textContent).join(' ')).toContain("Sent for a second admin's approval");
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/did not record/)).toBeNull();
    expect(((await screen.findByRole('button', { name: 'Mark paid' })) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Mark paid' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);
  });
});

describe('[DOC-1 §31.4] the reserve line and the evidence bundle', () => {
  it.each([
    ['-4500', -4500],
    ['4500', 4500],
  ])('[REVIEW-F2 S3-2] a reserve entry typed as %s reaches the server as %d (a minus corrects downwards)', async (typed, sent) => {
    const fetchMock = mockApi(claimsHandler((request) => {
      if (request.method === 'POST' && request.url.pathname === '/api/v1/admin/cash-rules/rlp/reserve/adjust') {
        return { body: { success: true, data: { id: 'e2' } } };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    }));
    const { user } = renderWithQuery(<ClaimsPage />);
    await user.click(await screen.findByRole('button', { name: 'Adjust reserve' }));
    const panel = await screen.findByRole('dialog');
    await user.type(within(panel).getByLabelText(/Adjust the reserve by/), typed);
    await user.type(within(panel).getByLabelText(/Note recorded with the entry/), 'Statement correction');
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), 'Reserve matches the bank statement');
    await user.click(within(panel).getByRole('button', { name: 'Record entry' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(String(url)).toBe(`${API_ORIGIN}/api/v1/admin/cash-rules/rlp/reserve/adjust`);
    expect(JSON.parse(String(init?.body))).toEqual({ countryCode: 'GY', amount: sent, note: 'Statement correction' });
  });

  it('shows the reserve balance, its floor and the below-floor warning; a claim renders its bundle with the missing item named', async () => {
    const withBundle = {
      ...targetClaim,
      id: 'claim-bundle',
      evidenceComplete: false,
      evidence: { complete: false, missing: ['door_photo'], items: [
        { key: 'rider_at_door', present: true, required: true },
        { key: 'door_photo', present: false, required: true },
        { key: 'customer_contacted', present: false, required: false },
      ] },
    };
    mockApi(claimsHandler(() => ({ body: { success: true, data: {} } }), [withBundle]));
    const { user } = renderWithQuery(<ClaimsPage />);
    const reserve = await screen.findByTestId('rlp-reserve');
    await waitFor(() => expect(reserve.textContent).toContain('12,000'));
    expect(reserve.textContent).toContain('BELOW FLOOR');
    await user.click(within(await screen.findByRole('group', { name: 'Show claims' })).getByRole('button', { name: 'Approved' }));
    const bundle = await screen.findByTestId('evidence-claim-bundle');
    expect(bundle.textContent).toContain('door photo — missing');
    expect(bundle.textContent).toContain('rider at door ✓');
    expect(bundle.textContent).toContain('customer contacted (optional)');
    expect(bundle.textContent).toContain('bundle incomplete');
  });
});
