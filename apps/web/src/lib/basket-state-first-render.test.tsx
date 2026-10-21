import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// [#1958 review S4-2] The checkout's basket mounts after the page has read the browser basket.
// It must draw the lines in its FIRST render, never "empty" for a moment. The page's own first,
// hydrating render still starts empty (it has to match the server's). Synthetic basket only.

const LINE = { clientLineId: 'line-1', vendorId: 'v1', storeSlug: 'fixture-bakery', vendorName: 'Fixture Bakery', itemId: 'i1', name: 'Bake and saltfish', quantity: 1, unitPrice: 900, selectedOptions: {}, fulfillment: 'DELIVERY' };

async function freshHook() {
  vi.resetModules();
  return (await import('./basket-state')).useGuestBasket;
}

function probe(useGuestBasket: Awaited<ReturnType<typeof freshHook>>, seen: string[], label: string) {
  return function Probe() {
    const basket = useGuestBasket();
    seen.push(`${label}:${basket.loaded ? 'loaded' : 'not-loaded'}:${basket.lines.length}`);
    return <p data-testid={label}>{basket.lines.map((line) => line.name).join(',') || 'empty'}</p>;
  };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('swift_guest_basket_v1', JSON.stringify({ version: 1, lines: [LINE] }));
});

describe('the browser basket after the page has read it once', () => {
  it('the page’s first render starts empty and not loaded (it matches the server), then shows the lines', async () => {
    const useGuestBasket = await freshHook();
    const seen: string[] = [];
    const Page = probe(useGuestBasket, seen, 'page');
    render(<Page />);
    expect(seen[0]).toBe('page:not-loaded:0');
    await waitFor(() => expect(screen.getByTestId('page').textContent).toBe('Bake and saltfish'));
  });

  it('a basket mounted later draws its lines in its first render', async () => {
    const useGuestBasket = await freshHook();
    const seen: string[] = [];
    const Page = probe(useGuestBasket, seen, 'page');
    render(<Page />);
    await waitFor(() => expect(screen.getByTestId('page').textContent).toBe('Bake and saltfish'));

    const Later = probe(useGuestBasket, seen, 'later');
    render(<Later />);
    expect(seen.find((entry) => entry.startsWith('later:'))).toBe('later:loaded:1');
  });
});
