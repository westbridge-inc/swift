import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import Page from './page';
import ApprovalsPage from '../approvals/page';
import { Providers } from '../providers';
import { mockApi, renderWithQuery, requestsByMethod, type ApiRequest, type ApiReply } from '@/test/test-utils';

const REASON = 'Checked the recorded MMG observations and settlement evidence.';
// A hold with no credited MMG payment: the only kind that may be closed as NOT PAID.
const row = { id: 'hold-one', source: 'MMG_CHECKOUT', sourceId: 'checkout-one', subscriptionId: 'subscription-one', epoch: 3, clockVersion: 9,
  reason: 'NO_REPLY', status: 'ACTIVE', beganAt: '2026-10-07T10:00:00Z', reviewDueAt: '2026-10-07T11:00:00Z', overdue: true,
  remainingGraceMs: 3_600_000, resolvable: true, swiftReference: '111222333444555666', partner: 'Synthetic Kitchen', settlementPayments: [] as { providerPaymentId: string; mmgTransactionId: string }[] };
// MMG reports a credited transaction for this checkout (the queue's settlementPayments).
const credited = [{ providerPaymentId: 'provider-row-one', mmgTransactionId: '123456789012' }];
// The real first answer: the approval gate queues the request before any handler runs.
const queued = { status: 202, body: { success: false, error: { code: 'APPROVAL_REQUIRED', message: 'A second admin must approve this before it happens. It is in the approvals queue.', details: { approvalId: 'approval-one' } } } };
const pending = { id: 'approval-one', action: 'POST /billing/confirmations/:id/resolve', status: 'PENDING', cls: 'C4', capability: 'billing.payment.attach',
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
  const name = `${decision} ${row.swiftReference}`;
  await waitFor(() => expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false));
  await user.click(screen.getByRole('button', { name }));
  const form = screen.getByRole('form', { name: 'Resolve payment confirmation' });
  await user.type(within(form).getByLabelText('Evidence reference'), 'review:case-001');
  await user.type(within(form).getByLabelText('Reason'), REASON);
  return form;
}
const readsOf = (fetch: ReturnType<typeof mockApi>, path: string) =>
  requestsByMethod(fetch, 'GET').filter(([url]) => new URL(String(url)).pathname.endsWith(path)).length;
const bodiesOf = (fetch: ReturnType<typeof mockApi>) => requestsByMethod(fetch, 'POST').map(([, init]) => JSON.parse(String(init?.body)));

