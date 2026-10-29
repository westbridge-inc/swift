import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S3-2] Founder pages are offered to the founder only.
//
// Promos, Background jobs, Zones, Config and Integrity read founder controls
// (the API's platformControlGuard: SUPER_ADMIN of the default tenant). An ADMIN
// saw all five in the sidebar and ⌘K and was refused on each, after waiting.
// The server still refuses; the console stops offering what it will refuse.
// ---------------------------------------------------------------------------

const nav = vi.hoisted(() => ({ pathname: '/dashboard', push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => nav }));

import { Sidebar } from './Sidebar';
import { SearchLauncher } from './CommandPalette';

const FOUNDER = ['Promos', 'Background jobs', 'Zones', 'Config', 'Integrity'];
const links = () => within(screen.getByRole('navigation', { name: 'Mission Control' })).getAllByRole('link').map((a) => a.textContent);

describe('[ADMIN-AUDIT S3-2] founder pages in the sidebar', () => {
  it('an ADMIN is not offered the five founder pages, and keeps every other one', () => {
    render(<Sidebar role="ADMIN" />);
    for (const page of FOUNDER) expect(links(), page).not.toContain(page);
    for (const page of ['Today', 'Documents', 'Approvals', 'Subscribers', 'Ops alerts', 'Audit log', 'Markets', 'Ads review']) expect(links(), page).toContain(page);
  });

  it('the founder (SUPER_ADMIN) is offered all of them', () => {
    render(<Sidebar role="SUPER_ADMIN" />);
    for (const page of FOUNDER) expect(links(), page).toContain(page);
  });

  it('while the role is still being checked, nothing founder-only is offered', () => {
    render(<Sidebar role={null} />);
    for (const page of FOUNDER) expect(links(), page).not.toContain(page);
  });
});

describe('[ADMIN-AUDIT S3-2] founder pages in ⌘K', () => {
  it('an ADMIN typing "config" is not offered the Config page; the founder is', async () => {
    const admin = renderWithQuery(<SearchLauncher role="ADMIN" />);
    await admin.user.click(screen.getByRole('button', { name: /Search everything/ }));
    await admin.user.type(screen.getByRole('combobox', { name: 'Search everything' }), 'config');
    expect(within(screen.getByRole('listbox', { name: 'Results' })).queryByText('Config')).toBeNull();
    admin.unmount();

    const founder = renderWithQuery(<SearchLauncher role="SUPER_ADMIN" />);
    await founder.user.click(screen.getByRole('button', { name: /Search everything/ }));
    await founder.user.type(screen.getByRole('combobox', { name: 'Search everything' }), 'config');
    expect(within(screen.getByRole('listbox', { name: 'Results' })).getByText('Config')).toBeTruthy();
  });
});
