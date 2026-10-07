import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ImportPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// [POS-SYNC] The till re-upload on the web: upload → preview → confirm → result.

const READING = {
  mapping: { sku: 'SKU', name: 'Name', basePrice: 'Price', stockQuantity: 'Qty' },
  profile: { id: 'generic', label: 'Your own columns' },
  headers: ['SKU', 'Name', 'Price', 'Qty', 'Cost'],
  tillStores: [],
  tillStore: null,
  rowCount: 3,
  preview: [],
  normalizedCsv: 'NORMALIZED-CSV',
};

const TOTALS = {
  rows: 4, matched: 2, stockChanges: 2, priceChanges: 1, becomeSoldOut: 1, backOnSale: 0, switchedOffByTill: 0,
  newItems: 1, needsAttention: 1, missing: 1, switchedOffMissing: 0, unchanged: 0,
};

function previewFor(missing: 'LEAVE' | 'SOLD_OUT', extra: Record<string, unknown> = {}) {
  return {
    storeId: 'store-1', storeName: 'Test Store', uploadId: 'upload-0123456789abcdef', contentHash: 'a'.repeat(64),
    planDigest: 'b'.repeat(64), missingPolicy: missing, alreadyApplied: null,
    changes: [
      { row: 2, sku: 'RICE', itemId: 'i1', name: 'Rice 5kg', fileName: 'Rice', stock: { from: 40, to: 35 }, price: { from: 3500, to: 3600 }, soldOut: null, notes: [] },
      { row: 3, sku: 'OIL', itemId: 'i2', name: 'Cooking Oil', fileName: 'Oil', stock: { from: 3, to: 0 }, price: null, soldOut: 'BECOMES_SOLD_OUT', notes: [] },
    ],
    unchanged: 0,
    newItems: [{ row: 4, sku: 'SUGAR', name: 'Brown Sugar', category: 'Groceries', price: 900, stock: 12, isAvailable: true }],
    needsAttention: [{ row: 5, sku: '', name: 'Nameless', reason: 'No SKU in the file.' }],
    missing: [{ itemId: 'm1', sku: 'OLD', name: 'Old Soap', action: missing === 'SOLD_OUT' ? 'SWITCH_OFF' : 'LEAVE' }],
    notOnSku: 0,
    totals: { ...TOTALS, switchedOffMissing: missing === 'SOLD_OUT' ? 1 : 0 },
    ...extra,
  };
}

const bodyOf = (req: ApiRequest) => JSON.parse(String(req.init?.body ?? '{}')) as Record<string, unknown>;
const csvFile = () => new File(['SKU,Name,Price,Qty\nRICE,Rice,3600,35'], 'till.csv', { type: 'text/csv' });

afterEach(() => vi.unstubAllGlobals());

