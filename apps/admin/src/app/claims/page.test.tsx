import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
  await user.click(await screen.findByRole('button', { name: 'approved' }));
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
    // [A-11] two prompts per attempt now: the reference, then the amount the
    // payer actually transferred. A cancelled reference still stops there.
    const prompt = vi
      .fn()
      .mockReturnValueOnce(null)                    // click 1: reference cancelled
      .mockReturnValueOnce('  PAY-REF-TARGET  ')    // click 2: reference
      .mockReturnValueOnce('  3400  ')              // click 2: amount
      .mockReturnValueOnce('  PAY-REF-TARGET  ')    // click 3: reference
      .mockReturnValueOnce('  3400  ');             // click 3: amount
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('prompt', prompt);
    vi.stubGlobal('confirm', confirm);
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
    expect(confirm).not.toHaveBeenCalled();
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);

    await user.click(targetButton);
    expect(confirm).toHaveBeenNthCalledWith(
      1,
      'Mark this $3,400 claim for order order-target as PAID? Reference PAY-REF-TARGET, amount sent 3400.',
    );
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);

    await user.click(targetButton);
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(confirm).toHaveBeenNthCalledWith(
      2,
      'Mark this $3,400 claim for order order-target as PAID? Reference PAY-REF-TARGET, amount sent 3400.',
    );
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/cash-rules/claims/claim-target/paid`);
    expect(init?.method).toBe('PUT');
    // the amount rides with the reference — the server refuses a payout that
    // does not name the figure actually sent
    expect(JSON.parse(String(init?.body))).toEqual({ reference: 'PAY-REF-TARGET', amount: '3400' });
  });

  it('surfaces the claim state rejection in the server own words without fake success', async () => {
    vi.stubGlobal('prompt', vi.fn().mockReturnValue('PAY-REF-REJECTED'));
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
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

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Payout did not record: Claim is PAID; expected AUTO_APPROVED/APPROVED',
    );
    expect(screen.getByText('$3,400')).toBeTruthy();
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);
    expect(claimReads(fetchMock)).toHaveLength(2);
  });

  it('disables payout controls while pending and cannot double-fire the money mutation', async () => {
    const pending = deferredReply();
    vi.stubGlobal('prompt', vi.fn().mockReturnValue('PAY-REF-ONCE'));
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
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
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    expect((paidButton as HTMLButtonElement).disabled).toBe(true);

    await user.click(paidButton!);
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);

    pending.resolve({ body: { success: true, data: { ...targetClaim, status: 'PAID' } } });
    await waitFor(() => expect(claimReads(fetchMock)).toHaveLength(3));
  });
});

describe('[DOC-1 §31.4] the reserve line and the evidence bundle', () => {
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
    await user.click(await screen.findByRole('button', { name: 'approved' }));
    const bundle = await screen.findByTestId('evidence-claim-bundle');
    expect(bundle.textContent).toContain('door photo — missing');
    expect(bundle.textContent).toContain('rider at door ✓');
    expect(bundle.textContent).toContain('customer contacted (optional)');
    expect(bundle.textContent).toContain('bundle incomplete');
  });
});

