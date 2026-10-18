import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AppLayout from './layout';

// ---------------------------------------------------------------------------
// [PERF #4] The cart's and an order's loading shapes (with their pages'
// stylesheets) rode in EVERY page's first load, Home and the store page
// included, though the frame draws them only while one of those private pages
// waits for the session answer. They now come with the page that shows them.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({ pathname: '/cart', sessionProbe: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/lib/auth', () => ({
  sessionProbe: state.sessionProbe,
  restoreSession: vi.fn().mockResolvedValue({ ok: false }),
  getSessionPrincipal: () => null,
  subscribeSession: () => () => undefined,
}));
vi.mock('@/components/swift-logo', () => ({ SwiftLogo: () => <span>Swift</span> }));

beforeEach(() => {
  // The session answer never comes: the frame keeps the page's loading shape up.
  state.sessionProbe.mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: { visible: false, items: 0, vendors: 0 } }))));
});

describe('[PERF #4] private pages’ loading shapes are not in every page’s first load', () => {
  it('the frame does not import the cart’s or an order’s loading shape (or their stylesheets) up front', () => {
    const source = readFileSync(join(__dirname, 'layout.tsx'), 'utf8');
    const staticImports = source.split('\n').filter((line) => /^import\s/.test(line)).join('\n');
    expect(staticImports).not.toMatch(/cart\/loading|orders\/\[id\]\/loading|cart\.module\.css|tracking\.module\.css/);
    expect(source).toMatch(/dynamic\(\(\) => import\('\.\/cart\/loading'\)/);
    expect(source).toMatch(/dynamic\(\(\) => import\('\.\/orders\/\[id\]\/loading'\)/);
  });

  it('an order page still shows its own loading shape while the session answer is out', async () => {
    state.pathname = '/orders/o1';
    render(<AppLayout><p>Private page</p></AppLayout>);
    expect(await screen.findByLabelText('Loading order tracking')).toBeTruthy();
    expect(screen.queryByText('Private page')).toBeNull();
  });
});
