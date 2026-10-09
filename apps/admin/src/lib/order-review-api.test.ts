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
  it.each(operations)('%s keeps second-admin approval as queued', async (_name, run) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, error: { code: 'APPROVAL_REQUIRED', details: { approvalId: 'synthetic-approval' } } }), { status: 202 })));
    await expect(run()).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED', status: 202 });
  });
});
