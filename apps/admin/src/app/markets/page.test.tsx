import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarketsPage from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// [O1 · owner 5 Nov 2026 05:00Z] "Rider cash limit OPEN, no cap." The API sends the ruled no-cap as null (never its
// stored number); the page says "No limit". A market with figures keeps them.
const row = (code: string, name: string, floats: [number | null, number | null, number | null]) => ({
  id: code, code, name, currencyCode: 'GYD', currencySymbol: '$', usdExchangeRate: 209, idGateThresholdUsd: 50,
  floatL1: floats[0], floatL2: floats[1], floatL3: floats[2], subscriptionTiers: {},
});

describe('markets page: the rider cash limit [O1]', () => {
  it('says "No limit" for the ruled no-cap and never prints a stored number for it; figures stay figures', async () => {
    mockApi(() => ({ body: { success: true, data: [row('GY', 'Guyana', [null, null, null]), row('TT', 'Trinidad & Tobago', [260, 650, 1300])] } }));
    renderWithQuery(<MarketsPage />);
    expect(await screen.findByText('No limit')).toBeTruthy();
    expect(screen.getByText('260 / 650 / 1,300')).toBeTruthy();
    expect(document.body.textContent).not.toContain('1,000,000,000');
    expect(document.body.textContent).not.toMatch(/\b0 \/ 0 \/ 0\b/);
    expect(screen.getByText('Rider cash limit L1 / L2 / L3')).toBeTruthy();
  });
});
