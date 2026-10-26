'use client';

import type { VatClass } from '@/lib/vendor-api';
import { GRA_VAT_URL, vatClassWords } from '@/lib/store-vat-words';

// [STORE-VAT · owner O-5 · perf-budget] The inventory's VAT pieces. The page loads them on demand, and only for the owner
// of a store that told Swift it is VAT-registered: every other store's Products page stays inside its first-load budget.

/** One item's VAT class. The rate on screen comes from the API. */
export function VatClassSelect({ itemId, name, vatClass, ratePercent, effective, disabled, onVatClass }: {
  itemId: string;
  name: string;
  vatClass: VatClass | null | undefined;
  ratePercent: number;
  effective: boolean;
  disabled: boolean;
  onVatClass: (_id: string, _vatClass: VatClass) => void;
}) {
  return (
    <select
      aria-label={`VAT class: ${name}`}
      value={vatClass ?? 'STANDARD'}
      disabled={disabled}
      onChange={(e) => onVatClass(itemId, e.target.value as VatClass)}
      className="min-h-8 rounded-lg border border-[var(--swift-border)] bg-[var(--swift-card)] px-2 text-[13px]"
    >
      {vatClassWords(ratePercent, effective).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
    </select>
  );
}

/** The class is the store's to choose, and the GRA's own words are one tap away. */
export function VatClassNotice() {
  return (
    <p className="text-sm text-[var(--swift-muted)]">
      You choose each item&apos;s VAT class, and you are responsible for it. Most goods are standard-rated; some basic
      foods and household goods are zero-rated, and some supplies are exempt. Check with the{' '}
      <a href={GRA_VAT_URL} target="_blank" rel="noreferrer" className="font-semibold text-[var(--swift-red)]">GRA</a>.
    </p>
  );
}