/** One server with state: the queue, the approvals, and what each write does to them. */
function liveServer(onResolve: (_s: { hold: typeof row; approvals: (typeof pending)[] }) => ApiReply | Promise<ApiReply>,
  onApply: (_s: { hold: typeof row; approvals: (typeof pending)[] }) => ApiReply = () => { throw new Error('Unexpected apply'); }) {
  const state = { hold: { ...row }, approvals: [] as (typeof pending)[] };
  const fetch = mockApi((r) => {
    const path = r.url.pathname;
    if (r.method === 'GET' && path.endsWith('/admin/billing/confirmations')) return { body: { success: true, data: [state.hold] } };
    if (r.method === 'GET' && path.endsWith('/admin/approvals')) {
      return { body: { success: true, data: state.approvals.filter((a) => a.status === r.url.searchParams.get('status')), pagination: { page: 1, pages: 1 } } };
    }
    if (r.method === 'POST' && path.endsWith('/admin/billing/confirmations/hold-one/resolve')) return onResolve(state);
    if (r.method === 'POST' && path.endsWith('/admin/approvals/approval-one/apply')) return onApply(state);
    throw new Error(`Unexpected ${r.method} ${path}`);
  });
  return { state, fetch };
}
/** The real console: its own cache settings (30 s staleTime) and ONE query client across page visits. */
function consoleSession() {
  const user = userEvent.setup();
  const view = render(<Providers><Page /></Providers>);
  const show = (page: 'confirmations' | 'approvals' | 'elsewhere') =>
    view.rerender(<Providers>{page === 'confirmations' ? <Page /> : page === 'approvals' ? <ApprovalsPage /> : <p>Another console page</p>}</Providers>);
  return { user, show };
}
const notPaidButton = () => screen.getByRole('button', { name: `Close as NOT PAID ${row.swiftReference}` }) as HTMLButtonElement;

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
    const fetch = serve(undefined, [decision === 'PAID' ? { ...row, settlementPayments: credited } : row]);const { user } = renderWithQuery(<Page />);
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
  // The first request never reaches the resolver: the approval gate answers 202 before any handler runs,
  // so a changed confirmation is refused when the APPROVED request is applied (409 CONFLICT), not here.
  it('a confirmation that changes after approval is refused at apply; back on this page the current hold is re-read and a new request carries it', async () => {
    const { state, fetch } = liveServer((s) => { s.approvals.push({ ...pending }); return queued; }, (s) => {
      s.approvals = s.approvals.map((a) => ({ ...a, status: 'APPLIED' }));
      s.hold = { ...s.hold, epoch: 4, clockVersion: 10 };
      return { status: 409, body: { success: false, error: { code: 'CONFLICT', message: 'Reload the payment confirmation before resolving it.' } } };
    });
    const { user, show } = consoleSession();
    let form = await open(user);
    await user.click(within(form).getByRole('button', { name: 'Request second-admin approval' }));
    expect(await screen.findByText(/Waiting for a second admin/)).toBeTruthy();
    state.approvals = state.approvals.map((a) => ({ ...a, status: 'APPROVED' })); // a second admin approves
    show('approvals');
    await user.click(await screen.findByRole('button', { name: 'Approved' }));
    await user.click(await screen.findByRole('button', { name: 'Execute the approved action' }));
    expect(await screen.findByText(/Reload the payment confirmation before resolving it/)).toBeTruthy();
    show('confirmations');
    form = await open(user);
    await user.click(within(form).getByRole('button', { name: 'Request second-admin approval' }));
    expect(await screen.findByText(/Waiting for a second admin/)).toBeTruthy();
    const resolves = bodiesOf(fetch).filter((body) => 'decision' in body);
    expect(resolves.map(({ epoch, clockVersion }) => [epoch, clockVersion])).toEqual([[3, 9], [4, 10]]);
  });
  // Self-approval is refused by the decision endpoint (tested below on the Approvals page), never by this request.
  it('the request is queued for a second admin; the requester cannot sign it, and coming back still shows it waiting', async () => {
    const { fetch } = liveServer((s) => { s.approvals.push({ ...pending }); return queued; });
    const { user, show } = consoleSession();
    const form = await open(user);
    await user.click(within(form).getByRole('button', { name: 'Request second-admin approval' }));
    expect(await screen.findByText(/Waiting for a second admin/)).toBeTruthy();
    show('approvals');
    expect(await screen.findByText(/you cannot sign for yourself/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    show('confirmations');
    expect(await screen.findByText(/Waiting for a second admin/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: `Close as NOT PAID ${row.swiftReference}` })).toBeNull();
    expect(requestsByMethod(fetch, 'POST')).toHaveLength(1);
  });
  it('coming back after an uncertain reply re-reads both lists and stays locked until Reload confirms the state', async () => {
    const { fetch } = liveServer(() => ({ status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: 'Reply unavailable' } } }));
    const { user, show } = consoleSession();
    const form = await open(user);
    await user.click(within(form).getByRole('button', { name: 'Request second-admin approval' }));
    await within(form).findByRole('alert');
    await user.click(within(form).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Reload confirmations' }) as HTMLButtonElement).disabled).toBe(false));
    const before = [readsOf(fetch, '/confirmations'), readsOf(fetch, '/approvals')] as const;
    show('elsewhere');
    show('confirmations');
    await waitFor(() => expect(readsOf(fetch, '/confirmations')).toBeGreaterThan(before[0]));
    await waitFor(() => expect(readsOf(fetch, '/approvals')).toBeGreaterThan(before[1]));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Reload confirmations' }) as HTMLButtonElement).disabled).toBe(false));
    expect(notPaidButton().disabled).toBe(true);
    expect(screen.getByText('Reload confirmations before another request.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Reload confirmations' }));
    await waitFor(() => expect(notPaidButton().disabled).toBe(false));
    expect(requestsByMethod(fetch, 'POST')).toHaveLength(1);
  });
  it('leaving while the request is in flight and coming back keeps the row locked until the reply and a fresh read', async () => {
    let finish: () => void = () => {};
    const { fetch } = liveServer((s) => new Promise((resolve) => { finish = () => { s.approvals.push({ ...pending }); resolve(queued); }; }));
    const { user, show } = consoleSession();
    const form = await open(user);
    await user.click(within(form).getByRole('button', { name: 'Request second-admin approval' }));
    const before = [readsOf(fetch, '/confirmations'), readsOf(fetch, '/approvals')] as const;
    show('elsewhere');
    show('confirmations');
    // Both lists are read again on return (two approval statuses), and those reads finish before the reply.
    await waitFor(() => expect(readsOf(fetch, '/confirmations')).toBe(before[0] + 1));
    await waitFor(() => expect(readsOf(fetch, '/approvals')).toBe(before[1] + 2));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.getByText('A request for this payment is still being sent. Wait for the answer.')).toBeTruthy();
    expect(notPaidButton().disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Reload confirmations' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish(); });
    expect(await screen.findByText(/Waiting for a second admin/)).toBeTruthy();
    expect(requestsByMethod(fetch, 'POST')).toHaveLength(1);
  });
  it('a refusal before anything is queued (missing permission) shows the server words and leaves the row available', async () => {
    const fetch = serve(() => ({ status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'This admin action requires the billing.payment.attach capability' } } }));
    const { user } = renderWithQuery(<Page />);const form = await open(user);
    await user.click(within(form).getByRole('button', { name: 'Request second-admin approval' }));
    expect(await screen.findByText(/requires the billing.payment.attach capability/)).toBeTruthy();
    expect((within(form).getByRole('button', { name: 'Request second-admin approval' }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(within(form).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(notPaidButton().disabled).toBe(false));
    expect(screen.queryByText('Reload confirmations before another request.')).toBeNull();
    expect(requestsByMethod(fetch, 'POST')).toHaveLength(1);
  });
  it('after a request both lists are read again without pressing Reload', async () => {
    const fetch = serve();const { user } = renderWithQuery(<Page />);const form = await open(user);
    const before = [readsOf(fetch, '/confirmations'), readsOf(fetch, '/approvals')] as const;
    await user.click(within(form).getByRole('button', { name: 'Request second-admin approval' }));
    expect(await screen.findByText(/Waiting for a second admin/)).toBeTruthy();
    await waitFor(() => expect(readsOf(fetch, '/confirmations')).toBeGreaterThan(before[0]));
    await waitFor(() => expect(readsOf(fetch, '/approvals')).toBeGreaterThan(before[1]));
  });
  it('a credited MMG payment for the checkout blocks Close as NOT PAID and says why; PAID needs the MMG transaction id', async () => {
    const fetch = serve(undefined, [{ ...row, settlementPayments: credited }]);const { user } = renderWithQuery(<Page />);
    expect(await screen.findByText('MMG shows a credited payment for this checkout — reconcile it as PAID instead.')).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Reload confirmations' }) as HTMLButtonElement).disabled).toBe(false));
    expect(notPaidButton().disabled).toBe(true);
    await user.click(notPaidButton());
    expect(screen.queryByRole('form')).toBeNull();
    const form = await open(user, 'Mark PAID');
    await user.click(within(form).getByRole('button', { name: 'Request second-admin approval' }));
    expect((await within(form).findByRole('alert')).textContent).toContain('Select a recorded MMG transaction');
    expect(within(form).getByRole('option', { name: '123456789012' })).toBeTruthy();
    expect(requestsByMethod(fetch, 'POST')).toHaveLength(0);
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

it('the existing Approvals page displays a server self-approval refusal on the actual decision endpoint', async () => {
  const fetch = serve((r) => {
    expect(r.url.pathname).toBe('/api/v1/admin/approvals/approval-one/decide');
    return { status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'You raised this request. A money or platform action needs a second person.' } } };
  }, [row], [{ ...pending, isOwnRequest: false }]);
  // The server remains authoritative even if the rendered identity facts are stale.
  const { user } = renderWithQuery(<ApprovalsPage />);
  await user.type(await screen.findByRole('textbox'), REASON);
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText(/You raised this request/)).toBeTruthy();
  expect(requestsByMethod(fetch, 'POST')).toHaveLength(1);
});

it('the requester sees the reload message if confirmation evidence changes before the approved action is applied', async () => {
  const fetch = mockApi((r) => {
    if (r.method === 'GET') return { body: { success: true, data: r.url.searchParams.get('status') === 'APPROVED' ? [{ ...pending, status: 'APPROVED' }] : [] } };
    expect(r.url.pathname).toBe('/api/v1/admin/approvals/approval-one/apply');
    return { status: 409, body: { success: false, error: { code: 'CONFLICT', message: 'Reload the payment confirmation before resolving it.' } } };
  });
  const { user } = renderWithQuery(<ApprovalsPage />);
  await user.click(screen.getByRole('button', { name: 'Approved' }));
  await user.click(await screen.findByRole('button', { name: 'Execute the approved action' }));
  expect(await screen.findByText(/Reload the payment confirmation before resolving it/)).toBeTruthy();
  expect(requestsByMethod(fetch, 'POST')).toHaveLength(1);
});
