import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  return screen.findAllByRole('button', { name: 'Mark paid…' });
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

const REASON = 'Payout matches the claim evidence on file';

/** [MC-MONEY] Fills the payout panel: reference, amount, reason; then sends. */
async function fillPayout(user: ReturnType<typeof renderWithQuery>['user'], dialog: HTMLElement, reference: string, amount: string) {
  await user.type(within(dialog).getByRole('textbox', { name: 'Payment reference' }), reference);
  await user.type(within(dialog).getByRole('textbox', { name: 'Amount you transferred' }), amount);
  await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
  await user.click(within(dialog).getByRole('button', { name: 'Mark paid' }));
}

beforeEach(() => {
  // [MC-MONEY] no browser prompt is ever the way in
  vi.stubGlobal('prompt', vi.fn(() => { throw new Error('window.prompt was called'); }));
  vi.stubGlobal('confirm', vi.fn(() => { throw new Error('window.confirm was called'); }));
});
afterEach(() => vi.unstubAllGlobals());

describe('claim payout mutation', () => {
  it('requires evidence, names the visible claim, and pays the exact claim id', async () => {
    // [A-11] a payout carries the reference AND the amount the payer actually
    // transferred. [MC-MONEY] Both are fields of the one panel, checked before
    // anything is sent; a cancelled panel sends nothing.
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
    let dialog = screen.getByRole('dialog', { name: 'Mark this $3,400 claim paid?' });
    expect(dialog.textContent).toContain('Order order-target.');
    // nothing typed: refused beside the fields, nothing sent
    await user.click(within(dialog).getByRole('button', { name: 'Mark paid' }));
    expect(within(dialog).getByText(/Enter the reference/)).toBeTruthy();
    expect(within(dialog).getByText(/Enter the amount/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);

    await user.click(targetButton);
    dialog = screen.getByRole('dialog', { name: 'Mark this $3,400 claim paid?' });
    await fillPayout(user, dialog, '  pay-ref-target  ', '  3400  ');
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/cash-rules/claims/claim-target/paid`);
    expect(init?.method).toBe('PUT');
    // the amount rides with the reference — the server refuses a payout that
    // does not name the figure actually sent
    expect(JSON.parse(String(init?.body))).toEqual({ reference: 'PAY-REF-TARGET', amount: 3400 });
    expect((init?.headers as Record<string, string>)['x-swift-reason']).toBe(REASON);
    expect((await screen.findByRole('status')).textContent).toContain('The $3,400 claim is paid.');
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
    const dialog = screen.getByRole('dialog');
    // the amount sent is the amount the payer typed — never the claim's own
    // figure filled in by the console, which would make the attestation empty
    await fillPayout(user, dialog, 'PAY-REF-REJECTED', '3000');
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    expect(JSON.parse(String(requestsByMethod(fetchMock, 'PUT')[0]![1]?.body))).toEqual({ reference: 'PAY-REF-REJECTED', amount: 3000 });

    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'Claim is PAID; expected AUTO_APPROVED/APPROVED',
    );
    // the typed evidence is still there to correct
    expect((within(dialog).getByRole('textbox', { name: 'Payment reference' }) as HTMLInputElement).value).toBe('PAY-REF-REJECTED');
    expect(screen.getByText('$3,400')).toBeTruthy();
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);
    expect(claimReads(fetchMock)).toHaveLength(2);
    expect(screen.queryByText('The $3,400 claim is paid.')).toBeNull();
  });

  it('locks the panel while pending and cannot double-fire the money mutation', async () => {
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
    const dialog = screen.getByRole('dialog');
    await fillPayout(user, dialog, 'PAY-REF-ONCE', '3400');
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const sending = within(dialog).getByRole('button', { name: 'Sending…' }) as HTMLButtonElement;
    expect(sending.disabled).toBe(true);
    await user.click(sending);
    await user.click(paidButton!);
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);

    pending.resolve({ body: { success: true, data: { ...targetClaim, status: 'PAID' } } });
    await waitFor(() => expect(claimReads(fetchMock)).toHaveLength(3));
  });

  it('approving and rejecting each ask why in the panel, naming the amount — a 202 says it went to a second admin', async () => {
    const pendingClaim = { ...targetClaim, status: 'PENDING_REVIEW' };
    const fetchMock = mockApi((request: ApiRequest) => {
      if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/cash-rules/claims') return { body: { success: true, data: [pendingClaim] } };
      if (request.method === 'GET') return claimsHandler(() => ({ body: {} }))(request);
      return { status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this.', details: { approvalId: 'apr_1' } } } };
    });
    const { user } = renderWithQuery(<ClaimsPage />);
    await user.click(await screen.findByRole('button', { name: 'Approve…' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this $3,400 claim?' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Approve claim' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    expect(String(requestsByMethod(fetchMock, 'PUT')[0]![0])).toContain('/cash-rules/claims/claim-target/approve');
    expect((await screen.findByRole('status')).textContent).toContain("Sent for a second admin's approval");

    await user.click(screen.getByRole('button', { name: 'Reject…' }));
    const reject = screen.getByRole('dialog', { name: 'Reject this $3,400 claim?' });
    await user.click(within(reject).getByRole('button', { name: 'Cancel' }));
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);
  });
});

describe('[MC-MONEY] the reserve line entry', () => {
  it('takes a signed amount and a note in the panel, and sends both with the reason', async () => {
    const fetchMock = mockApi(claimsHandler((request) => {
      if (request.method === 'POST' && request.url.pathname === '/api/v1/admin/cash-rules/rlp/reserve/adjust') {
        return { status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this.', details: { approvalId: 'apr_2' } } } };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    }));
    const { user } = renderWithQuery(<ClaimsPage />);
    await user.click(await screen.findByRole('button', { name: 'Adjust reserve…' }));
    const dialog = screen.getByRole('dialog', { name: 'Record an entry on the GY reserve line?' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Amount' }), '-500');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Seed entry was entered twice on 1 Sep');
    await user.click(within(dialog).getByRole('button', { name: 'Record entry' }));
    expect(within(dialog).getByText('Enter note.')).toBeTruthy();
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(0);
    await user.type(within(dialog).getByRole('textbox', { name: 'Note' }), 'Duplicate seed corrected');
    await user.click(within(dialog).getByRole('button', { name: 'Record entry' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    expect(JSON.parse(String(requestsByMethod(fetchMock, 'POST')[0]![1]?.body))).toEqual({ countryCode: 'GY', amount: -500, note: 'Duplicate seed corrected' });
    expect((await screen.findByRole('status')).textContent).toContain("Sent for a second admin's approval");
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
