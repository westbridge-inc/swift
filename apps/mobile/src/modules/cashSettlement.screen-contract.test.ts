import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const riderScreen = readFileSync(
  new URL('./mover/screens/EarningsScreen.tsx', import.meta.url),
  'utf8',
);
const vendorScreen = readFileSync(
  new URL('./vendor/screens/VendorInsightsScreen.tsx', import.meta.url),
  'utf8',
);

describe('delivery cash-settlement screen contract', () => {
  it('renders and submits the same authoritative rider-row amount', () => {
    expect(riderScreen).toContain("const amount = serverNumber(row['amount']);");
    expect(riderScreen).toContain('{moneyOrDash(amount)}');
    expect(riderScreen).toContain('confirm.mutate({ id, amount });');
    expect(riderScreen).toContain('confirm.variables?.id === id');
    expect(riderScreen).toContain('errorMessage(confirm.error,');
    expect(riderScreen).not.toContain('confirm.mutate(id)');
  });

  it('renders, names, and submits the same authoritative vendor-row amount', () => {
    expect(vendorScreen).toContain('const amount = numericFact(r.amount);');
    expect(vendorScreen).toContain("const formattedAmount = amount == null ? '—' : money(amount);");
    expect(vendorScreen).toContain('markPaidPrompt(r, formattedAmount)');
    expect(vendorScreen).toContain('confirm.mutate({ id: r.id, amount }, {');
    expect(vendorScreen).toContain('confirm.variables?.id === r.id');
    expect(vendorScreen).toContain("Alert.alert('Not recorded', errorMessage(mutationError))");
    expect(vendorScreen).not.toContain('confirm.mutate(r.id');
  });
});
