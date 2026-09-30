import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LayoutDashboard, ClipboardList } from 'lucide-react';
import { ConsoleShell } from './console-shell';

let pathname = '/dashboard';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

describe('ConsoleShell phone navigation', () => {
  beforeEach(() => { pathname = '/dashboard'; });

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
