'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useQuery } from '@tanstack/react-query';
import {
  Car, ChevronRight, Clock, Compass, MapPin, Package, Receipt, Search, ShoppingCart, Store, UtensilsCrossed, Wrench,
} from 'lucide-react';
import { getAddresses, getHome, money, type HomeFeed, type PopularItem, type Vendor } from '@/lib/customer';
import { isHomeFeed } from '@/lib/app-rules';
import { currentCoords } from '@/lib/geolocate';
import { useCustomerSession } from '@/components/customer-session';
import { PRESS } from '@/components/customer-shell';
import { DataUnavailable } from '@/components/data-unavailable';
import { EmptyNote, VendorCard, VendorGridSkeleton } from '@/components/order-ui';

/**
 * [Q7b] HOME — what swiftgy.com opens on. The phone app's Home on the web:
 * where it delivers, search, every service one tap away, the live order, what
 * is popular, the stores you ordered from, and the stores open near you.
 *
 * Every rail reads the one Home feed the phone app reads
 * (GET /customer/home), so the two never disagree about what is open.
 * Browsing is public: a guest sees everything and signs in only to order.
 */

// The services grid (the phone app's Home tiles). Every destination is a real
// page. Taxi is honest: rides are booked in the Swift mobile app, not here.
const SERVICES = [
  { href: '/order/browse?type=RESTAURANT', label: 'Food', sub: 'Restaurants & takeaway', Icon: UtensilsCrossed },
  { href: '/order/browse?type=SUPERMARKET', label: 'Groceries', sub: 'Markets & pharmacies', Icon: ShoppingCart },
  { href: '/order/browse?type=STORE', label: 'Shops', sub: 'Local stores', Icon: Store },
  { href: '/order/browse?type=SERVICE', label: 'Services', sub: 'Book a local pro', Icon: Wrench },
  { href: '/courier', label: 'Send', sub: 'A parcel across town', Icon: Package },
  { href: '/taxi', label: 'Taxi', sub: 'Book in the Swift mobile app', Icon: Car },
  { href: '/orders', label: 'Orders', sub: 'Track and reorder', Icon: Receipt },
  { href: '/explore', label: 'Explore', sub: 'What Swift can do', Icon: Compass },
];

interface SavedAddress { id: string; label?: string; addressLine1?: string; isDefault?: boolean; latitude?: number; longitude?: number }

function deliveryAddress(addresses: SavedAddress[] | undefined): SavedAddress | null {
  const list = Array.isArray(addresses) ? addresses : [];
  return list.find((address) => address.isDefault) ?? list[0] ?? null;
}

function hasPoint(address: SavedAddress | null): address is SavedAddress & { latitude: number; longitude: number } {
  return Boolean(address && Number.isFinite(address.latitude) && Number.isFinite(address.longitude));
}

