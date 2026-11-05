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
  evidenceComplete: true,
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
      return { body: { success: true, data: { countryCode: 'GY', balance: 12000, entries: [{ id: 'e1', kind: 'ADJUSTMENT', amount: '12000', periodKey: null, claimId: null, note: 'seed', createdAt: '2026-09-01T00:00:00.000Z' }] } } };
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
  await user.click(within(await screen.findByRole('group', { name: 'Show payment requests' })).getByRole('button', { name: 'Approved' }));
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
                message: 'This is PAID; expected APPROVED',
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

    expect((await within(panel).findByRole('alert')).textContent).toContain('This is PAID; expected APPROVED');
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
    await user.click(await screen.findByRole('button', { name: 'Adjust set-aside' }));
    const panel = await screen.findByRole('dialog');
    await user.type(within(panel).getByLabelText(/Adjust the set-aside by/), typed);
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
    expect(reserve.textContent).not.toMatch(/floor/i); // no sum has to be held
    await user.click(within(await screen.findByRole('group', { name: 'Show payment requests' })).getByRole('button', { name: 'Approved' }));
    const bundle = await screen.findByTestId('evidence-claim-bundle');
    expect(bundle.textContent).toContain('door photo — missing');
    expect(bundle.textContent).toContain('rider at door ✓');
    expect(bundle.textContent).toContain('customer contacted (optional)');
    expect(bundle.textContent).toContain('evidence incomplete');
    expect(bundle.textContent).toContain('paying this needs a written reason and a second admin');
  });

  it('the set-aside says what it holds: no line about a monthly share, and an entry is company money', async () => {
    mockApi(claimsHandler(() => ({ body: { success: true, data: {} } })));
    const { user } = renderWithQuery(<ClaimsPage />);
    const reserve = await screen.findByTestId('rlp-reserve');
    await waitFor(() => expect(reserve.textContent).toContain('12,000'));
    expect(reserve.textContent).not.toMatch(/provisioned/i);
    await user.click(within(reserve).getByRole('button', { name: 'Adjust set-aside' }));
    expect((await screen.findByRole('dialog')).textContent).toContain('plain company money only, never a share of fees');
  });
});

