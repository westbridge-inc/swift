import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import NewOrderTakeover from './NewOrderTakeover';
import { renderWithQuery, stubAudioContext } from '@/test/test-utils';
import { wireVendorOrder } from '@/test/vendor-wire-fixtures';
import { normalizeVendorOrder } from '@/lib/vendor-api';

/**
 * The full-screen new-order takeover is the loudest money surface the vendor
 * has — it is the screen a store accepts an order from. It printed "$NaN"
 * for the same reason the board did.
 *
 * The first poll only BASELINES (a dashboard opened onto an old queue must not
 * scream), so each test renders an empty queue first and then the arrival.
 */
describe('new-order takeover', () => {
  beforeEach(() => {
    stubAudioContext();
  });

  it('shows the real total from `totalAmount`, never "$NaN"', async () => {
    const { rerender } = renderWithQuery(<NewOrderTakeover orders={[]} />);
    rerender(<NewOrderTakeover orders={[normalizeVendorOrder(wireVendorOrder())]} />);

    const headline = await screen.findByText(new RegExp(`SW-1001`));
    expect(headline.textContent).toContain(`$${(4500).toLocaleString()}`);
    expect(document.body.textContent ?? '').not.toMatch(/NaN/);
  });

  it('renders an em-dash rather than a made-up $0 when no total arrived', async () => {
    const raw = wireVendorOrder() as Record<string, unknown>;
    delete raw['totalAmount'];
    const { rerender } = renderWithQuery(<NewOrderTakeover orders={[]} />);
    rerender(<NewOrderTakeover orders={[normalizeVendorOrder(raw)]} />);

    const headline = await screen.findByText(new RegExp(`SW-1001`));
    await waitFor(() => expect(headline.textContent).toContain('—'));
    expect(headline.textContent).not.toContain('$0');
    expect(headline.textContent ?? '').not.toMatch(/NaN/);
  });
});
