import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VendorCard, VendorGridSkeleton } from './order-ui';
import type { Vendor } from '@/lib/customer';

const vendor = { id: 'v1', name: 'A store with a very long name', isCurrentlyOpen: true, displayRating: null, estimatedPrepTime: 20, coverImageUrl: '/icons/icon-192.png' } as Vendor;

describe('store loading geometry', () => {
  it('replaces placeholders with cards that reserve the same image and copy space', () => {
    const view = render(<VendorGridSkeleton n={2} />);
    expect(screen.getByLabelText('Loading stores').getAttribute('aria-busy')).toBe('true');
    const shape = (root: HTMLElement) => Array.from(root.querySelectorAll('[data-store-part]')).map((node) => [node.getAttribute('data-store-part'), node.className]);
    const before = shape(view.container).slice(0, 3);
    expect(before).toHaveLength(3);
    view.rerender(<VendorCard v={vendor} />);
    expect(shape(view.container)).toEqual(before);
    expect(screen.getByRole('link').textContent).toContain(vendor.name);
    expect(screen.getByRole('img').style.width).toBe('100%');
    expect(screen.getByRole('img').getAttribute('loading')).toBe('lazy');
  });
});