describe('updating items from a till export', () => {
  it('shows every change first, saves nothing until Apply, and lists the price changes after', async () => {
    const calls: ApiRequest[] = [];
    mockApi((req) => {
      calls.push(req);
      if (req.url.pathname === '/api/v1/vendor/items/import/automap') {
        expect(bodyOf(req)).toMatchObject({ mode: 'sync' });
        return { body: { data: READING } };
      }
      if (req.url.pathname === '/api/v1/vendor/items/import/sync/preview') {
        const body = bodyOf(req);
        expect(body['csv']).toBe('NORMALIZED-CSV');
        return { body: { data: previewFor(body['missing'] as 'LEAVE' | 'SOLD_OUT') } };
      }
      if (req.url.pathname === '/api/v1/vendor/items/import/sync/confirm') {
        return {
          body: { data: { ...previewFor('SOLD_OUT'), appliedAt: '2026-10-06T23:00:00.000Z', replayed: false } },
        };
      }
      throw new Error(`Unexpected request: ${req.url}`);
    });
    const { user } = renderWithQuery(<ImportPage />);

    await user.upload(screen.getByLabelText('Choose a CSV or Excel file'), csvFile());
    const panel = await screen.findByRole('region', { name: 'Preview' });
    expect(within(panel).getByText('What will change in Test Store')).toBeTruthy();
    expect(within(panel).getByText('40 → 35')).toBeTruthy();
    expect(within(panel).getByText('GY$3,500 → GY$3,600')).toBeTruthy();
    expect(within(panel).getByText('Will show as sold out')).toBeTruthy();
    expect(within(panel).getByText(/Brown Sugar/)).toBeTruthy();
    expect(within(panel).getByText(/Row 5 · Nameless: No SKU in the file\./)).toBeTruthy();
    expect(within(panel).getByText(/Orders already placed keep the price/)).toBeTruthy();
    // The cost column is offered but never chosen for the price.
    expect((screen.getByLabelText('Selling price') as HTMLSelectElement).value).toBe('Price');

    // Default: items missing from the file are left alone.
    expect((within(panel).getByLabelText('Leave them as they are') as HTMLInputElement).checked).toBe(true);
    await user.click(within(panel).getByLabelText('Mark them sold out'));
    await waitFor(() => {
      const previews = calls.filter((c) => c.url.pathname.endsWith('/sync/preview'));
      expect(bodyOf(previews.at(-1)!)['missing']).toBe('SOLD_OUT');
    });
    expect(calls.some((c) => c.url.pathname.endsWith('/sync/confirm'))).toBe(false);

    await user.click(await screen.findByRole('button', { name: 'Apply these changes' }));
    const result = await screen.findByRole('region', { name: 'Result' });
    expect(within(result).getByText('Done. Your items are updated.')).toBeTruthy();
    expect(within(result).getByText('Rice 5kg: GY$3,500 → GY$3,600')).toBeTruthy();

    const confirm = calls.find((c) => c.url.pathname.endsWith('/sync/confirm'))!;
    expect(bodyOf(confirm)).toEqual({
      csv: 'NORMALIZED-CSV', missing: 'SOLD_OUT', uploadId: 'upload-0123456789abcdef',
      contentHash: 'a'.repeat(64), planDigest: 'b'.repeat(64),
    });
  });

  it('asks which till store a multi-store export belongs to', async () => {
    const automaps: Array<Record<string, unknown>> = [];
    mockApi((req) => {
      if (req.url.pathname === '/api/v1/vendor/items/import/automap') {
        const body = bodyOf(req);
        automaps.push(body);
        if (!body['tillStore']) {
          return {
            status: 422,
            body: { success: false, error: { code: 'CHOOSE_TILL_STORE', message: 'This file has columns for more than one till store.', details: { stores: ['Main Store', 'Bourda'], headers: ['SKU'] } } },
          };
        }
        return { body: { data: { ...READING, tillStore: 'Bourda' } } };
      }
      if (req.url.pathname === '/api/v1/vendor/items/import/sync/preview') return { body: { data: previewFor('LEAVE') } };
      throw new Error(`Unexpected request: ${req.url}`);
    });
    const { user } = renderWithQuery(<ImportPage />);
    await user.upload(screen.getByLabelText('Choose a CSV or Excel file'), csvFile());
    await user.click(await screen.findByRole('button', { name: 'Bourda' }));
    await screen.findByRole('region', { name: 'Preview' });
    expect(automaps.at(-1)).toMatchObject({ mode: 'sync', tillStore: 'Bourda' });
  });

  it('will not apply a file that was already applied', async () => {
    mockApi((req) => {
      if (req.url.pathname === '/api/v1/vendor/items/import/automap') return { body: { data: READING } };
      if (req.url.pathname === '/api/v1/vendor/items/import/sync/preview') {
        return { body: { data: previewFor('LEAVE', { alreadyApplied: { uploadId: 'old', appliedAt: '2026-10-05T12:00:00.000Z' } }) } };
      }
      throw new Error(`Unexpected request: ${req.url}`);
    });
    const { user } = renderWithQuery(<ImportPage />);
    await user.upload(screen.getByLabelText('Choose a CSV or Excel file'), csvFile());
    const panel = await screen.findByRole('region', { name: 'Preview' });
    expect(within(panel).getByText(/You already applied this exact file/)).toBeTruthy();
    expect((within(panel).getByRole('button', { name: 'Apply these changes' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a file with no item codes can only be added as new items, after saying so', async () => {
    const paths: string[] = [];
    mockApi((req) => {
      paths.push(req.url.pathname);
      if (req.url.pathname === '/api/v1/vendor/items/import/automap') {
        if (bodyOf(req)['mode'] === 'sync') {
          return {
            status: 422,
            body: { success: false, error: { code: 'UNMAPPED_COLUMNS', message: 'Could not map required columns (sku).', details: { mapping: { name: 'Name' }, headers: ['Name', 'Price', 'Category'] } } },
          };
        }
        return { body: { data: { ...READING, mapping: { name: 'Name', basePrice: 'Price', category: 'Category' }, rowCount: 2 } } };
      }
      if (req.url.pathname === '/api/v1/vendor/items/import') {
        expect(bodyOf(req)).toEqual({ csv: 'NORMALIZED-CSV' });
        return { body: { data: { imported: 2, failedCount: 0, failures: [] } } };
      }
      throw new Error(`Unexpected request: ${req.url}`);
    });
    const { user } = renderWithQuery(<ImportPage />);
    await user.upload(screen.getByLabelText('Choose a CSV or Excel file'), csvFile());
    await user.click(await screen.findByRole('button', { name: 'My file has no item codes: add every row as a new item' }));
    expect(await screen.findByText(/a later file cannot update these items/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add 2 items' }));
    expect(await screen.findByText('2 items added')).toBeTruthy();
    expect(paths.filter((p) => p.endsWith('/sync/confirm'))).toEqual([]);
  });
});
