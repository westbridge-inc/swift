'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/auth';
import { getAddresses, getHome, type HomeFeed, type Vendor } from '@/lib/customer';
import { isHomeFeed } from '@/lib/app-rules';
import { useCustomerSession, type NearPoint } from './customer-session';
import { DataUnavailable } from './data-unavailable';
import { Bone, LoadingRegion } from './customer-skeletons';
import { EmptyNote, VendorCard, VendorGridSkeleton } from './order-ui';
import { PRESS } from './customer-shell';
import { RAIL } from './home-skeleton';

type Category = { slug: string; name: string; emoji: string; kind: string; vertical: string; iconKey: string | null; availableVendors: number };
interface Discovery { enabled: boolean; categories: Category[] }
const KIND_LABEL: Record<string, string> = { CUISINE: 'Cuisines', DISH: 'Dishes & cravings', DIETARY: 'Dietary', AISLE: 'Grocery aisles', RETAIL: 'Shops' };

function coordinates(near: NearPoint | null): Record<string, string> {
  return near ? { lat: String(near.lat), lng: String(near.lng) } : {};
}
export function categoryPath(c: Pick<Category, 'slug' | 'name' | 'emoji'>) {
  return `/order/browse?${new URLSearchParams({ category: c.slug, name: c.name, emoji: c.emoji })}`;
}
function useCategories(near: NearPoint | null) {
  return useQuery({ queryKey: ['discovery', 'categories', near?.lat ?? null, near?.lng ?? null],
    queryFn: async (): Promise<Discovery> => {
      const query = new URLSearchParams(coordinates(near));
      const data = (await apiFetch(`/api/v1/discovery/categories${query.size ? `?${query}` : ''}`, undefined, { redirectOnExpired: false })).data;
      if (typeof data?.enabled !== 'boolean' || !Array.isArray(data.categories)) throw new Error('Could not load categories.');
      return data;
    }, staleTime: 60_000, retry: false });
}

// Reuse Home's delivery-address cache; guests use only the location they asked for.
function useDiscoveryPoint() {
  const session = useCustomerSession();
  const addresses = useQuery({ queryKey: ['customer', 'addresses', session.scope],
    queryFn: () => getAddresses({ redirectOnExpired: false }), enabled: session.status === 'signed-in', staleTime: 60_000 });
  const list = Array.isArray(addresses.data) ? addresses.data : [];
  const saved = list.find((a) => a.isDefault) ?? list[0];
  return session.status === 'signed-in' && Number.isFinite(saved?.latitude) && Number.isFinite(saved?.longitude)
    ? { lat: saved.latitude as number, lng: saved.longitude as number } : session.status === 'guest' ? session.nearPoint : null;
}