export function CustomerHome({ market }: { market: string }) {
  // A guest's "near me" point lives in the shell for this page load, so Home
  // keeps its order when you come back to it; nothing about it is stored.
  const { status, scope, epoch, nearPoint: point, setNearPoint: setPoint } = useCustomerSession();
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  const addresses = useQuery({
    queryKey: ['customer', 'addresses', scope],
    queryFn: () => getAddresses({ redirectOnExpired: false }) as Promise<SavedAddress[]>,
    enabled: status === 'signed-in',
    staleTime: 60_000,
  });
  const saved = status === 'signed-in' ? deliveryAddress(addresses.data) : null;
  // A signed-in customer sees stores from the address they deliver to; a
  // guest from where the browser is, once they ask.
  const near = hasPoint(saved) ? { lat: saved.latitude, lng: saved.longitude } : status === 'guest' ? point : null;

  // Asked for at once, beside the session probe: the server reads the cookie
  // itself, so Home never waits on a round trip it does not need. When a
  // delivery point turns up, the same person's stores re-sort in place (their
  // previous answer stays on screen meanwhile) — but an answer never outlives
  // its person: a new epoch starts from nothing.
  const feed = useQuery({
    queryKey: ['customer', 'home', epoch, near?.lat ?? null, near?.lng ?? null],
    queryFn: async (): Promise<HomeFeed> => {
      const data = await getHome(near ?? undefined);
      if (!isHomeFeed(data)) throw new Error('Swift sent an incomplete store list.');
      return data;
    },
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[2] === epoch ? previous : undefined),
  });

  async function showNearMe() {
    setLocating(true);
    setLocationError(null);
    try {
      setPoint(await currentCoords('show the stores near you'));
    } catch (error) {
      setLocationError(error instanceof Error ? error.message : 'We could not get your location.');
    } finally {
      setLocating(false);
    }
  }

  const data = feed.data;
  const openStores = data ? withoutRepeats(data.nearby, data.openVendors) : [];

  return (
    <div className="space-y-8">
      <section aria-labelledby="home-title" className="space-y-4">
        <DeliveryPoint
          status={status}
          saved={saved}
          savedLoading={status === 'signed-in' && addresses.isPending}
          nearMe={point !== null}
          locating={locating}
          locationError={locationError}
          onNearMe={() => void showNearMe()}
        />
        <div>
          <h1 id="home-title" className="text-2xl font-extrabold tracking-tight md:text-3xl">Order food, groceries and more</h1>
          <p className="mt-1 text-sm text-[var(--swift-muted)] md:text-base">
            From businesses in {market} — you pay them directly, cash or MMG. Taxi rides require the Swift mobile app.
          </p>
        </div>
        <Link
          href="/order/search"
          className={`flex items-center gap-3 rounded-full border border-[var(--swift-border)] bg-[var(--swift-card)] px-4 py-3 text-[var(--swift-muted)] shadow-[var(--swift-elevation-card)] md:hidden ${PRESS}`}
        >
          <Search className="h-5 w-5" aria-hidden />
          Search stores, dishes and groceries
        </Link>
        <nav aria-label="Services">
          <ul className="grid grid-cols-4 gap-2 sm:gap-3 lg:grid-cols-8">
            {SERVICES.map(({ href, label, sub, Icon }, index) => (
              <li key={label}>
                <Link
                  href={href}
                  className={`group flex h-full flex-col items-center gap-2 rounded-2xl p-2 text-center hover:bg-[var(--swift-card)] sm:p-3 ${PRESS}`}
                >
                  <span className={`grid h-14 w-14 place-items-center rounded-2xl ${index === 0 ? 'bg-[var(--swift-red)] text-[var(--swift-white)]' : 'bg-[var(--swift-card)] text-[var(--swift-ink)] shadow-[var(--swift-elevation-card)]'}`}>
                    <Icon className="h-6 w-6" aria-hidden />
                  </span>
                  <span className="text-xs font-semibold leading-tight sm:text-sm">{label}</span>
                  <span className="sr-only">{sub}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </section>

      {data?.activeOrder ? <LiveOrder order={data.activeOrder} /> : null}

      {feed.isError && !data ? (
        <DataUnavailable what="the stores" error={feed.error} onRetry={() => void feed.refetch()} />
      ) : !data ? (
        <HomeSkeleton />
      ) : (
        <>
          {data.popularItems.length > 0 ? <PopularRail items={data.popularItems} /> : null}
          {data.orderAgain.length > 0 ? <VendorRail title="Order again" vendors={data.orderAgain} /> : null}
          <section aria-labelledby="open-stores-title">
            <h2 id="open-stores-title" className="text-xl font-extrabold">
              {data.nearby.length > 0 ? 'Stores near you' : 'Open now'}
            </h2>
            {openStores.length === 0 ? (
              <div className="mt-4">
                <EmptyNote>No stores are taking orders near you right now — check back soon.</EmptyNote>
              </div>
            ) : (
              <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {openStores.map((vendor) => <VendorCard key={vendor.id} v={vendor} />)}
              </div>
            )}
          </section>
          {data.closedVendors.length > 0 ? (
            <section aria-labelledby="closed-stores-title">
              <h2 id="closed-stores-title" className="text-lg font-extrabold text-[var(--swift-muted)]">Closed now</h2>
              <div className="mt-3 grid grid-cols-2 gap-4 opacity-80 sm:grid-cols-3 lg:grid-cols-4">
                {data.closedVendors.map((vendor) => <VendorCard key={vendor.id} v={vendor} />)}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Nearby first, then every other open store, each once. */
function withoutRepeats(first: Vendor[], rest: Vendor[]): Vendor[] {
  const seen = new Set<string>();
  return [...first, ...rest].filter((vendor) => (seen.has(vendor.id) ? false : (seen.add(vendor.id), true)));
}

function DeliveryPoint({
  status, saved, savedLoading, nearMe, locating, locationError, onNearMe,
}: {
  status: string;
  saved: SavedAddress | null;
  savedLoading: boolean;
  nearMe: boolean;
  locating: boolean;
  locationError: string | null;
  onNearMe: () => void;
}) {
  const pill = `inline-flex max-w-full items-center gap-2 rounded-full border border-[var(--swift-border)] bg-[var(--swift-card)] px-3.5 py-2 text-sm ${PRESS}`;
  if (status === 'checking' || savedLoading) {
    return <span aria-hidden className="inline-block h-9 w-48 animate-pulse rounded-full bg-[var(--swift-subtle)] motion-reduce:animate-none" />;
  }
  if (status === 'signed-in') {
    return (
      <Link href="/order/location" className={pill}>
        <MapPin className="h-4 w-4 shrink-0 text-[var(--swift-red)]" aria-hidden />
        {saved ? (
          <span className="truncate">
            Deliver to <b className="font-semibold">{saved.label ?? 'your address'}</b>
            {saved.addressLine1 ? <span className="text-[var(--swift-muted)]"> · {saved.addressLine1}</span> : null}
          </span>
        ) : (
          <span className="font-semibold">Add a delivery address</span>
        )}
      </Link>
    );
  }
  return (
    <div>
      <button type="button" onClick={onNearMe} disabled={locating} className={`${pill} disabled:opacity-60`}>
        <MapPin className="h-4 w-4 shrink-0 text-[var(--swift-red)]" aria-hidden />
        <span className="font-semibold">{locating ? 'Finding you…' : nearMe ? 'Showing stores near you' : 'Show stores near me'}</span>
      </button>
      {locationError ? <p role="alert" className="mt-2 text-sm text-[var(--swift-error)]">{locationError}</p> : null}
    </div>
  );
}

function LiveOrder({ order }: { order: NonNullable<HomeFeed['activeOrder']> }) {
  return (
    <Link
      href={`/orders/${order.id}`}
      className={`flex items-center gap-3 rounded-2xl bg-[var(--swift-red)] p-4 text-[var(--swift-white)] shadow-[var(--swift-elevation-raised)] ${PRESS}`}
    >
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[var(--swift-white)]/15">
        <Receipt className="h-5 w-5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold opacity-85">Your live order · {order.orderNumber}</span>
        <span className="block truncate font-bold">{order.vendor?.name ?? 'Swift order'}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-sm font-semibold">
        Track <ChevronRight className="h-4 w-4" aria-hidden />
      </span>
    </Link>
  );
}

const RAIL = 'mt-3 -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 [overscroll-behavior-x:contain] [scrollbar-width:none]';

function PopularRail({ items }: { items: PopularItem[] }) {
  return (
    <section aria-labelledby="popular-title">
      <div className="flex items-end justify-between">
        <h2 id="popular-title" className="text-xl font-extrabold">Popular on Swift</h2>
        <Link href="/order/search" className="text-sm font-semibold text-[var(--swift-red)]">See all</Link>
      </div>
      <ul className={RAIL}>
        {items.map((item) => (
          <li key={item.id} className="w-40 shrink-0 snap-start sm:w-44">
            <Link
              href={`/order/vendor/${encodeURIComponent(item.vendorId)}?item=${encodeURIComponent(item.id)}`}
              className={`block overflow-hidden rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-card)] ${PRESS}`}
            >
              <span className="relative block h-28 bg-[var(--swift-subtle)]">
                {item.imageUrl ? <Image src={item.imageUrl} alt="" fill unoptimized className="object-cover" /> : null}
              </span>
              <span className="block p-2.5">
                <span className="block truncate text-sm font-bold">{item.name}</span>
                <span className="block text-sm font-semibold text-[var(--swift-red)]">{money(item.price)}</span>
                <span className="mt-0.5 flex items-center gap-1 truncate text-xs text-[var(--swift-muted)]">
                  <span className="truncate">{item.vendorName}</span>
                  {item.etaMin != null ? (
                    <>
                      <Clock className="h-3 w-3 shrink-0" aria-hidden />
                      <span className="shrink-0">{item.etaMin} min</span>
                    </>
                  ) : null}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function VendorRail({ title, vendors }: { title: string; vendors: Vendor[] }) {
  const id = `rail-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`;
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="text-xl font-extrabold">{title}</h2>
      <ul className={RAIL}>
        {vendors.map((vendor) => (
          <li key={vendor.id} className="w-60 shrink-0 snap-start">
            <VendorCard v={vendor} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function HomeSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading stores" className="space-y-8">
      <div>
        <div className="h-6 w-44 animate-pulse rounded-lg bg-[var(--swift-subtle)] motion-reduce:animate-none" />
        <div className="mt-3 flex gap-3 overflow-hidden">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-44 w-40 shrink-0 animate-pulse rounded-2xl bg-[var(--swift-subtle)] motion-reduce:animate-none" />
          ))}
        </div>
      </div>
      <VendorGridSkeleton />
    </div>
  );
}
