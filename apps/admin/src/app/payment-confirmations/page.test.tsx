import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Page from './page';
import ApprovalsPage from '../approvals/page';
import { mockApi, renderWithQuery, requestsByMethod, type ApiRequest, type ApiReply } from '@/test/test-utils';

const REASON = 'Checked the recorded MMG observations and settlement evidence.';
const row = { id: 'hold-one', source: 'MMG_CHECKOUT', sourceId: 'checkout-one', subscriptionId: 'subscription-one', epoch: 3, clockVersion: 9,
  reason: 'NO_REPLY', status: 'ACTIVE', beganAt: '2026-10-07T10:00:00Z', reviewDueAt: '2026-10-07T11:00:00Z', overdue: true,
  remainingGraceMs: 3_600_000, resolvable: true, swiftReference: '111222333444555666', partner: 'Synthetic Kitchen', settlementPayments: [{ providerPaymentId: 'provider-row-one', mmgTransactionId: '123456789012' }] };
const queued = { status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this before it happens.', details: { approvalId: 'approval-one' } } } };
const pending = { id: 'approval-one', action: 'POST /billing/confirmations/:id/resolve', status: 'PENDING', cls: 'C4', capability: 'billing.confirmation.resolve',
  entityId: row.id, fingerprint: 'synthetic-fingerprint', requestedBy: 'synthetic-admin', reason: REASON, isOwnRequest: true,
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), bodySnapshot: { params: { id: row.id }, body: { decision: 'UNPAID' } } };
function serve(write: (_r: ApiRequest) => ApiReply | Promise<ApiReply> = () => queued, rows = [row], approvals: unknown[] = []) {
  return mockApi((r) => {
    if (r.method !== 'GET') return write(r);
    if (r.url.pathname.endsWith('/confirmations')) return { body: { success: true, data: rows } };
    if (r.url.pathname.endsWith('/approvals')) return { body: { success: true, data: r.url.searchParams.get('status') === 'PENDING' ? approvals : [], pagination: { page: 1, pages: 1 } } };
    throw new Error(`Unexpected ${r.url.pathname}`);
  });
}
async function open(user: ReturnType<typeof renderWithQuery>['user'], decision = 'Close as NOT PAID') {
  await user.click(await screen.findByRole('button', { name: `${decision} ${row.swiftReference}` }));
  const form = screen.getByRole('form', { name: 'Resolve payment confirmation' });
  await user.type(within(form).getByLabelText('Evidence reference'), 'review:case-001');
  await user.type(within(form).getByLabelText('Reason'), REASON);
  return form;
}

