'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getMarketCategories, getMarketDepth, getMarketItems, money, type MarketCategory, type MarketDepth, type MarketItem } from '@/lib/customer';

/** What the server drew into the page (page.tsx), and for which category. */
export type MarketPageSeed = {
  category: string;
  depth: GuestRead<MarketDepth> | null;
  categories: GuestRead<MarketCategory[]> | null;
  items: GuestRead<{ items: MarketItem[]; nextCursor: string | null }> | null;
} | null;
import { marketTabVisible } from '@/lib/app-rules';
import { BROWSE_STALE_MS, fromPage, marketCategoriesKey, marketDepthKey, marketItemsKey, type GuestRead } from '@/lib/browse-keys';
import { PRESS } from '@/components/customer-shell';
import { DataUnavailable } from '@/components/data-unavailable';
import { MarketSkeleton, MarketGridSkeleton, CategorySkeleton, MARKET_CARD, MARKET_CHIPS, MARKET_COPY, MARKET_GRID, MARKET_IMAGE } from '@/components/customer-skeletons';
import { EmptyNote, Photo } from '@/components/order-ui';
import { Pictogram } from '@/components/glyphs';
import { launchCity } from '@/lib/web-ordering';
import { CircleCheck, Plus, Search } from 'lucide-react';

/**
 * [Q7b] MARKET — the phone app's Market tab on the web: goods (clothes,
 * tools, household things) across every store, by category. Tapping an item
 * opens it at its own store, where it is added to the one cart.
 *
 * It reads the same public feed the phone app does (GET /market/items), and
 * it exists only while the server's launch-depth verdict says the catalogue
 * is deep enough — "an empty marketplace is worse than no marketplace".
 */
