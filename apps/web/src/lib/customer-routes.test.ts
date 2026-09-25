import { describe, expect, it } from 'vitest';
import { customerRoute, signInPath, signUpPath } from './customer-routes';

// ---------------------------------------------------------------------------
// [Q7b] Where every page of the customer app sits. Browsing is public, like
// the phone app; anything that belongs to an account is private; and a page
// nobody listed is private too — a forgotten entry costs a guest one tap,
// never an account's data.
// ---------------------------------------------------------------------------

describe('[Q7b] the customer route map', () => {
  it('lets a guest browse: Home, the store lists, search, a store, Market and the taxi explainer', () => {
    for (const path of ['/', '/order', '/order/browse', '/order/search', '/order/vendor/v1', '/explore', '/taxi', '/market']) {
      expect(customerRoute(path).public, path).toBe(true);
    }
  });

  it('keeps everything that belongs to an account private', () => {
    for (const path of ['/cart', '/account', '/orders', '/orders/o1', '/order/location', '/courier']) {
      expect(customerRoute(path).public, path).toBe(false);
    }
  });

  it('treats a page nobody listed as private', () => {
    for (const path of ['/wallet', '/order/vendor', '/order/vendor/', '/market/goods', '/orders/o1/receipt', '/cart/extra']) {
      expect(customerRoute(path).public, path).toBe(false);
    }
  });

  it('lights the phone app’s tabs: stores under Home, orders and addresses under Profile', () => {
    expect(customerRoute('/').tab).toBe('home');
    expect(customerRoute('/order/vendor/v1').tab).toBe('home');
    expect(customerRoute('/market').tab).toBe('market');
    expect(customerRoute('/cart').tab).toBe('cart');
    expect(customerRoute('/account').tab).toBe('profile');
    expect(customerRoute('/orders/o1').tab).toBe('profile');
    expect(customerRoute('/order/location').tab).toBe('profile');
  });

  it('sends each back button to the page above it, and gives a tab’s first page none', () => {
    expect(customerRoute('/order/vendor/v1').parent).toBe('/');
    expect(customerRoute('/cart').parent).toBe('/');
    expect(customerRoute('/orders/o1').parent).toBe('/orders');
    expect(customerRoute('/orders').parent).toBe('/account');
    expect(customerRoute('/order/location').parent).toBe('/account');
    for (const root of ['/', '/market', '/account']) expect(customerRoute(root).parent, root).toBeNull();
  });

  it('tells a guest what a private page is for', () => {
    expect(customerRoute('/cart').door.title).toBe('Sign in to start a cart');
    expect(customerRoute('/account').door.title).toBe('You’re browsing as a guest');
    expect(customerRoute('/orders/o1').door.title).toBe('Sign in to track this order');
    expect(customerRoute('/wallet').door.title).toBe('Sign in to continue');
  });

  it('brings the person back to exactly where they were after signing in or up', () => {
    expect(signInPath('/order/vendor/v1?item=i1')).toBe('/login?next=%2Forder%2Fvendor%2Fv1%3Fitem%3Di1');
    expect(signUpPath('/cart')).toBe('/signup?next=%2Fcart');
  });
});
