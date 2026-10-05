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
const riderCard = riderScreen.slice(
  riderScreen.indexOf('function StoreOwesYouCard'),
  riderScreen.indexOf('function WeeklyFeeCard'),
);
const vendorCard = vendorScreen.slice(
  vendorScreen.indexOf('function RiderFeesOwedCard'),
  vendorScreen.indexOf('function RepeatCustomersCard'),
);

describe('delivery cash-settlement screen contract', () => {
  it('renders and submits the same authoritative rider-row amount', () => {
    expect(riderScreen).toContain("const attestation = cashSettlementAmount(row['amount']);");
    expect(riderScreen).toContain("{attestation?.formatted ?? '—'}");
    expect(riderScreen).toContain('captureRiderCashSettlementConfirmation(id, attestation.amount, authSession)');
    expect(riderScreen).toContain('requireCurrentCashSettlementConfirmation(confirmation);');
    expect(riderScreen).toContain('confirm.mutate(confirmation);');
    expect(riderCard.indexOf('const confirmation =')).toBeLessThan(riderCard.indexOf('onPress={() => {'));
    expect(riderScreen).toContain('confirm.variables?.id === id');
    expect(riderScreen).toContain('errorMessage(confirm.error,');
    expect(riderScreen).not.toContain('confirm.mutate(id)');
  });

  it('renders, names, and submits the same authoritative vendor-row amount', () => {
    expect(vendorScreen).toContain('const attestation = cashSettlementAmount(r.amount);');
    expect(vendorScreen).toContain("const formattedAmount = attestation?.formatted ?? '—';");
    expect(vendorScreen).toContain('markPaidPrompt(r, formattedAmount)');
    expect(vendorScreen).toContain('captureVendorCashSettlementConfirmation(r.id, attestation.amount, selectedStoreId, authSession)');
    expect(vendorScreen).toContain('requireCurrentCashSettlementConfirmation(confirmation);');
    expect(vendorScreen).toContain('confirm.mutate(confirmation, {');
    const markPaidButton = vendorCard.indexOf('label="Mark paid"');
    expect(vendorCard.indexOf('const confirmation =')).toBeLessThan(
      vendorCard.indexOf('onPress={() => {', markPaidButton),
    );
    expect(vendorScreen).toContain('confirm.variables?.id === r.id');
    expect(vendorScreen).toContain("Alert.alert('Not recorded', errorMessage(mutationError))");
    expect(vendorScreen).not.toContain('confirm.mutate(r.id');
  });
});
