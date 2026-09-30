import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const riderHook = readFileSync(new URL('./mover.ts', import.meta.url), 'utf8');
const vendorHook = readFileSync(new URL('./vendorops.ts', import.meta.url), 'utf8');

describe('delivery cash-settlement hook contract', () => {
  it('carries the rider row id and immutable amount to the API', () => {
    expect(riderHook).toContain('mutationFn: confirmRiderCashSettlement');
    expect(riderHook).not.toContain('mutationFn: (id: string) => unwrap(riderApi.confirmCashSettlement(id))');
  });

  it('carries the vendor row id and immutable amount to the API', () => {
    expect(vendorHook).toContain('mutationFn: confirmVendorCashSettlement');
    expect(vendorHook).not.toContain('mutationFn: (id: string) => unwrap(vendorApi.confirmCashSettlement(id))');
  });
});
