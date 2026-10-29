import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ImportPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// [REVIEW-F S4-1] Each panel has its own loading boundary: the preview's first load never blanks the columns the store
// is looking at (one shared boundary hid every panel until the new one arrived). A panel's code arrives over the
// network, so here each one takes a moment, as it does in a browser.
vi.mock('@/lib/chunk-retry', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/chunk-retry')>();
  return {
    ...real,
    lazyRetry: ((load: () => Promise<{ default: never }>) =>
      real.lazyRetry(() => new Promise((resolve) => { setTimeout(resolve, 30); }).then(load))) as typeof real.lazyRetry,
  };
});

const HEADERS = ['Code', 'Name', 'Price', 'Qty'];
const bodyOf = (req: ApiRequest) => JSON.parse(String(req.init?.body ?? '{}')) as Record<string, unknown>;

const PREVIEW = {
  storeId: 'store-1', storeName: 'Test Store', uploadId: 'upload-0123456789abcdef', contentHash: 'a'.repeat(64),
  planDigest: 'b'.repeat(64), missingPolicy: 'LEAVE', alreadyApplied: null,
  changes: [{ row: 2, sku: 'RICE', itemId: 'i1', name: 'Rice 5kg', fileName: 'Rice', stock: { from: 40, to: 35 }, price: null, soldOut: null, notes: [] }],
  unchanged: 0, newItems: [], needsAttention: [], missing: [], notOnSku: 0,
  totals: {
    rows: 1, matched: 1, stockChanges: 1, priceChanges: 0, becomeSoldOut: 0, backOnSale: 0, switchedOffByTill: 0,
    newItems: 0, needsAttention: 0, missing: 0, switchedOffMissing: 0, unchanged: 0,
  },
};

describe('the import page’s panels load one at a time', () => {
  it('the columns stay on screen while the preview loads for the first time', async () => {
    mockApi((req) => {
      if (req.url.pathname === '/api/v1/vendor/items/import/automap') {
        if (!(bodyOf(req)['mapping'] as Record<string, string> | undefined)?.['sku']) {
          return {
            status: 422,
            body: { success: false, error: { code: 'UNMAPPED_COLUMNS', message: 'Could not map required columns (sku).', details: { mapping: { name: 'Name', basePrice: 'Price' }, headers: HEADERS } } },
          };
        }
        return {
          body: { data: {
            mapping: { sku: 'Code', name: 'Name', basePrice: 'Price', stockQuantity: 'Qty' }, profile: { id: 'generic', label: 'Your own columns' },
            headers: HEADERS, tillStores: [], tillStore: null, rowCount: 1, preview: [], normalizedCsv: 'NORMALIZED-CSV',
          } },
        };
      }
      if (req.url.pathname === '/api/v1/vendor/items/import/sync/preview') return { body: { data: PREVIEW } };
      throw new Error(`Unexpected request: ${req.url}`);
    });
    const { user } = renderWithQuery(<ImportPage />);
    await user.upload(screen.getByLabelText('Choose a CSV or Excel file'), new File(['Code,Name,Price,Qty\nRICE,Rice,3600,35'], 'till.csv', { type: 'text/csv' }));
    const columns = (await screen.findByLabelText('Item code (SKU)')).closest('section')!;
    const hidden = (el: Element | null): boolean => {
      for (let at = el; at; at = at.parentElement) if ((at as HTMLElement).style?.display === 'none') return true;
      return false;
    };
    let blanked = false;
    const watch = new MutationObserver(() => { if (!columns.isConnected || hidden(columns)) blanked = true; });
    watch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
    try {
      await user.selectOptions(screen.getByLabelText('Item code (SKU)'), 'Code');
      await screen.findByRole('region', { name: 'Preview' });
      await waitFor(() => expect(hidden(columns)).toBe(false));
    } finally {
      watch.disconnect();
    }
    expect(blanked).toBe(false);
    expect(columns.isConnected).toBe(true);
  });
});
