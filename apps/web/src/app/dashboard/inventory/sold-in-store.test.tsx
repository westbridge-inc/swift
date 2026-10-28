import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// [IN-STORE-SALE · owner 27 Oct] "Sold in store −1" on the website's Products page, as in the app. A store with no till
// system sells an item at the counter and takes it off its Swift stock in ONE tap. The REAL page and its tools chunk
// over a stand-in API: the count moves at the tap and settles on the server's answer; taps add up, one request at a
// time per item, each with its own key; only that item waits (and only its row draws again); Undo sends an undo naming
// the tap's key; a refusal says why in the server's words; no answer offers "Try again", which resends the SAME key.
// ---------------------------------------------------------------------------

const drawn = vi.hoisted(() => ({ rows: 0 }));
vi.mock('@/components/glyphs', () => ({ Pictogram: () => { drawn.rows += 1; return null; } }));

import InventoryPage from './page';
import { soldInStore, webSaleFailure } from './sold-in-store';
import { ApiRequestError } from '@/lib/auth';
import { SOLD_IN_STORE, SOLD_UNDO_MS } from '../../../../../mobile/src/lib/inStoreSale';
import { mockApi, renderWithQuery } from '@/test/test-utils';
import { storeKey } from '@/lib/store-scope';

type Sent = { itemId: string; kind: 'sale' | 'undo'; key: string; reply: (_status: number, _body: unknown) => void; drop: () => void };
let sent: Sent[];
let items: Array<Record<string, unknown> & { id: string }>;
const ok = (stock: number) => ({ success: true, data: { stockQuantity: stock, isAvailable: stock > 0, replayed: false } });

beforeEach(() => {
  drawn.rows = 0;
  sent = [];
  soldInStore.reset();
  items = [
    { id: 'rice', name: 'Rice', basePrice: '500.00', stockQuantity: 5, isAvailable: true },
    { id: 'oil', name: 'Oil', basePrice: '900.00', stockQuantity: 3, isAvailable: true },
    { id: 'sugar', name: 'Sugar', basePrice: '700.00', stockQuantity: null, isAvailable: true },
  ];
  mockApi(({ url, method, init }) => {
    if (url.pathname === '/api/v1/vendor/items' && method === 'GET') return { body: { data: items } };
    const sale = url.pathname.match(/^\/api\/v1\/vendor\/items\/([^/]+)\/in-store-sale(\/undo)?$/);
    if (sale && method === 'POST') {
      const headers = new Headers(init?.headers);
      const key = sale[2] ? (JSON.parse(String(init?.body)) as { saleKey: string }).saleKey : headers.get('Idempotency-Key')!;
      return new Promise((resolve, reject) => {
        const reply = (status: number, body: unknown) => {
          // The server's truth moves with its answer, so the page's later re-read agrees with it.
          const stock = (body as { data?: { stockQuantity?: number } }).data?.stockQuantity;
          if (status === 200 && typeof stock === 'number') items = items.map((i) => (i.id === sale[1]! ? { ...i, stockQuantity: stock } : i));
          resolve({ status, body });
        };
        sent.push({ itemId: sale[1]!, kind: sale[2] ? 'undo' : 'sale', key, reply, drop: () => reject(new TypeError('Failed to fetch')) });
      });
    }
    if (url.pathname === '/api/v1/vendor/categories') return { body: { data: [] } };
    if (url.pathname === '/api/v1/vendor/stores') return { body: { data: { stores: [], selectedId: null, myRole: 'STAFF' } } };
    if (url.pathname === '/api/v1/vendor/profile') return { body: { data: { myRole: 'STAFF' } } };
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
});

const row = (name: string) => screen.getByRole('article', { name });
const sellButton = async (name: string) => within(await screen.findByRole('article', { name })).findByRole('button', { name: SOLD_IN_STORE.button });
const settle = async () => { await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); }); };
async function tapSell(name: string) { const button = await sellButton(name); await act(async () => { fireEvent.click(button); }); }
const stockButton = (name: string) => within(row(name)).getByRole('button', { name: /in stock · Adjust stock$/ });

