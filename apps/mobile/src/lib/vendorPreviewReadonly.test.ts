import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Source-level guard (like the API's self-maintaining authz-matrix): the vendor
// preview's read-only guarantee depends on EVERY mutation hook routing through
// usePreviewSafeMutation, which returns the no-op previewMutation() stub while a
// sample preview is active. A hook that called useMutation({...}) directly would
// silently fire a real write from a "read-only" preview. This pins that shut so
// the gap can't reopen unnoticed (mobile has no render tests to catch it).
const src = readFileSync(join(process.cwd(), 'src/hooks/vendorops.ts'), 'utf8');

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
});
