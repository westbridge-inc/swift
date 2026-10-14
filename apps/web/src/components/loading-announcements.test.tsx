import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ContentSkeleton } from './customer-shell';
import { HomeSkeleton } from './home-skeleton';
import { VendorGridSkeleton } from './order-ui';
import { CategorySkeleton, MarketGridSkeleton, OrdersListSkeleton } from './customer-skeletons';
import { StoreSkeleton } from './storefront/store-skeleton';
import CartSkeleton from '@/app/(app)/cart/loading';
import OrderDetailSkeleton from '@/app/(app)/orders/[id]/loading';
import SearchSkeleton from '@/app/(app)/order/search/loading';

it.each([
  [ContentSkeleton, 'Opening this page…'],
  [HomeSkeleton, 'Loading home feed…'],
  [VendorGridSkeleton, 'Loading stores…'],
  [StoreSkeleton, 'Loading this store…'],
  [CategorySkeleton, 'Loading categories…'],
  [MarketGridSkeleton, 'Loading market items…'],
  [OrdersListSkeleton, 'Loading your orders…'],
  [CartSkeleton, 'Loading your cart…'],
  [OrderDetailSkeleton, 'Loading order tracking…'],
  [SearchSkeleton, 'Searching…'],
] as const)('%s announces loading without changing its visual layout', (Skeleton, announcement) => {
  const view = render(<Skeleton />);
  const status = screen.getAllByRole('status').find((node) => node.textContent === announcement);
  expect(status).toBeTruthy();
  expect(status?.getAttribute('aria-live')).toBe('polite');
  expect(status?.classList.contains('sr-only')).toBe(true);
  expect(status?.closest('[aria-busy="true"]')).toBeNull();
  view.rerender(<p>Loaded</p>);
  expect(screen.queryByRole('status')).toBeNull();
});
