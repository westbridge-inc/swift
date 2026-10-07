import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · shell] The sidebar in the owner's design groups, a header
// that names the screen, ⌘K search over the endpoints that exist, and no
// calls anywhere in the console.
// ---------------------------------------------------------------------------

const nav = vi.hoisted(() => ({ pathname: '/vendors/vendor-1', push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => nav }));

import { Sidebar } from './Sidebar';
import { SearchLauncher } from './CommandPalette';
import { NAV_GROUPS, navItemFor } from './nav';

const SRC = join(process.cwd(), 'src');

describe('[MC shell] the sidebar', () => {
  it('has the design groups in order: Briefing, Queues, Records, Money, Operations, System', () => {
    expect(NAV_GROUPS.map((g) => g.title)).toEqual(['Briefing', 'Queues', 'Records', 'Money', 'Operations', 'System']);
  });

  it('lists only screens that exist — every item opens a real page', () => {
    for (const item of NAV_GROUPS.flatMap((g) => g.items)) {
      expect(existsSync(join(SRC, 'app', item.href.slice(1), 'page.tsx')), item.href).toBe(true);
      expect(item.blurb.length, item.label).toBeGreaterThan(10);
    }
  });

  it('marks the current screen (a store page is under Businesses) and names the role in plain words', () => {
    render(<Sidebar role="SUPER_ADMIN" />);
    const current = screen.getByRole('link', { current: 'page' });
    expect(current.textContent).toBe('Businesses');
    expect(current.getAttribute('href')).toBe('/vendors');
    expect(screen.getByText('Super admin')).toBeTruthy();
    expect(screen.queryByText('SUPER_ADMIN')).toBeNull();
  });

  it('the longest matching section wins', () => {
    expect(navItemFor('/verification')?.label).toBe('Documents');
    expect(navItemFor('/orders/abc')?.label).toBe('Orders');
    expect(navItemFor('/nowhere')).toBeNull();
  });
});

describe('[MC shell] ⌘K search', () => {
  const results = {
    orders: [{ id: 'o1', orderNumber: 'SW-1001', status: 'RIDER_EN_ROUTE_PICKUP', orderType: 'FOOD_DELIVERY', totalAmount: 4500, placedAt: '2026-10-01T00:00:00Z' }],
    users: [{ id: 'u1', firstName: 'Test', lastName: 'Person', phone: '+5920001234', roles: ['VENDOR_OWNER'], status: 'ACTIVE' }],
    vendors: [{ id: 'v1', name: 'Test Store', vendorType: 'RESTAURANT', status: 'PENDING_APPROVAL', city: 'Georgetown' }],
  };

  it('⌘K opens it; screens match as you type; the server results are in plain words with phones masked; Enter goes there', async () => {
    mockApi(() => ({ body: { success: true, data: results } }));
    const { user } = renderWithQuery(<SearchLauncher />);
    await user.keyboard('{Meta>}k{/Meta}');
    const box = screen.getByRole('combobox', { name: 'Search everything' });
    expect(document.activeElement).toBe(box);
    await user.type(box, 'tes');
    const list = screen.getByRole('listbox', { name: 'Results' });
    await waitFor(() => expect(within(list).getByText('SW-1001')).toBeTruthy());
    expect(within(list).getByText('Food delivery · Rider on the way to pick up · G$4,500')).toBeTruthy();
    expect(within(list).getByText('••• ••• 1234 · Business owner · Active')).toBeTruthy();
    expect(within(list).getByText('Restaurant · Georgetown · Waiting for approval')).toBeTruthy();
    expect(list.textContent).not.toMatch(/\+5920001234|PENDING_APPROVAL|FOOD_DELIVERY/);
    // ↓ to the order (the first server row), Enter
    const options = within(list).getAllByRole('option');
    const orderIndex = options.findIndex((o) => o.textContent?.includes('SW-1001'));
    for (let i = 0; i < orderIndex; i++) await user.keyboard('{ArrowDown}');
    expect(options[orderIndex]!.getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Enter}');
    expect(nav.push).toHaveBeenCalledWith('/orders/o1');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a screen can be reached by what it is for', async () => {
    mockApi(() => ({ body: { success: true, data: { orders: [], users: [], vendors: [] } } }));
    const { user } = renderWithQuery(<SearchLauncher />);
    await user.click(screen.getByRole('button', { name: /Search everything/ }));
    await user.type(screen.getByRole('combobox'), 'weekly fee');
    expect(within(screen.getByRole('listbox')).getByText('Subscribers')).toBeTruthy();
  });

  it('a failed search says so — never "nothing matches"', async () => {
    mockApi(() => ({ status: 503, body: { success: false, error: { code: 'AUTH_UNAVAILABLE', message: 'We could not verify your session right now.' } } }));
    const { user } = renderWithQuery(<SearchLauncher />);
    await user.click(screen.getByRole('button', { name: /Search everything/ }));
    await user.type(screen.getByRole('combobox'), 'test');
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn't search orders, people and businesses: Swift can't do this right now/);
    expect(screen.queryByText(/No orders, people or businesses match/)).toBeNull();
  });
});

describe('[MC shell] calls are not a console feature (owner ruling, 6 Oct)', () => {
  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [join(dir, e.name)] : []);
  }
  it('no click-to-call link anywhere in the console', () => {
    const offenders = files(SRC).filter((f) => /href=\{?[`'"]tel:/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

it('names the cash screen for received agent money only', () => {
  expect(navItemFor('/cash')?.label).toBe('Received agent cash');
  expect(navItemFor('/cash')?.blurb).toBe('Attach or refund cash already received');
});
