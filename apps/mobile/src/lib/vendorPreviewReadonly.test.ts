import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vendorPreviewDataset } from './vendorPreviewData';

// Source-level guard (like the API's self-maintaining authz-matrix): the vendor
// preview's read-only guarantee depends on EVERY mutation hook routing through
// usePreviewSafeMutation, which returns the no-op previewMutation() stub while a
// sample preview is active. A hook that called useMutation({...}) directly would
// silently fire a real write from a "read-only" preview. This pins that shut so
// the gap can't reopen unnoticed (mobile has no render tests to catch it).
const src = readFileSync(join(process.cwd(), 'src/hooks/vendorops.ts'), 'utf8');
const stack = readFileSync(join(process.cwd(), 'src/modules/vendor/VendorStack.tsx'), 'utf8');
const bulkImport = readFileSync(join(process.cwd(), 'src/screens/vendor/VendorBulkImportScreen.tsx'), 'utf8');

describe('vendor mutations are preview-read-only by construction', () => {
  it('no vendor hook calls useMutation({ directly — all route through usePreviewSafeMutation', () => {
    // The wrapper itself calls useMutation(options) (a variable, no brace), so
    // zero brace-form calls means every mutation hook goes through it.
    expect(src.match(/useMutation\(\{/g) ?? []).toHaveLength(0);
  });

  it('the wrapper exists and short-circuits to the read-only stub in preview', () => {
    expect(src).toMatch(/function usePreviewSafeMutation/);
    expect(src).toMatch(/pv \? previewMutation\(\) : m/);
  });

  it('gates editor, modifier, stock and bulk-import controls in sample preview', () => {
    expect(stack).toContain('if (readOnly || !valid || busy) return;');
    expect(stack).toContain('disabled={readOnly || !valid || adjust.isPending}');
    expect(stack).toContain('disabled={readOnly || addOption.isPending}');
    expect(bulkImport).toContain('disabled={!!previewType || csv.trim().length === 0 || busy}');
    expect(bulkImport).toContain('Sign in and create your store before importing a catalogue.');
  });

  it('matches the production identity contract for every preview order line', () => {
    for (const type of ['RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE'] as const) {
      const dataset = vendorPreviewDataset(type);
      const orderIds = dataset.orders.map((order) => order.id);
      const lineIds = dataset.orders.flatMap((order) =>
        order.items.map((item: { id?: string }) => item.id),
      );

      expect(orderIds.every(Boolean)).toBe(true);
      expect(new Set(orderIds).size).toBe(orderIds.length);
      expect(lineIds.every(Boolean)).toBe(true);
      expect(new Set(lineIds).size).toBe(lineIds.length);
    }
  });
});
