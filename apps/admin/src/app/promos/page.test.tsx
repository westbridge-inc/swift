import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PromosPage from './page';
import { mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [Ruling 1 Nov 2026 · REVIEW-M N1] Swift-paid promo codes are switched off. Every code this console
// made was Swift-paid (funder PLATFORM), so the console no longer offers to make one: the server
// refuses it, and an old Swift-paid row never discounts an order. The page says so in plain words,
// lists every code with who pays for it, and never calls an old Swift-paid row "Active".
// ---------------------------------------------------------------------------

const row = (over: Record<string, unknown>) => ({
  id: 'p1', code: 'WELCOME10', description: '10% off', discountType: 'PERCENTAGE', discountValue: 10,
  minOrderAmount: null, maxDiscount: null, maxUses: null, currentUses: 0, isActive: true,
  validFrom: '2026-11-01T04:00:00.000Z', validUntil: '2026-12-01T03:59:59.999Z', funder: 'PLATFORM', vendorId: null, ...over,
});

function handler(data: unknown[]) {
  return (request: ApiRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/promos') {
      return { body: { success: true, data } };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
}

describe('[Ruling 1 Nov 2026] the console cannot make a Swift-paid promo code', () => {
  it('offers no way to create one, and says why in plain words', async () => {
    const fetchMock = mockApi(handler([]));
    renderWithQuery(<PromosPage />);
    expect(await screen.findByText('No promo codes yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /create/i })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    const note = screen.getByRole('note');
    expect(note.textContent).toMatch(/Swift-paid promo codes are switched off\./);
    expect(note.textContent).toMatch(/Swift never holds or moves order money/);
    expect(note.textContent).toMatch(/A store can still make its own promo code in the Swift app/);
    expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(0);
  });

  it('an old Swift-paid row reads "Off (Swift-paid)" even if its own switch is on; a store’s code reads Active', async () => {
    mockApi(handler([
      row({ id: 'p1', code: 'OLDSWIFT', funder: 'PLATFORM', isActive: true }),
      row({ id: 'p2', code: 'STORE20', funder: 'VENDOR', vendorId: 'v1', isActive: true }),
    ]));
    renderWithQuery(<PromosPage />);
    const swiftRow = (await screen.findByText('OLDSWIFT')).closest('tr')!;
    expect(within(swiftRow).getByText('Swift')).toBeTruthy();
    expect(within(swiftRow).getByText('Off (Swift-paid)')).toBeTruthy();
    expect(within(swiftRow).queryByText('Active')).toBeNull();
    const storeRow = screen.getByText('STORE20').closest('tr')!;
    expect(within(storeRow).getByText('The store')).toBeTruthy();
    expect(within(storeRow).getByText('Active')).toBeTruthy();
  });
});
