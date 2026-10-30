import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LayoutDashboard, ClipboardList } from 'lucide-react';
import { ConsoleShell } from './console-shell';
import { axeViolations } from '@/test/axe';

let pathname = '/dashboard';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

describe('ConsoleShell phone navigation', () => {
  beforeEach(() => { pathname = '/dashboard'; });

  it('[ENTERPRISE E3 · REVIEW-F #2228 S3-2] printing prints the page alone: sidebar, header, offline notice, footer and the tab bar are hidden in print', () => {
    const { container } = render(<ConsoleShell home="/dashboard" title="Business" contentKey="store-a"
      navigation={[{ href: '/dashboard', label: 'Today', icon: LayoutDashboard, exact: true }]}
      switcher={<button>Store A</button>} signOutBody="End this browser session.">
      <p>Statement content</p>
    </ConsoleShell>);
    const chrome = [
      container.querySelector('aside'), container.querySelector('header'), container.querySelector('footer'),
      screen.getByRole('navigation', { name: 'Business tabs' }), container.querySelector('main > div'),
    ];
    for (const el of chrome) expect(el?.className ?? '', el?.outerHTML.slice(0, 80)).toMatch(/(^|\s)print:!?hidden(\s|$)/);
    expect(screen.getByText('Statement content').closest('[class*="print:hidden"]')).toBeNull();
  });

  it('opens an accessible drawer with the same data-driven routes and store switcher', () => {
    render(<ConsoleShell home="/dashboard" title="Business" contentKey="store-a"
      navigation={[
        { href: '/dashboard', label: 'Today', icon: LayoutDashboard, exact: true },
        { href: '/dashboard/orders', label: 'Orders', icon: ClipboardList, exact: false },
      ]}
      switcher={<button>Store A</button>} signOutBody="End this browser session.">
      <p>Today content</p>
    </ConsoleShell>);

    const trigger = screen.getByRole('button', { name: 'Open menu' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    const drawer = screen.getByRole('dialog', { name: 'Business menu' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(drawer.querySelector('a[href="/dashboard/orders"]')?.textContent).toBe('Orders');
    expect(drawer.textContent).toContain('Store A');
    expect(drawer.querySelector('a[aria-current="page"]')?.textContent).toBe('Today');
    fireEvent.keyDown(drawer, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Business menu' })).toBeNull();
  });
});

// [Row 111 · W8] The partner consoles' frame (store dashboard, mover portal, advertiser), menu closed and open.
describe('[W8] the console shell is accessible', () => {
  it('has no accessibility violations axe can find, closed or with the menu open', async () => {
    pathname = '/dashboard';
    render(<ConsoleShell home="/dashboard" title="Business" contentKey="store-a"
      navigation={[
        { href: '/dashboard', label: 'Today', icon: LayoutDashboard, exact: true },
        { href: '/dashboard/orders', label: 'Orders', icon: ClipboardList, exact: false },
      ]}
      switcher={<button>Store A</button>} signOutBody="End this browser session.">
      <h1>Today</h1>
    </ConsoleShell>);
    expect(await axeViolations(document.body, { page: true })).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
