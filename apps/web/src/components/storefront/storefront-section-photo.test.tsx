import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StorefrontExperience } from './storefront-experience';
import * as customer from '@/lib/customer';
import * as auth from '@/lib/auth';
import type { StorefrontDetail } from '@/lib/api';

// [IMAGES-E2E PR5 · COORD GO 21 Oct, owner rule "business pictures must reach customers"]
// A menu section's own photo shows above its heading on the store page, as on the phone.
// Only a photo Swift keeps is drawn, through the bounded /media route at a ladder width; no
// photo, an outside address or a photo that fails to load leaves today's heading alone.
// Synthetic data only.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), notFound: () => { throw new Error('not found'); } }));

const item = (id: string) => ({ id, name: `Dish ${id}`, description: null, basePrice: 800, imageUrl: null, unit: null, isPopular: false, fulfillment: 'DELIVERY' });
const KEPT = 'items/menu-store/abcdefghijklmnop.jpg';
const storefront = {
  id: 'menu-store', slug: 'sample-kitchen', name: 'Sample Kitchen', description: null, vendorType: 'RESTAURANT',
  logoUrl: null, coverImageUrl: null, city: 'Georgetown', region: 'Demerara', cuisineTypes: [], tags: [],
  displayRating: null, ratingBucket: 'NEW', ratingCount: 0, topRated: false, isCurrentlyOpen: true, acceptingOrders: true,
  estimatedPrepTime: 20, minOrderAmount: 0, isFeatured: false, addressLine1: 'Fixture street', operatingHours: [],
  categories: [
    { id: 'mains', name: 'Mains', imageUrl: KEPT, items: [item('a')] },
    { id: 'drinks', name: 'Drinks', imageUrl: 'https://elsewhere.example/drinks.jpg', items: [item('b')] },
    { id: 'sides', name: 'Sides', imageUrl: null, items: [item('c')] },
  ],
} as unknown as StorefrontDetail;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(auth, 'sessionProbe').mockResolvedValue({ ok: false } as Awaited<ReturnType<typeof auth.sessionProbe>>);
  vi.spyOn(customer, 'getPublicStorefront').mockResolvedValue(storefront);
  vi.spyOn(customer, 'getPublicVendor').mockResolvedValue(null as never);
});

const section = (id: string) => document.getElementById(`section-${id}`) as HTMLElement;
const imgs = (el: HTMLElement) => [...el.querySelectorAll('img')];

describe('a menu section\'s photo on the store page', () => {
  it('draws the kept photo through /media above the heading; an outside address or none leaves the heading alone', () => {
    render(<StorefrontExperience store={storefront} returnPath="/store/sample-kitchen" />);
    const [photo] = imgs(section('mains'));
    expect(photo?.getAttribute('src')).toMatch(/^(?:https?:\/\/[^/]+)?\/media\/items\/menu-store\/abcdefghijklmnop\.jpg\?w=\d+/);
    expect(photo?.getAttribute('alt')).toBe('');
    expect(section('mains').querySelector('h2')?.textContent).toBe('Mains');
    for (const id of ['drinks', 'sides']) {
      expect(imgs(section(id)), id).toEqual([]);
      expect(section(id).querySelector('h2')).toBeTruthy();
    }
    expect(document.body.innerHTML).not.toContain('elsewhere.example');
  });

  it('a photo that fails to load is removed: the heading stays, no broken tile', () => {
    render(<StorefrontExperience store={storefront} returnPath="/store/sample-kitchen" />);
    const [photo] = imgs(section('mains'));
    fireEvent.error(photo!);
    expect(imgs(section('mains'))).toEqual([]);
    expect(section('mains').querySelector('h2')?.textContent).toBe('Mains');
  });
});
