'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getMarketCategories, getMarketDepth, getMarketItems, money, type MarketItem } from '@/lib/customer';
import { marketTabVisible } from '@/lib/app-rules';
import { PRESS } from '@/components/customer-shell';
import { DataUnavailable } from '@/components/data-unavailable';
import { EmptyNote, VendorGridSkeleton } from '@/components/order-ui';

/**
 * [Q7b] MARKET — the phone app's Market tab on the web: goods (clothes,
 * tools, household things) across every store, by category. Tapping an item
 * opens it at its own store, where it is added to the one cart.
 *
 * It reads the same public feed the phone app does (GET /market/items), and
 * it exists only while the server's launch-depth verdict says the catalogue
 * is deep enough — "an empty marketplace is worse than no marketplace".
 */
function MarketInner() {
  const params = useSearchParams();
  const category = params.get('category') ?? '';
  const depth = useQuery({ queryKey: ['market', 'depth'], queryFn: getMarketDepth, staleTime: 5 * 60_000, retry: false });
  const open = marketTabVisible(depth.data);
  const categories = useQuery({ queryKey: ['market', 'categories'], queryFn: getMarketCategories, enabled: open, staleTime: 60_000 });
  const feed = useInfiniteQuery({
    queryKey: ['market', 'items', category],
    queryFn: ({ pageParam }) => getMarketItems({ category: category || undefined, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: open,
  });

  if (depth.isPending) return <VendorGridSkeleton />;
  if (depth.isError && !depth.data) return <DataUnavailable what="the market" error={depth.error} onRetry={() => void depth.refetch()} />;
  if (!open) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-extrabold">Market</h1>
        <EmptyNote>The market opens once enough stores list their goods. Until then, every store is on Home.</EmptyNote>
        <Link href="/" className="inline-block rounded-full bg-[var(--swift-red)] px-5 py-2.5 font-bold text-[var(--swift-white)]">Browse stores</Link>
      </div>
    );
  }

  const items: MarketItem[] = feed.data?.pages.flatMap((page) => page.items) ?? [];
  const chips = [{ slug: '', name: 'All' }, ...(categories.data ?? [])];
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-extrabold">Market</h1>
        <p className="mt-1 text-sm text-[var(--swift-muted)]">Goods from every store — clothes, tools, household things.</p>
      </div>
      {chips.length > 1 ? (
        <nav aria-label="Market categories" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [overscroll-behavior-x:contain] [scrollbar-width:none]">
          {chips.map((chip) => (
            <Link
              key={chip.slug || 'all'}
              href={chip.slug ? `/market?category=${encodeURIComponent(chip.slug)}` : '/market'}
              replace
              aria-current={category === chip.slug ? 'page' : undefined}
              className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold ${category === chip.slug ? 'bg-[var(--swift-red)] text-[var(--swift-white)]' : 'border border-[var(--swift-border)] bg-[var(--swift-card)] hover:bg-[var(--swift-subtle)]'}`}
            >
              {chip.name}
            </Link>
          ))}
        </nav>
      ) : null}

      {feed.isError && items.length === 0 ? (
        <DataUnavailable what="the market" error={feed.error} onRetry={() => void feed.refetch()} />
      ) : feed.isPending ? (
        <VendorGridSkeleton />
      ) : items.length === 0 ? (
        <EmptyNote>{category ? 'No store has listed anything here yet. Try another category.' : 'The market is still filling up.'}</EmptyNote>
      ) : (
        <>
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {items.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/order/vendor/${encodeURIComponent(item.vendorId)}?item=${encodeURIComponent(item.id)}`}
                  className={`block overflow-hidden rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-card)] ${PRESS}`}
                >
                  <span className="relative block h-36 bg-[var(--swift-subtle)]">
                    {item.imageUrl ? <Image src={item.imageUrl} alt="" fill unoptimized className="object-cover" /> : null}
                    {item.isNew ? <span className="absolute left-2 top-2 rounded-full bg-[var(--swift-ink)] px-2 py-0.5 text-[length:var(--swift-type-micro)] font-bold text-[var(--swift-white)]">NEW</span> : null}
                  </span>
                  <span className="block p-3">
                    <span className="block truncate font-bold">{item.name}</span>
                    <span className="block font-semibold text-[var(--swift-red)]">{money(item.basePrice)}</span>
                    <span className="block truncate text-xs text-[var(--swift-muted)]">{item.vendorName}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {feed.hasNextPage ? (
            <button
              type="button"
              onClick={() => void feed.fetchNextPage()}
              disabled={feed.isFetchingNextPage}
              className={`mx-auto block rounded-full border border-[var(--swift-border-strong)] px-6 py-2.5 font-semibold disabled:opacity-60 ${PRESS}`}
            >
              {feed.isFetchingNextPage ? 'Loading…' : 'Show more'}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

export default function MarketPage() {
  return <Suspense fallback={<VendorGridSkeleton />}><MarketInner /></Suspense>;
}
