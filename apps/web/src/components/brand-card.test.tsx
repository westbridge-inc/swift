import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VendorCard } from './order-ui';
import { BranchSwitcher } from './storefront/branch-switcher';
import type { Vendor } from '@/lib/customer';
import type { BrandBranch, BrandCard } from '@/lib/brand-card';

type Card = Vendor & { brand?: BrandCard; addressLine1?: string };

// [CHAINS PR3 · owner 29 Oct 2026] One brand card per chain: the card reads as the brand, with the branch it opens
// and how many branches; the store page lets the visitor pick another branch (plain links). Same words as the phone.

const vendor = (over: Partial<Card> = {}): Card => ({
  id: 'v1', name: 'Royal Camp', slug: 'royal-camp', vendorType: 'RESTAURANT', cuisineTypes: [], displayRating: 4.5, ratingBucket: '(10+)',
  ratingCount: 12, topRated: false, estimatedPrepTime: 20, isCurrentlyOpen: true, acceptingOrders: true, city: 'Georgetown',
  addressLine1: '12 Camp Street', ...over,
});

describe('[CHAINS] the brand card on the website', () => {
  it('the list card reads as the brand (the store page names the branch and lets the customer switch); a store on its own is untouched', () => {
    const brand = { name: 'Royal Castle', branches: 4 };
    {
      const { container, unmount } = render(<VendorCard v={vendor({ brand })} />);
      expect(container.textContent).toContain('Royal Castle');
      expect(container.textContent).not.toContain('Royal Camp');
      expect(container.querySelector('a')!.getAttribute('href')).toContain('royal-camp');
      unmount();
    }
    const { container } = render(<VendorCard v={vendor({ brand: null })} />);
    expect(container.textContent).toContain('Royal Camp');
  });
});

const branch = (over: Partial<BrandBranch>): BrandBranch => ({
  id: 'b', name: 'Royal Camp', slug: 'royal-camp', addressLine1: '12 Camp Street', city: 'Georgetown',
  isCurrentlyOpen: true, acceptingOrders: true, distanceKm: null, delivers: null, current: false, ...over,
});

describe('[CHAINS] the store page offers another branch', () => {
  it('lists the brand\'s branches, this one marked, the others linked to their own page', () => {
    render(<BranchSwitcher fallback="12 Camp Street" brand={{ name: 'Royal Castle', branches: [
      branch({ id: 'a', current: true }),
      branch({ id: 'b', name: 'Royal Sheriff', slug: 'royal-sheriff', addressLine1: '3 Sheriff Street', isCurrentlyOpen: false }),
    ] }} />);
    expect(screen.getByText(/12 Camp Street branch/)).toBeTruthy();
    expect(screen.getByText('Royal Camp (this branch)')).toBeTruthy();
    const other = screen.getByRole('link', { name: /Royal Sheriff/ });
    expect(other.getAttribute('href')).toBe('/store/royal-sheriff');
    expect(other.textContent).toContain('Closed');
  });
  it('nothing with one branch or no brand', () => {
    const { container } = render(<BranchSwitcher fallback="x" brand={{ name: 'R', branches: [branch({ current: true })] }} />);
    expect(container.innerHTML).toBe('');
    const none = render(<BranchSwitcher fallback="x" brand={null} />);
    expect(none.container.innerHTML).toBe('');
  });
  it('the store page renders it', () => {
    // Drawn on the server (storefront-page) and placed by the client page: no script on the page for it.
    const page = readFileSync(join(process.cwd(), 'src/components/storefront/storefront-page.tsx'), 'utf8');
    expect(page).toMatch(/branches=\{<BranchSwitcher brand=\{store\.brand\} fallback=\{store\.addressLine1 \|\| store\.name\} \/>\}/);
    const client = readFileSync(join(process.cwd(), 'src/components/storefront/storefront-experience.tsx'), 'utf8');
    expect(client).toMatch(/\{branches\}/);
  });
});
