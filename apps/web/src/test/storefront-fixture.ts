import type { StorefrontDetail } from '@/lib/api';

/**
 * [W6] A synthetic store's public storefront (the shape GET
 * /public/storefronts/:slug returns), completed with neutral defaults so the
 * older store-flow tests can serve their store to the one store page.
 */
export function storefrontFixture(value: Record<string, unknown>): StorefrontDetail {
  return {
    description: null, logoUrl: null, coverImageUrl: null, city: 'Georgetown', region: 'Demerara',
    addressLine1: 'Fixture area', operatingHours: [], tags: [], cuisineTypes: [], isFeatured: false,
    minOrderAmount: 0, acceptingOrders: true,
    ...value,
  } as unknown as StorefrontDetail;
}
