import { describe, expect, it, vi } from 'vitest';

// Owner ruling (11 Oct 2026): the web "Today" page merges into the Orders home,
// as the app has no separate Today; Settings becomes the app's "Account".
const fx = vi.hoisted(() => ({ redirect: vi.fn((to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); }) }));
vi.mock('next/navigation', () => ({ redirect: fx.redirect, usePathname: () => '/dashboard', useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

describe('the business console keeps the app\'s four places', () => {
  it('sends the old Today page to the Orders home', async () => {
    const { default: Today } = await import('./page');
    expect(() => Today()).toThrow('NEXT_REDIRECT /dashboard/orders');
    expect(fx.redirect).toHaveBeenCalledWith('/dashboard/orders');
  });
  it('sends the old Settings page to Account', async () => {
    const { default: Settings } = await import('./settings/page');
    expect(() => Settings()).toThrow('NEXT_REDIRECT /dashboard/account');
  });
  it('serves Account and an Insights page', async () => {
    expect((await import('./account/page')).default).toBeTypeOf('function');
    expect((await import('./insights/page')).default).toBeTypeOf('function');
  });
});
