import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WeeklyFee } from './weekly-fee';
import { mockApi, renderWithQuery } from '@/test/test-utils';
import { setSelectedStore } from '@/lib/auth';

describe('rendered weekly fee', () => {
  it('opens new and handed-back OPEN checkouts in the same tab with a fresh key per tap', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    const keys: string[] = [];
    mockApi(({ method, url, init }) => {
      if (method === 'POST') {
        keys.push(new Headers(init?.headers).get('Idempotency-Key')!);
        return { status: keys.length === 1 ? 201 : 200, body: { success: true, data: { ref: 'open-ref', status: 'OPEN', checkoutUrl: 'https://checkout.test/opaque', amountGyd: 1200, currencyCode: 'GYD' } } };
      }
      if (url.pathname.endsWith('/open-ref')) return { body: { success: true, data: { ref: 'open-ref', status: 'OPEN', amountGyd: 1200, subscriptionStatus: 'ACTIVE' } } };
      return { body: { success: true, data: { status: 'ACTIVE', amountDueGyd: 1200, payActions: [{ id: 'MMG_CHECKOUT', state: 'live', amountGyd: 1200, currencyCode: 'GYD' }] } } };
    });
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    await view.user.click(await screen.findByRole('button', { name: 'Pay GY$1,200 with MMG' }));
    await screen.findByText('Waiting for MMG…');
    await view.user.click(await screen.findByRole('button', { name: 'Pay GY$1,200 with MMG' }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(2));
    expect(assign).toHaveBeenCalledWith('https://checkout.test/opaque');
    expect(keys).toHaveLength(2); expect(keys[0]).not.toBe(keys[1]);
    expect(document.body.textContent).not.toContain('Paid:'); view.unmount();
  });
  it.each(['live', 'off', 'absent'])('MMG %s controls the actual button; deprecated fields cannot render', async (state) => {
    mockApi(() => ({ body: { success: true, data: { status: 'ACTIVE', amountDueGyd: 0, nextBillingDate: '2026-10-06T12:00:00Z', payActions: state === 'absent' ? undefined : [{ id: 'MMG_CHECKOUT', state, amountGyd: 1200, currencyCode: 'GYD' }, { id: 'CARD', state: 'off' }], sanFormatted: 'private-number', payCashSteps: ['Go to MMG agent'], activationCopy: 'instant restoration' } } }));
    const view = renderWithQuery(<WeeklyFee family="vendor" />); await screen.findByText('Nothing due right now: your next bill is 6 Oct 2026');
    const button = screen.queryByRole('button', { name: 'Pay GY$1,200 with MMG' });
    if (state === 'live') expect(button).toBeTruthy(); else expect(button).toBeNull();
    expect(document.body.textContent).not.toMatch(/coming soon|private-number|MMG agent|instant restoration|card/i); view.unmount();
  });
  it.each(['vendor', 'rider', 'driver'] as const)('%s sends platform and new idempotency keys; 409 follows the ref and hides Pay', async (family) => {
    setSelectedStore('store-checkout');
    const calls = mockApi(({ method, url, init }) => {
      expect(new Headers(init?.headers).get('x-client-platform')).toBe('web');
      if (family === 'vendor') expect(new Headers(init?.headers).get('x-vendor-id')).toBe('store-checkout');
      if (method === 'POST') {
        expect(new Headers(init?.headers).get('Idempotency-Key')).toMatch(/^[A-Za-z0-9_-]{8,128}$/); expect(init?.body).toBe('{}');
        return { status: 409, body: { success: false, error: { code: 'CHECKOUT_CONFIRMING', details: { ref: 'earlier-ref' } } } };
      }
      if (url.pathname.endsWith('/earlier-ref')) return { body: { success: true, data: { ref: 'earlier-ref', status: 'CONFIRMING', amountGyd: 1200, currencyCode: 'GYD', subscriptionStatus: 'PAST_DUE' } } };
      return { body: { success: true, data: { status: 'PAST_DUE', amountDueGyd: 1200, payActions: [{ id: 'MMG_CHECKOUT', state: 'live', amountGyd: 1200, currencyCode: 'GYD' }] } } };
    });
    const view = renderWithQuery(<WeeklyFee family={family} />); await view.user.click(await screen.findByRole('button', { name: 'Pay GY$1,200 with MMG' }));
    await screen.findByText("Confirming your payment with MMG. Don't pay again.");
    expect(screen.queryByRole('button', { name: /Pay GY/ })).toBeNull();
    await waitFor(() => expect(calls.mock.calls.some(([url]) => String(url).endsWith(`/${family}/subscription/mmg-checkout/earlier-ref`))).toBe(true)); view.unmount();
  });
});
