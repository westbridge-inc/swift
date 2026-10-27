import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { AppShell } from './AppShell';
import { ReasonDialogProvider } from '@/components/mc/ReasonDialog';

// [ADMIN-AUDIT S3-2 · REVIEW-F #2154 S4-1] The REAL shell carries the attested role to ⌘K (AppShell -> Header ->
// SearchLauncher), so the founder is offered the founder pages there and an ADMIN is not.
const fx = vi.hoisted(() => ({ pathname: '/dashboard', replace: vi.fn(), push: vi.fn(), probe: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => fx.pathname, useRouter: () => fx, useSearchParams: () => new URLSearchParams() }));
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api')>()), sessionProbe: fx.probe }));
vi.mock('./Sidebar', () => ({ Sidebar: () => <aside>Admin navigation</aside> }));

function shell(role: 'ADMIN' | 'SUPER_ADMIN') {
  fx.probe.mockResolvedValue({ ok: true, user: { id: `synthetic-${role}`, activeRole: role, roles: [role] } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><ReasonDialogProvider>{children}</ReasonDialogProvider></QueryClientProvider>;
  return render(<AppShell><p>Workspace</p></AppShell>, { wrapper: Wrapper });
}

async function search(text: string) {
  const user = userEvent.setup();
  await screen.findByText('Workspace');
  await user.click(screen.getByRole('button', { name: /Search everything/ }));
  await user.type(screen.getByRole('combobox', { name: 'Search everything' }), text);
  return within(screen.getByRole('listbox', { name: 'Results' }));
}

describe('[ADMIN-AUDIT S3-2] the shell wires the role into ⌘K', () => {
  it('the founder is offered Config in ⌘K', async () => {
    shell('SUPER_ADMIN');
    expect((await search('config')).getByText('Config')).toBeTruthy();
  });
  it('an ADMIN is not', async () => {
    shell('ADMIN');
    expect((await search('config')).queryByText('Config')).toBeNull();
  });
});