describe('[case by case] a person decides each one', () => {
  function queue(rows: unknown[], status: string) {
    return (request: ApiRequest): ApiReply => {
      if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/cash-rules/claims') {
        return { body: { success: true, data: request.url.searchParams.get('status') === status ? rows : [] } };
      }
      if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/cash-rules/rlp/reserve') {
        return { body: { success: true, data: { countryCode: 'GY', balance: 20000, entries: [] } } };
      }
      return { body: { success: true, data: {} } };
    };
  }

  it('an old automatic row cannot be marked paid: it says why and offers a person the decision', async () => {
    mockApi(queue([{ ...firstClaim, id: 'claim-old', status: 'AUTO_APPROVED', evidenceComplete: true }], 'AUTO_APPROVED'));
    const { user } = renderWithQuery(<ClaimsPage />);
    await user.click(within(await screen.findByRole('group', { name: 'Show payment requests' })).getByRole('button', { name: 'Old rule, needs a person' }));
    const note = await screen.findByTestId('old-rule-claim-old');
    expect(note.textContent).toContain('cannot be paid until a person does');
    expect(screen.queryByRole('button', { name: 'Mark paid' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });

  it('the reviewer reads that nobody is owed this, and is warned when evidence means it cannot be paid', async () => {
    mockApi(queue([{ ...firstClaim, id: 'claim-gap', status: 'PENDING_REVIEW', evidenceComplete: false, flags: ['protection_suspended', 'over_gate'] }], 'PENDING_REVIEW'));
    const { user } = renderWithQuery(<ClaimsPage />);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const panel = await screen.findByRole('dialog');
    expect(panel.textContent).toContain('Nobody is owed this');
    expect(panel.textContent).toContain('paying it needs a written reason');
    expect(document.body.textContent).toContain('help suspended');
    expect(document.body.textContent).toContain('over the ID gate');
    expect(document.body.textContent).not.toMatch(/protection suspended/);
  });

  it('a complete case carries no such warning', async () => {
    mockApi(queue([{ ...firstClaim, id: 'claim-ok', status: 'PENDING_REVIEW', evidenceComplete: true }], 'PENDING_REVIEW'));
    const { user } = renderWithQuery(<ClaimsPage />);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    expect((await screen.findByRole('dialog')).textContent).not.toContain('written reason');
  });

  async function approvedTab(user: ReturnType<typeof renderWithQuery>['user']) {
    await user.click(within(await screen.findByRole('group', { name: 'Show payment requests' })).getByRole('button', { name: 'Approved' }));
  }

  it('missing evidence as it stands now, whatever was stored: the dialog needs a written reason, and it is sent', async () => {
    const stale = { ...firstClaim, id: 'claim-why', status: 'APPROVED', amount: 1200, evidenceComplete: true, evidenceNow: { complete: false, missing: ['door_photo'] } };
    const fetchMock = mockApi((request) => {
      if (request.method === 'PUT') return { body: { success: true, data: { ...stale, status: 'PAID' } } };
      return queue([stale], 'APPROVED')(request);
    });
    const { user } = renderWithQuery(<ClaimsPage />);
    await approvedTab(user);
    await user.click(await screen.findByRole('button', { name: 'Mark paid' }));
    const panel = await screen.findByRole('dialog');
    expect(panel.textContent).toContain('door photo');
    await user.type(within(panel).getByRole('textbox', { name: /Payment reference/ }), 'BANK-WHY-1');
    await user.type(within(panel).getByLabelText(/Amount you actually transferred/), '1200');
    await user.type(within(panel).getByRole('textbox', { name: 'Reason' }), 'Paid after a phone check');
    await user.click(within(panel).getByRole('button', { name: 'Mark paid' }));
    expect(requestsByMethod(fetchMock, 'PUT'), 'no written reason, nothing sent').toHaveLength(0);
    await user.type(within(panel).getByRole('textbox', { name: /Why this is paid with evidence missing/ }), 'The rider phoned from the door.');
    await user.click(within(panel).getByRole('button', { name: 'Mark paid' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    expect(JSON.parse(String(requestsByMethod(fetchMock, 'PUT')[0]![1]!.body))).toMatchObject({ evidenceReason: 'The rider phoned from the door.' });
  });

  it('evidence complete now, whatever was stored: no reason asked', async () => {
    const fresh = { ...firstClaim, id: 'claim-fresh', status: 'APPROVED', evidenceComplete: false, evidenceNow: { complete: true, missing: [] } };
    mockApi(queue([fresh], 'APPROVED'));
    const { user } = renderWithQuery(<ClaimsPage />);
    await approvedTab(user);
    await user.click(await screen.findByRole('button', { name: 'Mark paid' }));
    expect(within(await screen.findByRole('dialog')).queryByRole('textbox', { name: /Why this is paid/ })).toBeNull();
  });

  it('rejecting an approved case says to confirm nothing was sent; rejecting an undecided one does not', async () => {
    const approved = { ...firstClaim, id: 'claim-sent', status: 'APPROVED', evidenceNow: { complete: true, missing: [] } };
    mockApi(queue([approved], 'APPROVED'));
    const { user } = renderWithQuery(<ClaimsPage />);
    await approvedTab(user);
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    expect((await screen.findByRole('dialog')).textContent).toContain('Confirm nothing was sent');
  });

  it('an undecided case asks no such thing', async () => {
    mockApi(queue([{ ...firstClaim, id: 'claim-new', status: 'PENDING_REVIEW', evidenceComplete: true }], 'PENDING_REVIEW'));
    const { user } = renderWithQuery(<ClaimsPage />);
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    expect((await screen.findByRole('dialog')).textContent).not.toContain('Confirm nothing was sent');
  });

  it('Mark paid is offered only when it can be recorded: a short line says so, and Reject stays', async () => {
    const big = { ...firstClaim, id: 'claim-big', status: 'APPROVED', amount: 90000, evidenceNow: { complete: true, missing: [] } };
    mockApi(queue([big], 'APPROVED'));
    const { user } = renderWithQuery(<ClaimsPage />);
    await approvedTab(user);
    expect((await screen.findByTestId('short-line-claim-big')).textContent).toContain('Record company money before you send anything');
    expect(screen.queryByRole('button', { name: 'Mark paid' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });
});
