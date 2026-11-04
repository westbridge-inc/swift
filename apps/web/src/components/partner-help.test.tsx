import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { Bell } from 'lucide-react';
import { mockApi } from '@/test/test-utils';
import { PartnerHelp } from './partner-help';
import { NAV } from '@/app/portal/portal-shell';
import { dashboardNav } from '@/app/dashboard/dashboard-shell';

// [BUG-HUNT F04] A partner reaches a person from their own console, with the same requests the phone shows.
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), usePathname: () => '/portal/help', useSearchParams: () => new URLSearchParams() }));

const draw = () => render(<QueryClientProvider client={new QueryClient()}><PartnerHelp /></QueryClientProvider>);

describe('[BUG-HUNT F04] the door', () => {
  it('the rider and driver portal has it, in the rail and the menu, not the phone dock', () => {
    expect(NAV.find((item) => item.label === 'Help')).toMatchObject({ href: '/portal/help', dock: false });
  });

  it.each([['OWNER'], ['MANAGER'], ['STAFF'], [undefined]] as const)('the store console has it for %s', (role) => {
    expect(dashboardNav('Menu', role).find((item) => item.label === 'Help')).toMatchObject({ href: '/dashboard/help', dock: false });
  });

  it('adds no icon a console page did not already load: the first-load ceilings have no room', () => {
    expect(NAV.find((item) => item.label === 'Help')!.icon).toBe(Bell);
    expect(dashboardNav('Menu', 'OWNER').find((item) => item.label === 'Help')!.icon).toBe(Bell);
  });
});

describe('[BUG-HUNT F04] the page', () => {
  it('sends a request and shows the person their requests', async () => {
    const sent: unknown[] = [];
    mockApi(({ url, method, init }) => {
      if (url.pathname === '/api/v1/customer/support' && method === 'POST') { sent.push(init?.body); return { body: { success: true, data: { id: 't1', status: 'OPEN' } } }; }
      if (url.pathname === '/api/v1/customer/support') return { body: { success: true, data: [] } };
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    });
    draw();
    expect(await screen.findByText('No requests yet.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Help' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Short summary'), { target: { value: 'My fee looks wrong' } });
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'The amount does not match my plan.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));
    expect(await screen.findByRole('status')).toBeTruthy();
    await waitFor(() => expect(sent).toHaveLength(1));
  });

  it('no link to a customer page a partner never passes through', async () => {
    mockApi(() => ({ body: { success: true, data: [] } }));
    draw();
    await screen.findByText('No requests yet.');
    expect(screen.queryByRole('link', { name: 'Find your order' })).toBeNull();
  });

  it('a failed read says so, it is not "No requests yet"', async () => {
    mockApi(() => ({ status: 500, body: { success: false } }));
    draw();
    await waitFor(() => expect(screen.queryByText('Loading requests…')).toBeNull());
    expect(screen.queryByText('No requests yet.')).toBeNull();
  });
});
