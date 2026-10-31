import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import OrdersPage from './page';
import { mockApi, renderWithQuery, stubAudioContext, type ApiRequest } from '@/test/test-utils';
import { wireVendorOrder } from '@/test/vendor-wire-fixtures';

// ---------------------------------------------------------------------------
// [STORE-LINK+NAMES · owner 30 Oct 21:47Z] The customer's and the rider's names
// are easy to see at a glance on every board card, as on the phone board
// (apps/mobile/src/modules/vendor/BoardNames.tsx, the same words from
// storeHandover.ts). Only first names: never a last name, a phone number or an
// address on the card, even when the reply carries one.
// ---------------------------------------------------------------------------

function board(orders: unknown[]) {
  return (request: ApiRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/vendor/orders') return { body: { success: true, data: orders, meta: { total: orders.length } } };
    if (request.method === 'GET' && request.url.pathname === '/api/v1/vendor/items') return { body: { success: true, data: [] } };
    return { status: 404, body: { success: false } };
  };
}

async function card(orderNumber: string) {
  const heading = await screen.findByText(`#${orderNumber}`);
  const article = heading.closest('article');
  if (!article) throw new Error(`No board card for ${orderNumber}`);
  return article as HTMLElement;
}

const rider = { user: { firstName: 'Devon', lastName: 'Ridername', phone: '+5927000000' }, vehicleType: 'MOTORCYCLE', licensePlate: 'PAB 1234' };

beforeEach(() => stubAudioContext());

describe('[NAMES] the web board card shows who the order is for and who carries it', () => {
  it('the customer\'s first name and the assigned rider\'s first name, as readable lines', async () => {
    mockApi(board([wireVendorOrder({ status: 'PREPARING', riderId: 'rider-1', rider, customer: { id: 'c-1', firstName: 'Ana', lastName: 'Lastname', phone: '+5926000000' } })]));
    renderWithQuery(<OrdersPage />);
    const shown = await card('SW-1001');
    expect(within(shown).getByText('Customer: Ana')).toBeTruthy();
    expect(within(shown).getByText('Rider: Devon')).toBeTruthy();
    // Never more than the first names on the card.
    expect(shown.textContent).not.toMatch(/Lastname|Ridername|\+592|Test Road|PAB 1234/);
  });

  it('before a rider is assigned: the customer only', async () => {
    mockApi(board([wireVendorOrder({ status: 'PREPARING', customer: { id: 'c-1', firstName: 'Ana' } })]));
    renderWithQuery(<OrdersPage />);
    const shown = await card('SW-1001');
    expect(within(shown).getByText('Customer: Ana')).toBeTruthy();
    expect(within(shown).queryByText(/^Rider:/)).toBeNull();
  });

  it('the payment method stays on the card', async () => {
    mockApi(board([wireVendorOrder({ status: 'PREPARING', paymentMethod: 'MOBILE_MONEY' })]));
    renderWithQuery(<OrdersPage />);
    const shown = await card('SW-1001');
    expect(within(shown).getByText('MMG')).toBeTruthy();
  });
});
