import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import TodayPage from './page';
import InventoryPage from './inventory/page';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [PERF row 562] A tap answers on screen within 100 ms. A safe, reversible
// switch (store open, accepting orders, an item in stock) used to move only
// after the server's answer AND a fresh read: two round trips abroad. Now it
// moves at the tap, waits dimmed for the server, and goes back with the
// server's words if refused. Money and dispatch never show success early.
// ---------------------------------------------------------------------------

const TAP_BUDGET = { timeout: 100 };
/** Holds page reads while set, so a test can tell a rollback from a re-read. */
const readGate = { hold: false, held: [] as Array<() => void> };
const gated = <T,>(reply: T): T | Promise<T> => (readGate.hold ? new Promise<T>((resolve) => { readGate.held.push(() => resolve(reply)); }) : reply);
type Hold = { release: (_reply?: { status?: number; body: unknown }) => void };

function held(): { hold: Hold; reply: Promise<{ status?: number; body: unknown }> } {
  let release!: Hold['release'];
  const reply = new Promise<{ status?: number; body: unknown }>((resolve) => { release = (r) => resolve(r ?? { body: { success: true, data: {} } }); });
  return { hold: { release }, reply };
}

function storeApi(server: { isCurrentlyOpen: boolean; acceptingOrders: boolean }, counts: { overview: number }, holds: Hold[]) {
  return mockApi(({ url, method }) => {
    if (url.pathname === '/api/v1/vendor/analytics/overview') {
      counts.overview += 1;
      return gated({ body: { data: { vendor: { ...server, averageRating: 0, totalRatings: 0, totalOrders: 0 }, today: { orders: 0, revenue: 0 }, week: { orders: 0, revenue: 0 }, month: { orders: 0, revenue: 0 }, activeMenuItems: 0, pendingOrders: 0, queueValue: 0 } } });
    }
    if (url.pathname === '/api/v1/vendor/inventory/low-stock') return { body: { data: [] } };
    if (url.pathname === '/api/v1/vendor/stores') return { body: { data: { stores: [], selectedId: null, myRole: 'OWNER' } } };
    // Like the server: the switch FLIPS what the server holds (the body is not read) and answers with both flags.
    const toggle = /\/vendor\/vendor\/toggle-(open|orders)$/.exec(url.pathname);
    if (method === 'PUT' && toggle) {
      const field = toggle[1] === 'open' ? 'isCurrentlyOpen' : 'acceptingOrders';
      const { hold, reply } = held();
      holds.push(hold);
      return reply.then((r) => {
        if ((r.status ?? 200) >= 400) return r;
        server[field] = !server[field];
        return { body: { success: true, data: { isCurrentlyOpen: server.isCurrentlyOpen, acceptingOrders: server.acceptingOrders } } };
      });
    }
    if (url.pathname === '/api/v1/vendor/catalogue-name') return { body: { data: null } };
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
}

afterEach(() => { readGate.hold = false; readGate.held.splice(0).forEach((release) => release()); });

describe('the store switches on Today', () => {
  it('Store open moves at the tap, dimmed until the server confirms, and stays after it does', async () => {
    const server = { isCurrentlyOpen: false, acceptingOrders: true };
    const counts = { overview: 0 };
    const holds: Hold[] = [];
    storeApi(server, counts, holds);
    renderWithQuery(<TodayPage />);
    const open = await screen.findByRole('switch', { name: 'Store open' });
    expect(open.getAttribute('aria-checked')).toBe('false');
    const readsBefore = counts.overview;

    fireEvent.click(open);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Store open' }).getAttribute('aria-checked')).toBe('true'), TAP_BUDGET);
    expect(screen.getByRole('switch', { name: 'Store open' }).hasAttribute('disabled')).toBe(true);
    expect(counts.overview).toBe(readsBefore); // moved before any answer or re-read

    await act(async () => { holds[0]!.release(); });
    await waitFor(() => expect(counts.overview).toBe(readsBefore + 1)); // re-read after the answer
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Store open' }).hasAttribute('disabled')).toBe(false));
    expect(screen.getByRole('switch', { name: 'Store open' }).getAttribute('aria-checked')).toBe('true');
    expect(server.isCurrentlyOpen).toBe(true);
  });

  it('a refusal puts it back and says why in the server\'s words', async () => {
    const server = { isCurrentlyOpen: false, acceptingOrders: true };
    const holds: Hold[] = [];
    storeApi(server, { overview: 0 }, holds);
    renderWithQuery(<TodayPage />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Store open' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Store open' }).getAttribute('aria-checked')).toBe('true'), TAP_BUDGET);

    readGate.hold = true; // the re-read after the answer waits: the switch must go back on the refusal itself
    await act(async () => { holds[0]!.release({ status: 422, body: { success: false, error: { code: 'STORE_NOT_READY', message: 'Add a store phone number before opening.' } } }); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Add a store phone number before opening.'));
    expect(screen.getByRole('switch', { name: 'Store open' }).getAttribute('aria-checked')).toBe('false');
    expect(readGate.held.length).toBe(1);
    expect(server.isCurrentlyOpen).toBe(false);
  });

  it('a read already on its way at the tap does not put the old state back', async () => {
    const server = { isCurrentlyOpen: false, acceptingOrders: true };
    const holds: Hold[] = [];
    const gate = { hold: false, reads: [] as Array<() => void> };
    mockApi(({ url, method }) => {
      if (url.pathname === '/api/v1/vendor/analytics/overview') {
        const snapshot = { vendor: { ...server }, today: { orders: 0, revenue: 0 }, week: { orders: 0, revenue: 0 }, month: { orders: 0, revenue: 0 }, activeMenuItems: 0, pendingOrders: 0, queueValue: 0 };
        if (!gate.hold) return { body: { data: snapshot } };
        return new Promise((resolve) => { gate.reads.push(() => resolve({ body: { data: snapshot } })); });
      }
      if (url.pathname === '/api/v1/vendor/inventory/low-stock') return { body: { data: [] } };
      if (url.pathname === '/api/v1/vendor/stores') return { body: { data: { stores: [], selectedId: null, myRole: 'OWNER' } } };
      if (url.pathname === '/api/v1/vendor/catalogue-name') return { body: { data: null } };
      if (method === 'PUT' && url.pathname.endsWith('/toggle-open')) {
        const { hold, reply } = held();
        holds.push(hold);
        return reply.then(() => { server.isCurrentlyOpen = !server.isCurrentlyOpen; return { body: { success: true, data: { ...server } } }; });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    const { queryClient } = renderWithQuery(<TodayPage />);
    await screen.findByRole('switch', { name: 'Store open' });
    gate.hold = true;
    void queryClient.invalidateQueries({ predicate: (query) => JSON.stringify(query.queryKey).includes('overview') });
    await waitFor(() => expect(gate.reads.length).toBe(1)); // a poll is on its way with "closed"

    fireEvent.click(screen.getByRole('switch', { name: 'Store open' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Store open' }).getAttribute('aria-checked')).toBe('true'), TAP_BUDGET);
    await act(async () => { gate.reads[0]!(); await new Promise((resolve) => { setTimeout(resolve, 50); }); });
    expect(queryClient.isFetching()).toBe(0);
    expect(screen.getByRole('switch', { name: 'Store open' }).getAttribute('aria-checked')).toBe('true');

    gate.hold = false;
    await act(async () => { holds[0]!.release(); });
    await waitFor(() => expect(server.isCurrentlyOpen).toBe(true));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Store open' }).hasAttribute('disabled')).toBe(false));
    expect(screen.getByRole('switch', { name: 'Store open' }).getAttribute('aria-checked')).toBe('true');
  });

  it('the server\'s answer is shown at once, even when this screen was behind (the switch flips what the server holds)', async () => {
    const server = { isCurrentlyOpen: false, acceptingOrders: true };
    const holds: Hold[] = [];
    storeApi(server, { overview: 0 }, holds);
    renderWithQuery(<TodayPage />);
    await screen.findByRole('switch', { name: 'Store open' });
    server.isCurrentlyOpen = true; // another phone opened the store; this screen still shows it closed
    fireEvent.click(screen.getByRole('switch', { name: 'Store open' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Store open' }).getAttribute('aria-checked')).toBe('true'), TAP_BUDGET);
    readGate.hold = true; // the re-read waits: the answer itself must correct the screen
    await act(async () => { holds[0]!.release(); });
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Store open' }).hasAttribute('disabled')).toBe(false));
    expect(server.isCurrentlyOpen).toBe(false);
    expect(screen.getByRole('switch', { name: 'Store open' }).getAttribute('aria-checked')).toBe('false');
    expect(readGate.held.length).toBe(1);
  });

  it('Accepting orders moves at the tap too, and only that switch', async () => {
    const server = { isCurrentlyOpen: true, acceptingOrders: true };
    const holds: Hold[] = [];
    storeApi(server, { overview: 0 }, holds);
    renderWithQuery(<TodayPage />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Accepting orders' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Accepting orders' }).getAttribute('aria-checked')).toBe('false'), TAP_BUDGET);
    expect(screen.getByRole('switch', { name: 'Store open' }).getAttribute('aria-checked')).toBe('true');
    await act(async () => { holds[0]!.release(); });
    await waitFor(() => expect(server.acceptingOrders).toBe(false));
  });
});

describe('an item\'s in-stock switch', () => {
  function inventoryApi(server: Record<string, boolean>, holds: Array<Hold & { id: string }>) {
    return mockApi(({ url, method, init }) => {
      if (url.pathname === '/api/v1/vendor/items') {
        return gated({ body: { data: Object.entries(server).map(([id, isAvailable]) => ({ id, name: id === 'rice' ? 'Rice' : 'Beans', basePrice: '500.00', stockQuantity: null, isAvailable })) } });
      }
      if (url.pathname === '/api/v1/vendor/categories') return { body: { data: [] } };
      if (url.pathname === '/api/v1/vendor/stores') return { body: { data: { stores: [], selectedId: null, myRole: 'OWNER' } } };
      const m = /\/vendor\/items\/([\w-]+)\/availability$/.exec(url.pathname);
      if (method === 'PUT' && m) {
        const { isAvailable } = JSON.parse(String(init?.body ?? '{}'));
        const { hold, reply } = held();
        holds.push({ ...hold, id: m[1]! });
        return reply.then((r) => {
          if ((r.status ?? 200) < 400) server[m[1]!] = isAvailable;
          return r;
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
  }
  const sw = (name: string) => within(screen.getByRole('article', { name })).getByRole('switch', { name: `In stock: ${name}` });

  it('moves at the tap; while it waits, the other items stay usable', async () => {
    const server = { rice: true, beans: true };
    const holds: Array<Hold & { id: string }> = [];
    inventoryApi(server, holds);
    renderWithQuery(<InventoryPage />);
    await screen.findByText('Rice');

    fireEvent.click(sw('Rice'));
    await waitFor(() => expect(sw('Rice').getAttribute('aria-checked')).toBe('false'), TAP_BUDGET);
    expect(sw('Rice').hasAttribute('disabled')).toBe(true);
    expect(sw('Beans').hasAttribute('disabled')).toBe(false);

    fireEvent.click(sw('Beans'));
    await waitFor(() => expect(sw('Beans').getAttribute('aria-checked')).toBe('false'), TAP_BUDGET);

    await act(async () => { holds.forEach((h) => h.release()); });
    await waitFor(() => expect(sw('Rice').hasAttribute('disabled')).toBe(false));
    expect(server).toEqual({ rice: false, beans: false });
    await waitFor(() => expect(sw('Rice').getAttribute('aria-checked')).toBe('false'));
    expect(sw('Beans').getAttribute('aria-checked')).toBe('false');
  });

  it('a refusal puts that item back and says why', async () => {
    const server = { rice: false, beans: true };
    const holds: Array<Hold & { id: string }> = [];
    inventoryApi(server, holds);
    renderWithQuery(<InventoryPage />);
    await screen.findByText('Rice');
    fireEvent.click(sw('Rice'));
    await waitFor(() => expect(sw('Rice').getAttribute('aria-checked')).toBe('true'), TAP_BUDGET);
    readGate.hold = true; // the re-read waits: the switch goes back on the refusal itself
    await act(async () => { holds[0]!.release({ status: 422, body: { success: false, error: { code: 'ITEM_NOT_ALLOWED', message: 'Swift is checking this item first.' } } }); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Swift is checking this item first.'));
    expect(sw('Rice').getAttribute('aria-checked')).toBe('false');
    expect(readGate.held.length).toBe(1);
    expect(sw('Beans').getAttribute('aria-checked')).toBe('true');
  });
});

describe('money and dispatch never show success early', () => {
  it('only the safe switches use instantSwitch (store open, accepting orders, item in stock)', () => {
    const SRC = join(__dirname, '..', '..');
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
    const users = walk(SRC).filter((path) => readFileSync(path, 'utf8').includes('instantSwitch')).map((path) => path.slice(SRC.length + 1)).sort();
    expect(users).toEqual(['app/dashboard/inventory/page.tsx', 'app/dashboard/page.tsx', 'lib/instant-toggle.ts']);
  });
});
