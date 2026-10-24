import { describe, expect, it, vi } from 'vitest';

// Owner ruling (11 Oct 2026): the web "Today" page merges into the Orders home,
// as the app has no separate Today. The Account tab opens the store's settings page until the app's
// Account screen lands (PR D); that page stays where it is.
const fx = vi.hoisted(() => ({ redirect: vi.fn((to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); }) }));
vi.mock('next/navigation', () => ({ redirect: fx.redirect, usePathname: () => '/dashboard', useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

describe('the business console keeps the app\'s four places', () => {
  it('sends the old Today page to the Orders home', async () => {
    const { default: Today } = await import('./page');
    expect(() => Today()).toThrow('NEXT_REDIRECT /dashboard/orders');
    expect(fx.redirect).toHaveBeenCalledWith('/dashboard/orders');
  });
  it('serves an Insights page', async () => {
    expect((await import('./insights/page')).default).toBeTypeOf('function');
  });
});