describe('[IN-STORE-SALE] "Sold in store −1" on the Products page', () => {
  it('is on a tracked item only, for staff too (the server\'s rule for stock changes); an untracked item says so and has none', async () => {
    renderWithQuery(<InventoryPage />);
    expect(await sellButton('Rice')).toBeTruthy();
    expect(await sellButton('Oil')).toBeTruthy();
    expect(within(row('Sugar')).getByText('Stock untracked')).toBeTruthy();
    expect(within(row('Sugar')).queryByRole('button', { name: SOLD_IN_STORE.button })).toBeNull();
  });

  it('the count moves at the tap and settles on the server\'s answer; "Sold 1 in store · Undo" shows, then goes', async () => {
    const { queryClient } = renderWithQuery(<InventoryPage />);
    await tapSell('Rice');
    expect(stockButton('Rice').textContent, 'at the tap').toBe('4 in stock · Adjust stock');
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!).toMatchObject({ itemId: 'rice', kind: 'sale' });
    expect(sent[0]!.key).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    sent[0]!.reply(200, ok(4));
    await waitFor(() => expect(within(row('Rice')).getByRole('status').textContent).toBe(`${SOLD_IN_STORE.sold(1)} · ${SOLD_IN_STORE.undo}`));
    expect(stockButton('Rice').textContent).toBe('4 in stock · Adjust stock');
    // The answer is written into the page's own list at once (no wait for a re-read).
    expect(queryClient.getQueryData<Array<{ id: string; stockQuantity: number }>>(storeKey(null, 'items', 'all'))?.find((i) => i.id === 'rice')?.stockQuantity).toBe(4);
    await waitFor(() => expect(within(row('Rice')).queryByRole('status')).toBeNull(), { timeout: SOLD_UNDO_MS + 2000 });
  }, SOLD_UNDO_MS + 5000);

  it('taps add up, one request at a time per item with its own key; another item does not wait; only those rows draw again', async () => {
    renderWithQuery(<InventoryPage />);
    await sellButton('Oil');
    const before = drawn.rows;
    await tapSell('Rice');
    await tapSell('Rice');
    await tapSell('Rice');
    expect(stockButton('Rice').textContent).toBe('2 in stock · Adjust stock');
    await waitFor(() => expect(sent).toHaveLength(1));
    await tapSell('Oil');
    await waitFor(() => expect(sent.map((s) => s.itemId)).toEqual(['rice', 'oil']));
    sent[0]!.reply(200, ok(4));
    await waitFor(() => expect(sent).toHaveLength(3));
    sent[2]!.reply(200, ok(3));
    await waitFor(() => expect(sent).toHaveLength(4));
    sent[3]!.reply(200, ok(2));
    sent[1]!.reply(200, ok(2));
    await settle();
    const riceKeys = sent.filter((s) => s.itemId === 'rice').map((s) => s.key);
    expect(new Set(riceKeys).size, 'three taps, three keys').toBe(3);
    await waitFor(() => expect(stockButton('Rice').textContent).toBe('2 in stock · Adjust stock'));
    expect(stockButton('Oil').textContent).toBe('2 in stock · Adjust stock');
    expect(drawn.rows - before, 'rows drawn again: only Rice and Oil').toBeLessThanOrEqual(2 * 8);
    expect(within(row('Sugar')).queryByRole('status')).toBeNull();
  });

  it('Undo sends an undo naming that tap\'s key, and the count goes back at once', async () => {
    renderWithQuery(<InventoryPage />);
    await tapSell('Rice');
    await waitFor(() => expect(sent).toHaveLength(1));
    sent[0]!.reply(200, ok(4));
    const undo = await within(row('Rice')).findByRole('button', { name: SOLD_IN_STORE.undo });
    await act(async () => { fireEvent.click(undo); });
    expect(stockButton('Rice').textContent).toBe('5 in stock · Adjust stock');
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!).toMatchObject({ itemId: 'rice', kind: 'undo', key: sent[0]!.key });
    sent[1]!.reply(200, ok(5));
    await settle();
    expect(stockButton('Rice').textContent).toBe('5 in stock · Adjust stock');
  });

  it('a refusal shows the server\'s words on the row and drops the waiting taps', async () => {
    renderWithQuery(<InventoryPage />);
    await tapSell('Oil');
    await tapSell('Oil');
    await waitFor(() => expect(sent).toHaveLength(1));
    sent[0]!.reply(409, { success: false, error: { code: 'NONE_LEFT', message: SOLD_IN_STORE.noneLeft } });
    await waitFor(() => expect(within(row('Oil')).getByRole('alert').textContent).toBe(SOLD_IN_STORE.noneLeft));
    expect(stockButton('Oil').textContent).toBe('3 in stock · Adjust stock');
    await settle();
    expect(sent).toHaveLength(1);
  });

  it('no answer: the tap is kept and never resent by itself; "Try again" resends the SAME key', async () => {
    renderWithQuery(<InventoryPage />);
    await tapSell('Rice');
    await waitFor(() => expect(sent).toHaveLength(1));
    sent[0]!.drop();
    await waitFor(() => expect(within(row('Rice')).getByRole('alert').textContent).toContain(SOLD_IN_STORE.notSent(1, 0)));
    expect(stockButton('Rice').textContent).toBe('4 in stock · Adjust stock');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sent).toHaveLength(1);
    await act(async () => { fireEvent.click(within(row('Rice')).getByRole('button', { name: SOLD_IN_STORE.tryAgain })); });
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.key).toBe(sent[0]!.key);
    sent[1]!.reply(200, ok(4));
    await waitFor(() => expect(within(row('Rice')).queryByRole('alert')).toBeNull());
  });

  it('at 0 on screen the button waits', async () => {
    renderWithQuery(<InventoryPage />);
    for (let i = 0; i < 3; i += 1) await tapSell('Oil');
    expect(stockButton('Oil').textContent).toBe('0 in stock · Adjust stock');
    expect((await sellButton('Oil')).hasAttribute('disabled')).toBe(true);
  });

  it('[REVIEW-F S4-7] the Low stock label moves at the tap with the count, as the app', async () => {
    items = items.map((i) => (i.id === 'oil' ? { ...i, stockQuantity: 6, lowStockThreshold: 5 } : i));
    renderWithQuery(<InventoryPage />);
    await sellButton('Oil');
    expect(within(row('Oil')).queryByText('Low stock')).toBeNull();
    await tapSell('Oil');
    expect(stockButton('Oil').textContent).toBe('5 in stock · Adjust stock');
    expect(within(row('Oil')).getByText('Low stock'), 'at the tap, before the answer').toBeTruthy();
  });

  it('[REVIEW-F P7/P8] a server error, no answer, or the page\'s own "account or store changed" (it may have landed) is no answer; only the server\'s 4xx is a refusal', () => {
    expect(webSaleFailure(new ApiRequestError('Internal', 500, 'INTERNAL'))).toBe('noAnswer');
    expect(webSaleFailure(new ApiRequestError('Swift can’t be reached right now.', 503, 'UNREACHABLE'))).toBe('noAnswer');
    expect(webSaleFailure(new TypeError('Failed to fetch'))).toBe('noAnswer');
    expect(webSaleFailure(new ApiRequestError('The signed-in account or selected store changed while this request was running. Try again.', 409, 'SESSION_CHANGED'))).toBe('noAnswer');
    expect(webSaleFailure(new ApiRequestError(SOLD_IN_STORE.noneLeft, 409, 'NONE_LEFT'))).toEqual({ refused: SOLD_IN_STORE.noneLeft });
  });

  it('[REVIEW-F S4-4] a sale whose answer the page could not use is kept, and Try again resends the SAME key (never a second sale)', async () => {
    renderWithQuery(<InventoryPage />);
    await tapSell('Rice');
    await waitFor(() => expect(sent).toHaveLength(1));
    sent[0]!.reply(409, { success: false, error: { code: 'SESSION_CHANGED', message: 'The signed-in account changed.' } });
    await waitFor(() => expect(within(row('Rice')).getByRole('alert').textContent).toContain(SOLD_IN_STORE.notSent(1, 0)));
    await act(async () => { fireEvent.click(within(row('Rice')).getByRole('button', { name: SOLD_IN_STORE.tryAgain })); });
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.key).toBe(sent[0]!.key);
  });
});

