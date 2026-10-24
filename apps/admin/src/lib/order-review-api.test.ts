import { describe, expect, it, vi } from 'vitest';
import { releaseHeldOrder, resolvePaymentDispute, retryOrderDispatch } from './api';

const operations = [
  ['release', () => releaseHeldOrder('synthetic-order')],
  ['dispatch retry', () => retryOrderDispatch('synthetic-order')],
  ['dispute resolution', () => resolvePaymentDispute('synthetic-order', { resolution: 'CUSTOMER_PAID', expectedClaimRevision: 4 }, 'Checked both payment records')],
] as const;

describe('order review action acknowledgements', () => {
  it.each(operations)('%s never reports success for an unreadable response', async (_name, run) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{', { status: 200 })));
    await expect(run()).rejects.toMatchObject({ code: 'RESPONSE_UNREADABLE', status: 502 });
  });
  it.each(operations)('%s never reports success for an empty response', async (_name, run) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    await expect(run()).rejects.toMatchObject({ code: 'RESPONSE_UNREADABLE', status: 502 });
  });
  // [REVIEW-B #1699 S4-1] A decision is acknowledged only when the server says the
  // disagreement is closed. A 200 naming the right order and decision while the
  // mismatch is still open (or unstated) is not proof the dispute was decided.
  it.each([
    ['still open', { mismatch: true }],
    ['not stated', {}],
  ])('dispute resolution never reports a decision whose disagreement is %s', async (_case, latch) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: { orderId: 'synthetic-order', resolution: 'CUSTOMER_PAID', paymentStatus: 'CLAIMED', replayed: false, ...latch } }), { status: 200 })));
    await expect(resolvePaymentDispute('synthetic-order', { resolution: 'CUSTOMER_PAID', expectedClaimRevision: 4 }, 'Checked both payment records')).rejects.toMatchObject({ code: 'RESPONSE_UNREADABLE', status: 502 });
  });
  it('dispute resolution reports a decision the server says closed the disagreement', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: { orderId: 'synthetic-order', resolution: 'CUSTOMER_PAID', mismatch: false, paymentStatus: 'CLAIMED', replayed: false } }), { status: 200 })));
    await expect(resolvePaymentDispute('synthetic-order', { resolution: 'CUSTOMER_PAID', expectedClaimRevision: 4 }, 'Checked both payment records')).resolves.toMatchObject({ success: true });
  });
  it.each(operations)('%s keeps second-admin approval as queued', async (_name, run) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, error: { code: 'APPROVAL_REQUIRED', details: { approvalId: 'synthetic-approval' } } }), { status: 202 })));
    await expect(run()).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED', status: 202 });
  });
});
