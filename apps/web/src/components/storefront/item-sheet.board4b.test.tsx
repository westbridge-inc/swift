import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ItemSheet, SHEET_DESCRIPTION_CLAMP_CHARS, type ItemSheetProps } from './item-sheet';

// ---------------------------------------------------------------------------
// [P35 · board 4b "Market — product page"] On the web an item opens in this sheet (from the Market, by ?item=).
// Under its name: who sells it and where ("Craft & Kind · Georgetown"), "Verified seller" when the page says a
// person approved the store, and a long description in three lines until "Read more".
// ---------------------------------------------------------------------------

const LONG = 'Tibisiri-palm warishi woven in the Rupununi, flat back, shoulder straps, holds a week of market shopping. Each one is a single maker’s work, so weave and tone vary.';

function sheet(extra: Partial<ItemSheetProps> = {}, description: string | null = LONG) {
  const props: ItemSheetProps = {
    item: { id: 'basket', name: 'Warishi basket', description, basePrice: 3500, customerPrice: 3500, imageUrl: null, unit: null, isAvailable: true, optionGroups: [] } as unknown as ItemSheetProps['item'],
    vendorType: 'STORE',
    selectedOptions: {},
    onChoose: vi.fn(),
    quantity: 1,
    onQuantity: vi.fn(),
    error: null,
    busy: false,
    cartLoading: false,
    unitPrice: 3500,
    onConfirm: vi.fn(),
    onClose: vi.fn(),
    ...extra,
  };
  return render(<ItemSheet {...props} />);
}

describe('[P35 · board 4b] the item sheet', () => {
  it('names the seller and its city, with Verified seller', () => {
    sheet({ seller: { name: 'Craft & Kind', city: 'Georgetown', verified: true } });
    expect(screen.getByText('Craft & Kind · Georgetown')).toBeTruthy();
    expect(screen.getByText('Verified seller')).toBeTruthy();
  });

  it('no pill when the page does not say verified; no city part when there is no city; nothing without a seller', () => {
    const { unmount } = sheet({ seller: { name: 'Craft & Kind', city: ' ', verified: false } });
    expect(screen.getByText('Craft & Kind')).toBeTruthy();
    expect(screen.queryByText('Verified seller')).toBeNull();
    unmount();
    sheet();
    expect(screen.queryByText(/Craft & Kind/)).toBeNull();
  });

  it('a long description is clamped until Read more, and Show less clamps it again', () => {
    sheet();
    const more = screen.getByRole('button', { name: 'Read more' });
    expect(screen.getByText(LONG).className).toMatch(/modalDescriptionClamped/);
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(screen.getByText(LONG).className).not.toMatch(/modalDescriptionClamped/);
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.getByText(LONG).className).toMatch(/modalDescriptionClamped/);
  });

  it('a short description is whole, with no Read more', () => {
    sheet({}, 'x'.repeat(SHEET_DESCRIPTION_CLAMP_CHARS));
    expect(screen.queryByRole('button', { name: 'Read more' })).toBeNull();
  });
});