function CategoryLink({ category }: { category: Category }) {
  return <Link href={categoryPath(category)} aria-label={category.name} className={`flex h-28 w-20 shrink-0 flex-col items-center gap-2 text-center text-xs font-semibold ${PRESS}`}>
    <span aria-hidden className="grid h-16 w-16 place-items-center rounded-2xl bg-[var(--swift-red)]/10 text-3xl">{category.emoji}</span><span>{category.name}</span>
  </Link>;
}
function CategorySkeleton({ heading = false }: { heading?: boolean }) {
  return <LoadingRegion label="Loading categories">{heading && <Bone className="h-11 w-44" />}<div className={RAIL}>{[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-28 w-20 shrink-0"><Bone className="mx-auto h-16 w-16 rounded-2xl" /><Bone className="mx-auto mt-2 h-8 w-16" /></div>)}</div></LoadingRegion>;
}

export function HomeCategories({ near, fallback }: { near: NearPoint | null; fallback: HomeFeed['categories'] | undefined }) {
  const rail = useCategories(near);
  const names = new Set<string>();
  const legacy = fallback?.filter((c) => {
    const name = c.name.trim().toLowerCase();
    if (names.has(name)) return false;
    names.add(name);
    return true;
  }) ?? [];
  const live = rail.data?.enabled && rail.data.categories.length >= 4;
  if (rail.isPending) return <CategorySkeleton heading />;
  if (!live && !legacy.length) return null;
  return <section aria-labelledby="home-categories"><div className="flex items-center justify-between gap-3">
    <h2 id="home-categories" className="text-xl font-extrabold">Find by category</h2>
    <Link className="inline-flex min-h-11 items-center text-sm font-semibold text-[var(--swift-red)]" href={live ? '/order/browse?view=categories' : '/order/search'} aria-label="See all categories">See all</Link>
  </div><div className={RAIL}>
    {live ? rail.data!.categories.map((c) => <CategoryLink key={c.slug} category={c} />) : legacy.map((c) => <Link key={c.id} href={`/order/search?q=${encodeURIComponent(c.name)}`} className={`relative flex h-28 w-28 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-[var(--swift-subtle)] p-3 text-center text-sm font-semibold ${PRESS}`}>{c.imageUrl && <><Image src={c.imageUrl} alt="" fill unoptimized sizes="112px" className="object-cover" /><span className="absolute inset-0 bg-black/50" /></>}<span className={`relative ${c.imageUrl ? 'text-white' : ''}`}>{c.name}</span></Link>)}
  </div></section>;
}

export function CategoryGrid() {
  const near = useDiscoveryPoint();
  const rail = useCategories(near);
  const categories = rail.data?.categories ?? [];
  const groups = new Map<string, Category[]>();
  for (const c of categories) groups.set(c.kind, [...(groups.get(c.kind) ?? []), c]);
  return <div className="space-y-5"><h1 className="text-2xl font-extrabold">Browse by category</h1>
    {rail.isPending ? <CategorySkeleton /> : rail.isError || !rail.data?.enabled ? <DataUnavailable what="categories" onRetry={() => void rail.refetch()} />
      : !categories.length ? <EmptyNote><strong className="block">Nothing to browse right now</strong><span>Categories appear here as stores open.</span></EmptyNote>
      : [...groups].map(([kind, cats]) => <section key={kind}><h2 className="mb-3 text-lg font-bold">{KIND_LABEL[kind] ?? kind}</h2><div className="flex flex-wrap gap-3">{cats.map((c) => <CategoryLink key={c.slug} category={c} />)}</div></section>)}
  </div>;
}

export function CategoryFeed({ slug, name, emoji }: { slug: string; name: string; emoji: string }) {
  const near = useDiscoveryPoint();
  const rail = useCategories(near);
  const vendors = useQuery({ queryKey: ['customer', 'category', slug, near?.lat ?? null, near?.lng ?? null],
    queryFn: async (): Promise<Vendor[]> => {
      const query = new URLSearchParams({ category: slug, ...coordinates(near) });
      return (await apiFetch(`/api/v1/customer/vendors?${query}`, undefined, { redirectOnExpired: false })).data;
    }, retry: false });
  const open = vendors.data?.filter((v) => v.isCurrentlyOpen) ?? [];
  const closed = vendors.data?.filter((v) => !v.isCurrentlyOpen) ?? [];
  const siblings = rail.data?.categories.filter((c) => c.slug !== slug).slice(0, 3) ?? [];
  const cards = (list: Vendor[]) => <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{list.map((v) => <VendorCard key={v.id} v={v} categoryName={name} />)}</div>;
  return <div className="space-y-5"><h1 className="text-2xl font-extrabold">{emoji ? `${emoji} ` : ''}{name}</h1>
    {vendors.isError ? <DataUnavailable what="these stores" error={vendors.error} onRetry={() => void vendors.refetch()} />
      : !vendors.data ? <VendorGridSkeleton /> : !vendors.data.length ? <>
        <EmptyNote><strong className="block">No {name.toLowerCase()} spots are open right now</strong><span>Check back soon.</span></EmptyNote>
        {siblings.length > 0 && <nav aria-label="Open now instead"><p className="mb-3 text-sm text-[var(--swift-muted)]">Open now instead</p><div className="flex gap-3">{siblings.map((c) => <CategoryLink key={c.slug} category={c} />)}</div></nav>}
      </> : <>{cards(open)}{closed.length > 0 && <section className="space-y-3"><h2 className="text-lg font-bold text-[var(--swift-muted)]">Closed now</h2>{cards(closed)}</section>}</>}
  </div>;
}

export function RecommendedStores() {
  const near = useDiscoveryPoint();
  const { epoch } = useCustomerSession();
  const feed = useQuery({ queryKey: ['customer', 'home', epoch, near?.lat ?? null, near?.lng ?? null], queryFn: async () => {
    const data = await getHome(near ?? undefined);
    if (!isHomeFeed(data)) throw new Error('Swift sent an incomplete store list.');
    return data;
  }, retry: false });
  const seen = new Set(feed.data?.featured.map((v) => v.id));
  const vendors = [...(feed.data?.featured ?? []), ...(feed.data?.openVendors.filter((v) => !seen.has(v.id)) ?? [])];
  return <div className="space-y-5"><h1 className="text-2xl font-extrabold">Recommended</h1>
    {feed.isError ? <DataUnavailable what="recommended stores" error={feed.error} onRetry={() => void feed.refetch()} /> : !feed.data ? <VendorGridSkeleton />
      : !vendors.length ? <EmptyNote><strong className="block">Nothing open right now</strong><span>Come back soon — stores set their own hours.</span></EmptyNote>
      : <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{vendors.map((v) => <VendorCard key={v.id} v={v} />)}</div>}
  </div>;
}
