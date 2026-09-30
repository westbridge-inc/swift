import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, type ApiReply, type ApiRequest } from '@/test/test-utils';
import { clearSession, sessionProbe, setSelectedStore } from '@/lib/auth';
import { persistCheckoutAttempt, readCheckoutAttempt, type Cart } from '@/lib/customer';
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

  it('recovers from a removed store’s saved promotion with explicit removal and a fresh quote', async () => {
    cart.promoCode = { code: 'FIRSTSTORE' };
    special = ({ method, url }) => {
      if (url.pathname.endsWith('/checkout') && cart.promoCode) return {
        status: 400, body: { success: false, error: { code: 'PROMO_WRONG_VENDOR', message: 'server promo diagnostic' } },
      };
      if (method === 'DELETE' && url.pathname.endsWith('/cart/promo')) {
        cart = { ...cart, promoCode: null, deliveryFee: 125 };
        return ok({ message: 'Promo removed' });
      }
      return null;
    };
    render(<CartPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove First Store items' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Place cash order · GY$900' }));
    await screen.findByText('This promo code was for another store. Remove it to continue.');
    expect(document.body.textContent).not.toContain('server promo diagnostic');
    expect(cart.promoCode?.code).toBe('FIRSTSTORE');
    expect(requests.filter((r) => r.path.endsWith('/cart/promo'))).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Remove promo code' }));
    const place = await screen.findByRole('button', { name: 'Place cash order · GY$925' });
    const removalIndex = requests.findIndex((r) => r.method === 'DELETE' && r.path.endsWith('/cart/promo'));
    expect(removalIndex).toBeGreaterThan(-1);
    expect(requests.slice(removalIndex + 1)).toContainEqual({ method: 'GET', path: '/api/v1/customer/cart', body: null });
    expect(screen.queryByText('FIRSTSTORE')).toBeNull();
    expect(cart.items.map((item) => item.id)).toEqual(['l2']);
    expect(cart.items[0]?.selectedOptionNames).toEqual(['Large']);
    fireEvent.click(place);
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/orders/o1'));
    expect(orderedItems).toEqual(['l2']);
    expect(requests.filter((r) => r.path.endsWith('/checkout')).map((r) => r.body)).toEqual([
      { paymentMethod: 'CASH', tipAmount: 0, promoCode: 'FIRSTSTORE' },
      { paymentMethod: 'CASH', tipAmount: 0 },
    ]);
  });

  it('does not remove a saved promotion during an unresolved order', async () => {
    cart.promoCode = { code: 'FIRSTSTORE' };
    persistCheckoutAttempt({ signature: 'earlier-order', key: 'fixture-replay-key' });
    render(<CartPage />);
    await screen.findByRole('button', { name: 'Retry check' });
    expect(screen.queryByRole('button', { name: 'Remove promo code' })).toBeNull();
    expect(readCheckoutAttempt()?.key).toBe('fixture-replay-key');
    expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
    expect(cart.promoCode?.code).toBe('FIRSTSTORE');
  });

  it('retains the saved promotion and items when promotion removal fails', async () => {
    cart.promoCode = { code: 'FIRSTSTORE' };
    special = ({ method, url }) => method === 'DELETE' && url.pathname.endsWith('/cart/promo')
      ? { status: 500, body: { success: false, error: { message: 'server diagnostic' } } } : null;
    render(<CartPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove promo code' }));
    await screen.findByText('Could not update your cart. Please try again.');
    expect(screen.getByText('FIRSTSTORE')).toBeTruthy();
    expect(cart.items.map((item) => item.id)).toEqual(['l1', 'l2']);
    expect(navigation.push).not.toHaveBeenCalled();
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
    await screen.findByRole('button', { name: 'Retry check' });
    expect(screen.queryByRole('button', { name: 'Remove First Store items' })).toBeNull();
    expect(readCheckoutAttempt()?.key).toBe('fixture-replay-key');
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


describe('AX341 refusal details and recovery', () => {
  it('keeps an HTTP timeout ambiguous and locks changes until the order is resolved', async () => {
    cart.items = [cart.items[1]!]; cart.subtotalCustomer = 800;
    special = ({ url }) => url.pathname.endsWith('/checkout') ? {
      status: 408, body: { success: false, error: { code: 'REQUEST_TIMEOUT', message: 'Request timed out' } },
    } : null;
    render(<CartPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Place cash order · GY$900' }));
    await screen.findByRole('button', { name: 'Retry check' });
    expect(screen.getByRole('heading', { name: "We're checking your last order" })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove Second Store items' })).toBeNull();
    expect(readCheckoutAttempt()).not.toBeNull();
    expect(requests.filter((r) => r.method === 'DELETE')).toHaveLength(0);
    expect(cart.items.map((item) => item.id)).toEqual(['l2']);
  });

  it.each([
    ['VENDOR_AT_CAPACITY', 'Second Store is at capacity — try again in a few minutes', 'Second Store is very busy right now — try again in a few minutes'],
    ['VENDOR_TIER_CAP', "Second Store has reached today's order limit for an unregistered seller (20 a day). Try again tomorrow.", "Second Store has reached today's order limit for an unregistered seller (20 a day). Try again tomorrow."],
    ['VENDOR_TIER_CAP', "Second Store has reached this week's sales limit for an unregistered seller. Try again later this week.", "Second Store has reached this week's sales limit for an unregistered seller. Try again later this week."],
    ['NEW_STORE_REFUSAL', 'Second Store cannot deliver today. Choose pickup tomorrow.', 'Second Store cannot deliver today. Choose pickup tomorrow.'],
  ])('explains %s and retries only after a fresh quote', async (code, message, copy) => {
    cart.items = [cart.items[1]!]; cart.subtotalCustomer = 800;
    special = ({ url }) => url.pathname.endsWith('/checkout') ? {
      status: 409, body: { success: false, error: { code, message } },
    } : null;
    render(<CartPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Place cash order · GY$900' }));
    await screen.findByText(copy);
    expect(document.body.textContent).not.toContain('Could not confirm your order');
    expect(navigation.push).not.toHaveBeenCalled();
    expect(cart.items[0]?.selectedOptionNames).toEqual(['Large']);
    const refusalIndex = requests.findIndex((r) => r.path.endsWith('/checkout'));
    expect(requests.slice(refusalIndex + 1).some((r) => r.method === 'GET' && r.path.endsWith('/cart'))).toBe(true);
    special = () => null;
    fireEvent.click(screen.getByRole('button', { name: 'Place cash order · GY$900' }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/orders/o1'));
    expect(orderedItems).toEqual(['l2']);
    expect(requests.filter((r) => r.path.endsWith('/checkout')).map((r) => r.body)).toEqual([
      { paymentMethod: 'CASH', tipAmount: 0 }, { paymentMethod: 'CASH', tipAmount: 0 },
    ]);
  });

  it.each([1, 0])('marks only Rice with %i available and recovers with a server-priced cart', async (available) => {
    cart.items = [
      { ...cart.items[1]!, id: 'rice', itemId: 'i2', name: 'Rice', quantity: 3, customerPrice: 400, isAvailable: true },
      { ...cart.items[1]!, id: 'juice', itemId: 'i2-juice', name: 'Juice', quantity: 2, customerPrice: 100, isAvailable: true },
    ];
    cart.subtotalCustomer = 1400;
    special = ({ url, method, init }) => {
      if (url.pathname.endsWith('/vendors/s2')) return ok({ ...menu, categories: [{ items: [{ id: 'i2' }, { id: 'i2-juice' }] }] });
      if (url.pathname.endsWith('/checkout') && cart.items.some((item) => item.id === 'rice' && item.quantity > available)) return {
        status: 409, body: { success: false, error: {
          code: 'INSUFFICIENT_STOCK',
          message: available ? 'Only 1 of Rice left — reduce the quantity' : 'Rice is sold out',
          details: { itemId: 'i2', available },
        } },
      };
      if (url.pathname.endsWith('/cart/items/rice')) {
        const quantity = method === 'DELETE' ? 0 : JSON.parse(String(init?.body)).quantity;
        cart = { ...cart, items: cart.items.flatMap((item) => item.id !== 'rice' ? [item] : quantity ? [{ ...item, quantity }] : []), subtotalCustomer: quantity * 400 + 200 };
        return ok({ cart });
      }
      return null;
    };
    render(<CartPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Place cash order · GY$1,500' }));
    const copy = available ? 'Only 1 Rice left — change the quantity' : 'Rice is sold out — remove it to continue';
    await screen.findAllByText(copy);
    const rice = screen.getByText('Rice').closest('article')!;
    const juice = screen.getByText('Juice').closest('article')!;
    expect(within(rice).getByText(copy)).toBeTruthy();
    expect(rice.getAttribute('aria-describedby')).toBe(within(rice).getByText(copy).id);
    expect(within(juice).queryByText(copy)).toBeNull();
    expect(juice.hasAttribute('aria-describedby')).toBe(false);
    if (available) {
      fireEvent.click(screen.getByRole('button', { name: 'Remove one Rice' }));
      await screen.findByRole('button', { name: 'Place cash order · GY$1,100' });
      expect(within(rice).getByText(copy)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Remove one Rice' }));
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Remove Rice from cart' }));
    }
    const place = await screen.findByRole('button', { name: available ? 'Place cash order · GY$700' : 'Place cash order · GY$300' });
    expect(screen.queryByText(copy)).toBeNull();
    expect(cart.items.find((item) => item.id === 'juice')?.quantity).toBe(2);
    expect(cart.items.find((item) => item.id === 'juice')?.selectedOptionNames).toEqual(['Large']);
    fireEvent.click(place);
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/orders/o1'));
    expect(orderedItems).toEqual(available ? ['rice', 'juice'] : ['juice']);
    expect(requests.filter((r) => r.path.endsWith('/checkout')).map((r) => r.body)).toEqual([
      { paymentMethod: 'CASH', tipAmount: 0 }, { paymentMethod: 'CASH', tipAmount: 0 },
    ]);
  });
});


describe('AX348 retained checkout resolution', () => {
  const receiptPath = '/api/v1/customer/checkout/receipts/';

  it('resolves a 408 with its own key before using a different saved tip on remount', async () => {
    cart.items = [cart.items[1]!]; cart.subtotalCustomer = 800;
    let firstKey = '';
    let receiptStatus = 'in_flight';
    let submitted = 0;
    special = ({ url, init }) => {
      if (url.pathname.startsWith(receiptPath)) {
        expect(url.pathname).toBe(receiptPath + firstKey);
        return ok({ status: receiptStatus });
      }
      if (url.pathname.endsWith('/checkout')) {
        submitted++;
        const key = (init?.headers as Record<string, string>)['Idempotency-Key']!;
        if (submitted === 1) {
          firstKey = key;
          expect(JSON.parse(String(init?.body)).tipAmount).toBe(200);
          return { status: 408, body: { success: false, error: { code: 'REQUEST_TIMEOUT', message: 'Request timed out' } } };
        }
        expect(key).not.toBe(firstKey);
        expect(JSON.parse(String(init?.body))).toEqual({ paymentMethod: 'CASH', tipAmount: 500 });
      }
      return null;
    };
    const first = render(<CartPage />);
    await screen.findByRole('button', { name: 'Place cash order · GY$900' });
    fireEvent.click(screen.getByRole('button', { name: 'GY$200' }));
    fireEvent.click(screen.getByRole('button', { name: 'Place cash order · GY$1,100' }));
    await screen.findByRole('button', { name: 'Retry check' });
    expect(readCheckoutAttempt()?.key).toBe(firstKey);
    first.unmount();
    cart.tipAmount = 500;
    receiptStatus = 'none';
    render(<CartPage />);
    const fresh = await screen.findByRole('button', { name: 'Place cash order · GY$1,400' });
    expect(readCheckoutAttempt()).toBeNull();
    expect(screen.getByRole('button', { name: 'GY$500' }).getAttribute('aria-pressed')).toBe('true');
    expect(cart.items[0]?.selectedOptionNames).toEqual(['Large']);
    expect(requests.filter((r) => r.path.startsWith(receiptPath))).toHaveLength(2);
    fireEvent.click(fresh);
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/orders/o1'));
    expect(submitted).toBe(2);
  });

  it('shows the committed receipt after a timeout and reload with an empty cart', async () => {
    cart.items = [cart.items[1]!]; cart.subtotalCustomer = 800;
    let committed = false;
    let key = '';
    special = ({ url, init }) => {
      if (url.pathname.endsWith('/checkout')) {
        key = (init?.headers as Record<string, string>)['Idempotency-Key']!;
        return { status: 504, body: { success: false, error: { message: 'Gateway timeout' } } };
      }
      if (url.pathname.startsWith(receiptPath)) {
        expect(url.pathname).toBe(receiptPath + key);
        return ok(committed ? { status: 'placed', orderIds: ['receipt-order'] } : { status: 'in_flight' });
      }
      return null;
    };
    const first = render(<CartPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Place cash order · GY$900' }));
    await screen.findByRole('button', { name: 'Retry check' });
    expect(readCheckoutAttempt()?.key).toBe(key);
    first.unmount();
    committed = true;
    cart.items = [];
    render(<CartPage />);
    await screen.findByRole('heading', { name: 'Order placed' });
    expect(screen.getByRole('link', { name: 'View order' }).getAttribute('href')).toBe('/orders/receipt-order');
    expect(screen.queryByText('Your cart is empty')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Browse Swift' })).toBeNull();
    expect(readCheckoutAttempt()).toBeNull();
    expect(requests.filter((r) => r.path.endsWith('/checkout'))).toHaveLength(1);
  });

  it.each(['in_flight', 'unreachable', 'malformed'])('keeps %s receipts unknown until Retry check proves none, even with an empty cart', async (answer) => {
    cart.items = [];
    const attempt = { signature: 'old-tip-and-options', key: 'pending-attempt-key' };
    persistCheckoutAttempt(attempt);
    let resolved = false;
    special = ({ url }) => {
      if (!url.pathname.startsWith(receiptPath)) return null;
      expect(url.pathname).toBe(receiptPath + attempt.key);
      if (resolved) return ok({ status: 'none' });
      if (answer === 'unreachable') throw new TypeError('Failed to fetch');
      return ok(answer === 'malformed' ? { status: 'placed', orderIds: [] } : { status: 'in_flight' });
    };
    render(<CartPage />);
    const retry = await screen.findByRole('button', { name: 'Retry check' });
    expect(screen.getByRole('heading', { name: "We're checking your last order" })).toBeTruthy();
    expect(readCheckoutAttempt()).toEqual(attempt);
    expect(screen.queryByText('Your cart is empty')).toBeNull();
    expect(screen.queryByRole('button', { name: /Place cash order/ })).toBeNull();
    expect(requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
    resolved = true;
    fireEvent.click(retry);
    await screen.findByText('Your cart is empty');
    expect(readCheckoutAttempt()).toBeNull();
    expect(requests.filter((r) => r.path.startsWith(receiptPath))).toHaveLength(2);
  });

  it('shows AUTH_UNAVAILABLE guidance with Retry and starts a fresh attempt', async () => {
    cart.items = [cart.items[1]!]; cart.subtotalCustomer = 800;
    const keys: string[] = [];
    special = ({ url, init }) => {
      if (!url.pathname.endsWith('/checkout')) return null;
      keys.push((init?.headers as Record<string, string>)['Idempotency-Key']!);
      return keys.length === 1 ? { status: 503, body: { success: false, error: {
        code: 'AUTH_UNAVAILABLE', message: 'Sign-in is temporarily unavailable. Please retry shortly.',
      } } } : null;
    };
    render(<CartPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Place cash order · GY$900' }));
    await screen.findByText('Sign-in is temporarily unavailable. Please retry shortly.');
    expect(screen.queryByText(/Could not confirm your order/)).toBeNull();
    expect(readCheckoutAttempt()).toBeNull();
    expect(requests.filter((r) => r.path.startsWith(receiptPath))).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/orders/o1'));
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it.each([
    ['INSUFFICIENT_STOCK', 'Rice just sold out — please update your cart.', { itemId: 'i2' }, 'Not enough Rice left — reduce the quantity or remove it'],
    ['ITEM_UNAVAILABLE', 'Rice is no longer available — remove it to continue', { itemId: 'i2' }, 'Rice is no longer available — remove it to continue'],
    ['ITEM_UNAVAILABLE', 'Rice just became unavailable — remove it and try again.', undefined, 'Rice is no longer available — remove it to continue'],
  ])('names and marks the refused row for %s without inventing a count', async (code, message, details, copy) => {
    cart.items = [
      { ...cart.items[1]!, name: 'Rice', quantity: 3 },
      { ...cart.items[1]!, id: 'juice', itemId: 'juice', name: 'Juice' },
    ];
    cart.subtotalCustomer = 3200;
    special = ({ url }) => {
      if (url.pathname.endsWith('/vendors/s2')) return ok({ ...menu, categories: [{ items: [{ id: 'i2' }, { id: 'juice' }] }] });
      if (url.pathname.endsWith('/checkout')) return { status: 409, body: { success: false, error: { code, message, ...(details ? { details } : {}) } } };
      return null;
    };
    render(<CartPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Place cash order · GY$3,300' }));
    await screen.findAllByText(String(copy));
    const rice = screen.getByText('Rice').closest('article')!;
    const juice = screen.getByText('Juice').closest('article')!;
    expect(within(rice).getByText(String(copy))).toBeTruthy();
    expect(rice.getAttribute('aria-describedby')).toBe(within(rice).getByText(String(copy)).id);
    expect(juice.hasAttribute('aria-describedby')).toBe(false);
    expect(document.body.textContent).not.toMatch(/Only \d+ Rice/);
    expect(readCheckoutAttempt()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Rice from cart' }));
    await waitFor(() => expect(screen.queryByText('Rice')).toBeNull());
    expect(screen.queryByText(String(copy))).toBeNull();
  });
});


describe('AX354 checkout response context changes', () => {
  it.each(['placed', 'in_flight', 'none'])('probes the sent key after a store change and resolves %s', async (status) => {
    cart.items = [cart.items[1]!]; cart.subtotalCustomer = 800;
    let key = '';
    special = ({ url, init }) => {
      if (url.pathname.endsWith('/checkout')) {
        key = (init?.headers as Record<string, string>)['Idempotency-Key']!;
        // The order response succeeds, but another tab changes the selected
        // business before apiFetch accepts it. This is NOT a server refusal.
        setSelectedStore('different-dashboard-store');
        return ok({ order: { id: 'committed-order' } });
      }
      if (url.pathname.startsWith('/api/v1/customer/checkout/receipts/')) {
        expect(url.pathname).toBe('/api/v1/customer/checkout/receipts/' + key);
        expect(readCheckoutAttempt()?.key).toBe(key);
        return ok({ status, ...(status === 'placed' ? { orderIds: ['committed-order'] } : {}) });
      }
      return null;
    };
    render(<CartPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Place cash order · GY$900' }));
    await waitFor(() => expect(requests.filter((r) => r.path.startsWith('/api/v1/customer/checkout/receipts/'))).toHaveLength(1));
    if (status === 'placed') {
      await screen.findByRole('heading', { name: 'Order placed' });
      expect(navigation.push).toHaveBeenCalledWith('/orders/committed-order');
      expect(readCheckoutAttempt()).toBeNull();
    } else if (status === 'in_flight') {
      await screen.findByRole('button', { name: 'Retry check' });
      expect(readCheckoutAttempt()?.key).toBe(key);
      expect(screen.queryByRole('button', { name: /Place cash order/ })).toBeNull();
      expect(navigation.push).not.toHaveBeenCalled();
    } else {
      await screen.findByRole('button', { name: 'Place cash order · GY$900' });
      expect(readCheckoutAttempt()).toBeNull();
      expect(navigation.push).not.toHaveBeenCalled();
    }
    expect(requests.filter((r) => r.path.endsWith('/checkout'))).toHaveLength(1);
  });
});
