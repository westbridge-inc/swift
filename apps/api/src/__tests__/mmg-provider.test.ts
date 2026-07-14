import { describe, it, expect } from 'vitest';
import { SandboxMmgProvider, getMmgProvider } from '../providers/mmg/mmg-provider';

// MMG Merchant-Initiated sandbox: exercises the whole loop (initiate → the
// payer approves on their phone → lookup) deterministically, so billing/agent
// code can be built + tested before a live MMG account exists.
describe('MMG sandbox provider — merchant-initiated loop', () => {
  const mmg = new SandboxMmgProvider();

  it('authenticates', async () => {
    const { token } = await mmg.authenticate();
    expect(token).toMatch(/^mmg_sandbox_/);
  });

  it('initiate → pending, then lookup → approved', async () => {
    const init = await mmg.initiatePayment({ payerId: '+5926000000', amountMinor: 130000, currencyCode: 'GYD', reference: 'order-123' });
    expect(init.status).toBe('pending');
    expect(init.transactionId).toBeTruthy();
    const look = await mmg.transactionLookup({ transactionId: init.transactionId });
    expect(look.status).toBe('approved');
  });

  it('a reference marked "pending" stays pending on lookup', async () => {
    const init = await mmg.initiatePayment({ payerId: 'x', amountMinor: 100, currencyCode: 'GYD', reference: 'weekly-pending-1' });
    const look = await mmg.transactionLookup({ transactionId: init.transactionId });
    expect(look.status).toBe('pending');
  });

  it('a reference marked "decline" is declined at initiate', async () => {
    const init = await mmg.initiatePayment({ payerId: 'x', amountMinor: 100, currencyCode: 'GYD', reference: 'decline-me' });
    expect(init.status).toBe('declined');
    expect(init.transactionId).toBe('');
  });

  it('reverse, balance and history behave', async () => {
    const rev = await mmg.reverseTransaction({ transactionId: 'mmgtx_approved_abc' });
    expect(rev.status).toBe('reversed');
    expect((await mmg.accountBalance()).currencyCode).toBe('GYD');
    expect(await mmg.transactionHistory()).toEqual([]);
  });

  it('the factory returns the sandbox by default', () => {
    const prev = process.env['MMG_DRIVER'];
    delete process.env['MMG_DRIVER'];
    expect(getMmgProvider()).toBeInstanceOf(SandboxMmgProvider);
    if (prev !== undefined) process.env['MMG_DRIVER'] = prev;
  });
});