// [FOLLOWUPS · REVIEW-F #2157 delta S4-d1, probe P9 lifted] The web half of S4-5: a tap made under store A is never sent once another store is the
// selected one (another tab switched it: the request would go out under that store's header), not even on Try again.
describe('[REVIEW-F P9] web: no send under another store', () => {
  it('P9 a stalled tap is not resent by Try again while another store is selected; back in its store it is (same key)', async () => {
    renderWithQuery(<InventoryPage />);
    await tapSell('Rice');
    await waitFor(() => expect(sent).toHaveLength(1));
    await act(async () => { sent[0]!.drop(); });
    await waitFor(() => expect(within(row('Rice')).getByRole('alert').textContent).toContain(SOLD_IN_STORE.notSent(1, 0)));
    localStorage.setItem('swift_web_store', 'store-b');
    try {
      await act(async () => { fireEvent.click(within(row('Rice')).getByRole('button', { name: SOLD_IN_STORE.tryAgain })); });
      await settle();
      await new Promise((r) => setTimeout(r, 50));
      await settle();
      expect(sent).toHaveLength(1);
    } finally {
      localStorage.removeItem('swift_web_store');
    }
    await act(async () => { fireEvent.click(within(row('Rice')).getByRole('button', { name: SOLD_IN_STORE.tryAgain })); });
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.key).toBe(sent[0]!.key);
  });
});