function MarketInner({ seed }: { seed: MarketPageSeed }) {
  const params = useSearchParams();
  const category = params.get('category') ?? '';
  // [W2] The first screen — the verdict, the chips, the first goods — arrives
  // in the page from the server (page.tsx) as these queries' first answers.
  const drawn = seed?.category === category ? seed : null;
  const depth = useQuery({ queryKey: marketDepthKey, queryFn: getMarketDepth, staleTime: 5 * 60_000, retry: false, ...fromPage(seed?.depth) });
  const open = marketTabVisible(depth.data);
  const categories = useQuery({ queryKey: marketCategoriesKey, queryFn: getMarketCategories, enabled: open, staleTime: BROWSE_STALE_MS, refetchOnWindowFocus: false, ...fromPage(seed?.categories) });
  const feed = useInfiniteQuery({
    queryKey: marketItemsKey(category),
    staleTime: BROWSE_STALE_MS,
    refetchOnWindowFocus: false,
    ...(drawn?.items ? { initialData: { pages: [drawn.items.data], pageParams: [undefined] }, initialDataUpdatedAt: drawn.items.at } : {}),
    queryFn: ({ pageParam }) => getMarketItems({ category: category || undefined, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: open,
  });

  if (depth.isPending) return <MarketSkeleton />;
  if (depth.isError && !depth.data) return <div className="pt-2"><DataUnavailable what="the market" error={depth.error} onRetry={() => void depth.refetch()} /></div>;
  if (!open) {
    return (
      <div className="flex flex-col">
        <MarketHeader />
        <div className="sw-empty">
          <span className="sw-empty-tile"><Pictogram name="shops" size={40} /></span>
          <p className="sw-heading">The market isn’t open yet</p>
          <p className="sw-caption max-w-[360px] text-[15px] leading-[22px]">The market opens once enough stores list their goods. Until then, every store is on Home.</p>
          <Link href="/" className="sw-btn sw-btn-block mt-4 max-w-[400px]">Browse stores</Link>
        </div>
      </div>
    );
  }

  const items: MarketItem[] = feed.data?.pages.flatMap((page) => page.items) ?? [];
  const chips = [{ slug: '', name: 'All' }, ...(categories.data ?? [])];
  const current = chips.find((chip) => chip.slug === category);
  return (
    <div className="flex flex-col">
      <MarketHeader />
      {categories.isPending ? <CategorySkeleton /> : (
        <nav aria-label="Market categories" className={MARKET_CHIPS}>
          {chips.map((chip) => (
            <Link
              key={chip.slug || 'all'}
              href={chip.slug ? `/market?category=${encodeURIComponent(chip.slug)}` : '/market'}
              replace
              aria-current={category === chip.slug ? 'page' : undefined}
              className="sw-chip h-12 px-5"
            >
              {chip.name}
            </Link>
          ))}
        </nav>
      )}

      <div className="pb-3 pt-6">
        <span className="sw-eyebrow sw-eyebrow-soft">Fresh from local sellers</span>
        <h2 className="sw-title mt-0.5">{category && current ? current.name : 'Everything in the market'}</h2>
      </div>

      {feed.isError && items.length === 0 ? (
        <DataUnavailable what="the market" error={feed.error} onRetry={() => void feed.refetch()} />
      ) : feed.isPending ? (
        <MarketGridSkeleton />
      ) : items.length === 0 ? (
        <EmptyNote>{category ? 'No store has listed anything here yet. Try another category.' : 'The market is still filling up.'}</EmptyNote>
      ) : (
        <>
          <ul className={MARKET_GRID}>
            {items.map((item) => (
              <li key={item.id} className="min-w-0">
                <Link
                  href={`/order/vendor/${encodeURIComponent(item.vendorId)}?item=${encodeURIComponent(item.id)}`}
                  className={`${MARKET_CARD} ${PRESS}`}
                >
                  <span className={MARKET_IMAGE}>
                    <Photo src={item.imageUrl} vendorType="STORE" name={item.name} sizes="(min-width: 760px) 220px, 46vw" className="absolute inset-0 rounded-none" />
                    {item.isNew ? <span className="absolute left-2 top-2 rounded-full bg-[rgba(33,26,26,0.72)] px-3 py-[5px] text-[13px] font-semibold leading-[18px] text-[var(--swift-white)]">NEW</span> : null}
                  </span>
                  <span className={MARKET_COPY}>
                    <span className="line-clamp-2 text-[13px] font-semibold leading-[18px]">{item.name}</span>
                    <span className="truncate text-[13px] leading-[18px] text-[var(--swift-muted)]">{item.vendorName}</span>
                    <span className="mt-1 flex items-center justify-between">
                      <span className="sw-money text-[var(--swift-red)]">{money(item.basePrice)}</span>
                      <span aria-hidden="true" className="grid h-8 w-8 place-items-center rounded-full bg-[var(--swift-red)] text-[var(--swift-white)]"><Plus size={18} /></span>
                    </span>
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
              className="sw-btn sw-btn-md sw-btn-outline mx-auto mt-6"
            >
              {feed.isFetchingNextPage ? 'Loading…' : 'Show more'}
            </button>
          ) : null}
        </>
      )}
      <p className="mt-5 flex items-start gap-2 text-[13px] leading-[18px] text-[var(--swift-muted)]">
        <CircleCheck size={16} className="mt-0.5 flex-none text-[var(--swift-success)]" aria-hidden />
        Every shop here pays Swift a flat weekly fee and keeps 100% of what it sells.
      </p>
    </div>
  );
}

function MarketHeader() {
  return (
    <div className="flex items-start">
      <div className="flex-1">
        <span className="sw-eyebrow">Swift market · {launchCity()}</span>
        <h1 className="sw-title mt-1">Market</h1>
      </div>
      <Link href="/order/search" aria-label="Search the market" className="sw-icon-btn mt-1"><Search size={19} aria-hidden /></Link>
    </div>
  );
}

export function MarketScreen({ seed = null }: { seed?: MarketPageSeed }) {
  return <Suspense fallback={<MarketSkeleton />}><MarketInner seed={seed} /></Suspense>;
}
