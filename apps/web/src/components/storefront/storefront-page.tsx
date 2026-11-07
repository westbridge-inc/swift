import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { fetchStorefront } from '@/lib/api';
import { storeMenuForPage } from '@/lib/browse-server';
import { storefrontVerticalVariables } from '@/lib/design-tokens';
import { StorefrontExperience } from './storefront-experience';
import { BranchSwitcher } from './branch-switcher';
import { canonicalStorePath, requestedItem, type StoreQuery } from './store-path';

type StorefrontRouteProps = {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/** Where signing in brings a guest back to: this store, as it was scanned (the
 *  item a guest chose rides in the sign-in continuation, not the address). */
function scannedReturnPath(slug: string, searchParams: StoreQuery): string {
  const rest = { ...searchParams };
  delete rest['item'];
  return canonicalStorePath(slug, rest);
}

export async function generateStorefrontMetadata({ params }: StorefrontRouteProps): Promise<Metadata> {
  const { slug } = await params;
  const store = await fetchStorefront(slug);
  if (!store) return { title: 'Store not found' };
  return {
    title: `${store.name} — order on Swift`,
    description:
      store.description ??
      `${store.name} in ${store.city} — browse the live listings and place an order on Swift.`,
    alternates: { canonical: `/store/${store.slug}` },
  };
}

export async function StorefrontPage({ params, searchParams }: StorefrontRouteProps) {
  const { slug } = await params;
  const store = await fetchStorefront(slug);
  if (!store) notFound();
  const query = searchParams ? await searchParams : {};
  const fromQr = query['src'] === 'qr';
  const returnPath = scannedReturnPath(store.slug, query);
  // [PERF #2] A recent live menu arrives in the page, so Add works without the
  // browser reading the store and its menu again first.
  const liveMenu = await storeMenuForPage(store.id);
  // The store's vertical tint is worked out here, on the server, so the
  // design-token tables are not part of the page's first-load JavaScript.
  return <StorefrontExperience key={`${store.slug}:${fromQr}`} store={store} returnPath={returnPath} fromQr={fromQr} initialItemId={requestedItem(query)} verticalStyle={storefrontVerticalVariables(store.vendorType)} liveMenu={liveMenu} branches={<BranchSwitcher brand={store.brand} fallback={store.addressLine1 || store.name} />} />;
}