describe('weekly-fee payment confirmations', () => {
  it('renders overdue first, remaining grace, source, reference, partner and the timeline link; legacy obligations are read-only', async () => {
    serve(undefined, [{ ...row, id: 'future', swiftReference: '999888777666555444', overdue: false }, row, { ...row, id: 'legacy', source: 'OBLIGATION', sourceId: 'old-sub', resolvable: false, swiftReference: null as unknown as string, settlementPayments: [] }]);
    renderWithQuery(<Page />);
    const table = await screen.findByRole('table', { name: 'Payment confirmations' });
    const rows = within(table).getAllByRole('row');
    expect(rows[1]!.textContent).toContain(row.swiftReference);
    expect(rows[1]!.textContent).toContain('1 h 0 min');
    expect(rows[1]!.textContent).toContain('MMG checkout');
    expect(rows[1]!.textContent).toContain('Synthetic Kitchen');
    expect(within(rows[1]!).getByRole('link', { name: 'MMG timeline' }).getAttribute('href')).toBe('/mmg-payments?checkout=checkout-one');
    const legacy = rows.find((r) => r.textContent?.includes('Legacy obligation'))!;
    expect(legacy.textContent).toContain('Read-only');
    expect(within(legacy).queryByRole('button')).toBeNull();
  });
  it.each(['UNPAID', 'PAID'] as const)('posts the exact %s approval body and honestly waits without resubmitting', async (decision) => {
    const fetch = serve();const { user } = renderWithQuery(<Page />);
    const form = await open(user, decision === 'PAID' ? 'Mark PAID' : 'Close as NOT PAID');
    if (decision === 'PAID') {
      expect(form.textContent).toContain("Mark PAID: only with MMG's transaction id; credits once");
      await user.selectOptions(within(form).getByLabelText('MMG transaction ID'), 'provider-row-one');
    } else expect(form.textContent).toContain("Close as NOT PAID: the checkout becomes NOT_PAID, the store's billing clock resumes with its remaining grace; nothing is credited");
    await user.click(within(form).getByRole('button', { name: 'Request second-admin approval' }));
    expect(await screen.findByText(/Waiting for a second admin/)).toBeTruthy();
    const writes = requestsByMethod(fetch, 'POST');expect(writes).toHaveLength(1);
    const [url, init] = writes[0]!;expect(String(url)).toMatch(/\/billing\/confirmations\/hold-one\/resolve$/);
    expect(JSON.parse(String(init?.body))).toEqual({ sourceId: row.sourceId, epoch: 3, clockVersion: 9, decision, evidenceReference: 'review:case-001', reason: REASON, ...(decision === 'PAID' ? { providerPaymentId: 'provider-row-one' } : {}) });
    expect((init?.headers as Record<string,string>)['x-swift-approval']).toBeUndefined();
    expect((init?.headers as Record<string,string>)['x-swift-reason']).toBe(REASON);
    expect(screen.queryByRole('button', { name: `Close as NOT PAID ${row.swiftReference}` })).toBeNull();
    expect(screen.getByRole('link', { name: 'Open Approvals' }).getAttribute('href')).toBe('/approvals');
  });
  it('a changed confirmation requires reload and renewed review before another request', async () => {
    const fetch = serve(() => ({ status: 409, body: { success: false, error: { code: 'CONFIRMATION_CHANGED', message: 'Reload the payment confirmation before resolving it.' } } }));
    const { user } = renderWithQuery(<Page />);const form = await open(user);
    await user.click(within(form).getByRole('button', { name: 'Request second-admin approval' }));
    expect(await screen.findByText(/Reload the payment confirmation before resolving it/)).toBeTruthy();
    expect((within(form).getByRole('button', { name: 'Request second-admin approval' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Reload confirmations' }));
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
    expect(requestsByMethod(fetch,'POST')).toHaveLength(1);
    expect(requestsByMethod(fetch,'GET').filter(([url]) => String(url).endsWith('/confirmations')).length).toBeGreaterThan(1);
  });
  it('shows self-approval refusal, and existing own approvals cannot be signed', async () => {
    const fetch = serve(() => ({ status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'You raised this request. A money or platform action needs a second person.' } } }));
    const { user, unmount } = renderWithQuery(<Page />);const form = await open(user);
    await user.click(within(form).getByRole('button', { name: 'Request second-admin approval' }));
    expect(await screen.findByText(/You raised this request/)).toBeTruthy();
    expect(requestsByMethod(fetch,'POST')).toHaveLength(1);unmount();
    serve(undefined, [row], [pending]);renderWithQuery(<ApprovalsPage />);
    expect(await screen.findByText(/you cannot sign for yourself/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
  it('keeps pending approval after remount instead of filing a duplicate', async () => {
    const fetch=serve(undefined,[row],[pending]);renderWithQuery(<Page />);
    expect(await screen.findByText(/Waiting for a second admin/)).toBeTruthy();
    expect(screen.queryByRole('button',{name:`Close as NOT PAID ${row.swiftReference}`})).toBeNull();
    expect(requestsByMethod(fetch,'POST')).toHaveLength(0);
  });
  it('rejects invalid evidence before creating an approval', async () => {
    const fetch=serve();const {user}=renderWithQuery(<Page />);const form=await open(user);
    const input=within(form).getByLabelText('Evidence reference');await user.clear(input);await user.type(input,'bad ref');
    await user.click(within(form).getByRole('button',{name:'Request second-admin approval'}));
    expect(await within(form).findByText(/8–128 characters/)).toBeTruthy();expect(requestsByMethod(fetch,'POST')).toHaveLength(0);
  });
  it('PAID cannot be requested without a recorded MMG transaction', async () => {
    const fetch=serve(undefined,[{...row,settlementPayments:[]}]);const {user}=renderWithQuery(<Page />);const form=await open(user,'Mark PAID');
    await user.click(within(form).getByRole('button',{name:'Request second-admin approval'}));
    expect((await within(form).findByRole('alert')).textContent).toContain('Select a recorded MMG transaction');expect(requestsByMethod(fetch,'POST')).toHaveLength(0);
  });
  it('a same-tick double submit creates one approval', async () => {
    let finish: (_r: ApiReply)=>void=()=>{};const fetch=serve(()=>new Promise((r)=>{finish=r;}));const {user}=renderWithQuery(<Page />);const form=await open(user);
    const button=within(form).getByRole('button',{name:'Request second-admin approval'});
    await act(async()=>{button.click();button.click();});expect(requestsByMethod(fetch,'POST')).toHaveLength(1);
    expect((screen.getByRole('button',{name:`Close as NOT PAID ${row.swiftReference}`}) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button',{name:'Reload confirmations'}) as HTMLButtonElement).disabled).toBe(true);
    await act(async()=>{finish(queued);});expect(await screen.findByText(/Waiting for a second admin/)).toBeTruthy();
  });
  it('read failure is not an empty queue and has retry',async()=>{
    mockApi(()=>({status:500,body:{success:false,error:{code:'INTERNAL_ERROR',message:'Read unavailable'}}}));renderWithQuery(<Page />);
    expect(await screen.findByText("Couldn't load payment confirmations")).toBeTruthy();expect(screen.queryByText('No payment confirmations need review.')).toBeNull();
    expect(screen.getByRole('button',{name:'Reload confirmations'})).toBeTruthy();
  });
});


it('an uncertain acknowledgement requires checking the queue before another request', async () => {
  const fetch = serve(() => ({ status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: 'Reply unavailable' } } }));
  const { user } = renderWithQuery(<Page />); const form = await open(user);
  await user.click(within(form).getByRole('button', { name: 'Request second-admin approval' }));
  await within(form).findByRole('alert');
  expect((within(form).getByRole('button', { name: 'Request second-admin approval' }) as HTMLButtonElement).disabled).toBe(true);
  expect(requestsByMethod(fetch, 'POST')).toHaveLength(1);
  await user.click(within(form).getByRole('button', { name: 'Close' }));
  expect((screen.getByRole('button', { name: `Close as NOT PAID ${row.swiftReference}` }) as HTMLButtonElement).disabled).toBe(true);
});
