import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CatalogueCheckPage from './page';
import { API_ORIGIN, mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [GUARDRAILS §8] The catalogue check: a banned word in a partner's own text
// holds an item hidden until a person looks. The page must show WHAT is held
// and WHY (the word, where it was found), approve exactly the words on screen
// (the fingerprint goes back with the approval), remove with the class the
// reviewer chose, and ask for a reason in the page — never a browser prompt.
// ---------------------------------------------------------------------------

const REASON = 'Checked the cake recipe: the rum is baked in, sold as a dessert';
const HASH = 'a'.repeat(64);

const waiting = {
  itemId: 'item-cake',
  vendor: { id: 'vendor-1', name: 'Sweet Corner Bakery' },
  name: 'Rum cake slice',
  description: 'Guyanese classic',
  sectionName: 'Cakes',
  optionNames: ['Slice', 'Whole'],
  state: 'WAITING',
  prohibitedClass: 'ALCOHOL',
  label: 'alcohol',
  field: 'name',
  term: 'rum',
  wordsHash: HASH,
};

function handler(items: unknown[], extra?: (_r: ApiRequest) => { status?: number; body: unknown } | undefined) {
  return (request: ApiRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/catalogue-review') {
      return { body: { success: true, data: { items } } };
    }
    const handled = extra?.(request);
    if (handled) return handled;
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
}

describe('the catalogue check', () => {
  it('shows each held item, its store, and the word and place that held it', async () => {
    mockApi(handler([waiting]));
    renderWithQuery(<CatalogueCheckPage />);
    const row = await screen.findByRole('listitem', { name: 'Rum cake slice' });
    expect(row.textContent).toContain('Sweet Corner Bakery');
    expect(row.textContent).toContain('Held as alcohol: the word “rum” in the name.');
    expect(row.textContent).toContain('Cakes');
    expect(row.textContent).toContain('Guyanese classic');
    expect(row.textContent).toContain('Slice, Whole');
  });

  it('approves exactly the words seen, with the reviewer’s own reason, in the page', async () => {
    const prompt = vi.fn();
    vi.stubGlobal('prompt', prompt);
    const fetchMock = mockApi(handler([waiting], (request) => (
      request.method === 'POST' && request.url.pathname === '/api/v1/admin/catalogue-review/item-cake/approve'
        ? { body: { success: true, data: { itemId: 'item-cake', state: 'APPROVED' } } }
        : undefined
    )));
    const { user } = renderWithQuery(<CatalogueCheckPage />);
    await user.click(await screen.findByRole('button', { name: 'Approve…' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve Rum cake slice?' });
    expect(dialog.textContent).toContain('it comes back to this check');
    await user.type(within(dialog).getByRole('textbox', { name: /reason/i }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Approve item' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/catalogue-review/item-cake/approve`);
    expect(JSON.parse(String(init?.body))).toEqual({ wordsHash: HASH });
    expect((init?.headers as Record<string, string>)['x-swift-reason']).toBe(REASON);
    expect(await screen.findByText('Rum cake slice is approved and visible.')).toBeTruthy();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('removes with the class the reviewer chose, and the partner-facing reason', async () => {
    const fetchMock = mockApi(handler([waiting], (request) => (
      request.method === 'POST' && request.url.pathname === '/api/v1/admin/catalogue-review/item-cake/remove'
        ? { body: { success: true, data: { itemId: 'item-cake', state: 'BANNED', prohibitedClass: 'MEDICINE' } } }
        : undefined
    )));
    const { user } = renderWithQuery(<CatalogueCheckPage />);
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Remove as' }), 'MEDICINE');
    await user.click(screen.getByRole('button', { name: 'Remove…' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove Rum cake slice?' });
    expect(dialog.textContent).toContain('banned for good as medicines');
    await user.type(within(dialog).getByRole('textbox', { name: /reason/i }), 'Sold as a cure for fever, which makes it a medicine');
    await user.click(within(dialog).getByRole('button', { name: 'Remove item' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ prohibitedClass: 'MEDICINE' });
    expect((init?.headers as Record<string, string>)['x-swift-reason']).toBe('Sold as a cure for fever, which makes it a medicine');
  });

  it('a partner edit in between: the server refuses the approval and says so', async () => {
    mockApi(handler([waiting], (request) => (
      request.method === 'POST' && request.url.pathname.endsWith('/approve')
        ? { status: 409, body: { success: false, error: { code: 'ITEM_CHANGED', message: 'This item changed — review it again.' } } }
        : undefined
    )));
    const { user } = renderWithQuery(<CatalogueCheckPage />);
    await user.click(await screen.findByRole('button', { name: 'Approve…' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve Rum cake slice?' });
    await user.type(within(dialog).getByRole('textbox', { name: /reason/i }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Approve item' }));
    expect(await screen.findByText(/This item changed — review it again/)).toBeTruthy();
  });

  it('an item id is sent as one path segment, never as more path', async () => {
    const fetchMock = mockApi(handler([{ ...waiting, itemId: 'odd/../id' }], (request) => (
      request.method === 'POST' ? { body: { success: true, data: {} } } : undefined
    )));
    const { user } = renderWithQuery(<CatalogueCheckPage />);
    await user.click(await screen.findByRole('button', { name: 'Approve…' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve Rum cake slice?' });
    await user.type(within(dialog).getByRole('textbox', { name: /reason/i }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Approve item' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    expect(String(requestsByMethod(fetchMock, 'POST')[0]![0])).toBe(`${API_ORIGIN}/api/v1/admin/catalogue-review/odd%2F..%2Fid/approve`);
  });

  it('a long queue says how many are waiting beyond the ones shown', async () => {
    mockApi((request) => {
      if (request.url.pathname === '/api/v1/admin/catalogue-review') return { body: { success: true, data: { items: [waiting], total: 250 } } };
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    renderWithQuery(<CatalogueCheckPage />);
    expect(await screen.findByText('Showing the first 1 of 250 items waiting. Check these, then reload for the rest.')).toBeTruthy();
  });

  it('says so when nothing is waiting', async () => {
    mockApi(handler([]));
    renderWithQuery(<CatalogueCheckPage />);
    expect(await screen.findByText('Nothing waiting for a check.')).toBeTruthy();
  });
});
