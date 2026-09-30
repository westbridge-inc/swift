import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, type ApiReply, type ApiRequest } from '@/test/test-utils';
import { clearSession, sessionProbe } from '@/lib/auth';
import { persistCheckoutAttempt, type Cart } from '@/lib/customer';
import CartPage from './page';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));
const ok = (data: unknown) => ({ body: { success: true, data } });
const address = { id: 'a1', label: 'Home', addressLine1: 'Test Street', city: 'Georgetown', isDefault: true };
const menu = { id: 's2', slug: 'second-store', name: 'Second Store', isCurrentlyOpen: true, acceptingOrders: true, categories: [{ items: [{ id: 'i2' }] }] };
let cart: Cart;
let requests: Array<{ method: string; path: string; body: unknown }>;
let orderedItems: string[];
let special: (_r: ApiRequest) => ApiReply | null;

beforeEach(async () => {
  clearSession();
  navigation.push.mockReset();
  requests = []; orderedItems = []; special = () => null;
  cart = {
    items: [
      { id: 'l1', itemId: 'i1', name: 'ST1 Last Bag', vendorId: 's1', customerPrice: 400, quantity: 1, fulfillment: 'DELIVERY' },
      { id: 'l2', itemId: 'i2', name: 'R2 Plate', vendorId: 's2', customerPrice: 800, quantity: 1, fulfillment: 'DELIVERY', selectedOptionNames: ['Large'] },
    ],
    vendors: [{ vendorId: 's1', name: 'First Store' }, { vendorId: 's2', name: 'Second Store' }],
    vendor: { id: 's2', slug: 'second-store', name: 'Second Store' },
    subtotalCustomer: 1200, deliveryFee: 100, discount: 0, tipAmount: 0, deliveryAddress: address,
  };
  mockApi((request) => {
    const { url, method, init } = request;
    requests.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
    const override = special(request); if (override) return override;
    if (url.pathname === '/api/v1/auth/me') return ok({ user: { id: 'customer-fixture' } });
    if (url.pathname === '/api/v1/customer/cart' && method === 'GET') return ok(cart);
    if (url.pathname === '/api/v1/customer/addresses') return ok([address]);
    if (url.pathname === '/api/v1/customer/vendors/s2' || url.pathname === '/api/v1/public/storefronts/second-store') return ok(menu);
    if (url.pathname.startsWith('/api/v1/customer/cart/items/') && method === 'DELETE') {
      cart = { ...cart, items: cart.items.filter((item) => item.id !== url.pathname.split('/').at(-1)), subtotalCustomer: 800 };
      return ok({ cart });
    }
    if (url.pathname === '/api/v1/customer/cart/address') return ok({ cart });
    if (url.pathname === '/api/v1/customer/checkout') {
      // This is the actual authority: checkout consumes EVERY persisted item,
      // not an invented vendorId sent by the web client.
      orderedItems = cart.items.map((item) => item.id);
      return ok({ order: { id: 'o1' } });
    }
    return { status: 404, body: { success: false, error: { message: 'unmocked request' } } };
  });
  await sessionProbe();
});

describe('store cart recovery', () => {
  it('groups the screenshot items by their actual store and hides the combined checkout', async () => {
    render(<CartPage />);
    const first = await screen.findByRole('region', { name: 'First Store' });
    const second = screen.getByRole('region', { name: 'Second Store' });
    expect(within(first).getByText('ST1 Last Bag')).toBeTruthy();
    expect(within(first).queryByText('R2 Plate')).toBeNull();
    expect(within(second).getByText('R2 Plate')).toBeTruthy();
    expect(within(second).getByText('Large')).toBeTruthy();
    expect(screen.getByText('Your cart has items from 2 stores. Check out one store at a time.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Order total' })).toBeNull();
    fireEvent.click(within(second).getByRole('button', { name: 'Check out Second Store' }));
    expect(screen.getByRole('status').textContent).toContain('remove the other stores');
    expect(requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });

  it('only checks out the remaining store after explicit removal, preserving its options', async () => {
    render(<CartPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check out Second Store' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove First Store items' }));
    const place = await screen.findByRole('button', { name: 'Place cash order · GY$900' });
    expect(cart.items.map((item) => item.id)).toEqual(['l2']);
    expect(cart.items[0]?.selectedOptionNames).toEqual(['Large']);
    fireEvent.click(place);
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/orders/o1'));
    expect(orderedItems).toEqual(['l2']);
    expect(requests.filter((r) => r.path.endsWith('/checkout'))).toEqual([
      { method: 'POST', path: '/api/v1/customer/checkout', body: { paymentMethod: 'CASH', tipAmount: 0 } },
    ]);
  });

  it('does not guess when removing the last-added store leaves stale store details', async () => {
    render(<CartPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Second Store items' }));
    expect(await screen.findByText(/could not confirm this store’s delivery details/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Place cash order/ })).toBeNull();
    expect(cart.items.map((item) => item.id)).toEqual(['l1']);
  });

  it('refreshes survivors after a partial removal fails, without exposing diagnostics', async () => {
    cart.items.splice(1, 0, { ...cart.items[0]!, id: 'l3', name: 'Another bag' });
    special = ({ method, url }) => method === 'DELETE' && url.pathname.endsWith('/l3')
      ? { status: 500, body: { success: false, error: { message: 'server quote failed for saved lines' } } } : null;
    render(<CartPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove First Store items' }));
    await screen.findByText('Could not update your cart. Please try again.');
    expect(screen.queryByText('ST1 Last Bag')).toBeNull();
    expect(screen.getByText('Another bag')).toBeTruthy();
    expect(screen.getByText('R2 Plate')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/server quote|saved lines/);
    expect(requests.filter((r) => r.method === 'DELETE').map((r) => r.path.split('/').at(-1))).toEqual(['l1', 'l3']);
  });

  it('does not remove a store during an unresolved order', async () => {
    persistCheckoutAttempt({ signature: 'earlier-order', key: 'fixture-replay-key' });
    render(<CartPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove First Store items' }));
    expect(await screen.findByText(/Your last order is still being confirmed/)).toBeTruthy();
    expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
  });

  it('explains a definite checkout refusal and allows recovery after reconciliation', async () => {
    cart.items = [cart.items[1]!]; cart.subtotalCustomer = 800;
    special = ({ url }) => url.pathname.endsWith('/checkout') ? {
      status: 403, body: { success: false, error: { code: 'ID_VERIFICATION_REQUIRED', message: 'server identity diagnostic' } },
    } : null;
    render(<CartPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Place cash order · GY$900' }));
    await screen.findByText('Please verify your identity in the Swift phone app before ordering.');
    expect(document.body.textContent).not.toContain('server identity diagnostic');
    expect(navigation.push).not.toHaveBeenCalled();
    expect(cart.items.map((item) => item.id)).toEqual(['l2']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Second Store items' }));
    await screen.findByText('Your cart is empty');
  });
});
