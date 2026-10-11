'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, ChevronDown, MapPin, Search, X } from 'lucide-react';
import { getAddresses, getHome, getPublicHome, type HomeFeed, type PopularItem, type Vendor } from '@/lib/customer';
import { BROWSE_STALE_MS, fromPage, homeFeedKey, type GuestRead } from '@/lib/browse-keys';
import { isHomeFeed } from '@/lib/app-rules';
import { currentCoords } from '@/lib/geolocate';
import { readShellPerson, shellPersonKey } from '@/lib/shell-data';
import { signInPath } from '@/lib/customer-routes';
import { useCustomerSession } from '@/components/customer-session';
import { Avatar, MoreButton, MoreMenu, PRESS } from '@/components/customer-shell';
import { Pictogram, type PictogramName } from '@/components/glyphs';
import { Modal } from '@/components/modal';
import { DataUnavailable } from '@/components/data-unavailable';
import { HomeSkeleton, RAIL } from '@/components/home-skeleton';
import { EmptyNote, ItemCard, SectionHead, VendorCard, VendorHeroCard, VendorSquareCard, VENDOR_GRID } from '@/components/order-ui';

/**
 * [Q7b · WEB-REDESIGN] HOME — what swiftgy.com opens on, in the owner's
 * design: where it delivers, a greeting, search, the live order, every
 * service one tap away, what is popular, and the stores — open, nearby, and
 * closed for now.
 *
 * Every rail reads the one Home feed the phone app reads
 * (GET /customer/home), so the two never disagree about what is open. No
 * sample names or numbers: a rail with nothing in it is not drawn.
 * Browsing is public: a guest sees everything and signs in only to order.
 */

// The services grid (the phone app's Home tiles). Every destination is a real
// page; Taxi says honestly that rides are booked in the Swift app, and Scan
// says how a store's Swift code opens on the web.
const SERVICES: { key: string; label: string; href?: string; sub: string; pictogram: PictogramName }[] = [
  { key: 'food', label: 'Food', href: '/order/browse?type=RESTAURANT', sub: 'Restaurants & takeaway', pictogram: 'food' },
  { key: 'groceries', label: 'Groceries', href: '/order/browse?type=SUPERMARKET', sub: 'Markets & pharmacies', pictogram: 'groceries' },
  { key: 'taxi', label: 'Taxi', href: '/taxi', sub: 'Book in the Swift mobile app', pictogram: 'taxi' },
  { key: 'send', label: 'Send', href: '/courier', sub: 'A parcel across town', pictogram: 'send' },
  { key: 'services', label: 'Services', href: '/order/browse?type=SERVICE', sub: 'Book a local pro', pictogram: 'services' },
  { key: 'orders', label: 'Orders', href: '/orders', sub: 'Track and reorder', pictogram: 'orders' },
  { key: 'favourites', label: 'Favourites', href: '/account/favourites', sub: 'Stores you saved', pictogram: 'favourites' },
  { key: 'scan', label: 'Scan', sub: 'Open a store from its Swift code', pictogram: 'scan' },
];

const LIVE_TITLE: Record<string, string> = {
  PENDING: 'Waiting for the store', ACCEPTED: 'Accepted', PREPARING: 'Preparing your order', READY_FOR_PICKUP: 'Ready for pickup',
  RIDER_ASSIGNED: 'A rider is on the way to the store', RIDER_EN_ROUTE_PICKUP: 'A rider is on the way to the store', RIDER_ARRIVED_PICKUP: 'Your rider is at the store',
  PICKED_UP: 'On the way', EN_ROUTE_DELIVERY: 'On the way', ARRIVED: 'Your rider is outside',
  DRIVER_ASSIGNED: 'Your driver is on the way', DRIVER_EN_ROUTE: 'Your driver is on the way', DRIVER_ARRIVED: 'Your driver is here', RIDE_IN_PROGRESS: 'On your ride',
  RETURNING: 'Returning to the sender',
};

interface SavedAddress { id: string; label?: string; addressLine1?: string; isDefault?: boolean; latitude?: number; longitude?: number }

function deliveryAddress(addresses: SavedAddress[] | undefined): SavedAddress | null {
  const list = Array.isArray(addresses) ? addresses : [];
  return list.find((address) => address.isDefault) ?? list[0] ?? null;
}

function hasPoint(address: SavedAddress | null): address is SavedAddress & { latitude: number; longitude: number } {
  return Boolean(address && Number.isFinite(address.latitude) && Number.isFinite(address.longitude));
}

/** "Good morning" by the clock in Georgetown — the same on the server and in
 *  the browser, so the first paint and the live page agree. */
export function greetingAt(date: Date): string {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Guyana' }).format(date));
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

export function CustomerHome({ market, seed = null }: { market: string; seed?: GuestRead<HomeFeed> | null }) {
  // A guest's "near me" point lives in the shell for this page load, so Home
  // keeps its order when you come back to it; nothing about it is stored.
  const { status, scope, epoch, nearPoint: point, setNearPoint: setPoint } = useCustomerSession();
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [scanHelp, setScanHelp] = useState(false);

  const addresses = useQuery({
    queryKey: ['customer', 'addresses', scope],
    queryFn: () => getAddresses({ redirectOnExpired: false }) as Promise<SavedAddress[]>,
    enabled: status === 'signed-in',
    staleTime: 60_000,
  });
  const me = useQuery({ queryKey: shellPersonKey(scope, epoch), queryFn: readShellPerson, enabled: status === 'signed-in', staleTime: 5 * 60_000, retry: false });
  const saved = status === 'signed-in' ? deliveryAddress(addresses.data) : null;
  // A signed-in customer sees stores from the address they deliver to; a
  // guest from where the browser is, once they ask.
  const near = hasPoint(saved) ? { lat: saved.latitude, lng: saved.longitude } : status === 'guest' ? point : null;

  // [W2] Two answers, never mixed. Until the server has said who this is —
  // and for every guest — Home shows the PUBLIC feed: the one the server
  // rendered into the page (so the stores are there before any script runs),
  // read with no session at all. Once someone is signed in, their OWN feed (the
  // live order, their usuals) is read with their session, under its own key;
  // the public stores stay on screen while it arrives. When a delivery point
  // turns up, the same person's stores re-sort in place — but an answer never
  // outlives its person: a new epoch starts from nothing.
  const owner = status === 'signed-in' ? 'me' : 'public';
  const feed = useQuery({
    queryKey: homeFeedKey(epoch, owner, near?.lat ?? null, near?.lng ?? null),
    queryFn: async (): Promise<HomeFeed> => {
      const data = owner === 'me' ? await getHome(near ?? undefined) : await getPublicHome(near ?? undefined);
      if (!isHomeFeed(data)) throw new Error('Swift sent an incomplete store list.');
      return data;
    },
    // The guest feed is the same for everyone: fresh for a minute, no re-read
    // on focus — and on the first page load it is the one the server drew
    // into the page. A person's own feed is never seeded and keeps the app's
    // default (it carries their live order).
    ...(owner === 'public' ? { staleTime: BROWSE_STALE_MS, refetchOnWindowFocus: false } : {}),
    ...(owner === 'public' && epoch === 0 && !near ? fromPage(seed) : {}),
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
  const firstName = (me.data?.name ?? '').split(' ')[0] ?? '';
  const greeting = greetingAt(new Date());

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3">
        <DeliveryPoint
          status={status}
          saved={saved}
          savedLoading={status === 'signed-in' && addresses.isPending}
          nearMe={point !== null}
          locating={locating}
          onNearMe={() => void showNearMe()}
        />
        <div className="flex-1" />
        <span className="wide:hidden"><MoreButton open={more} onOpen={() => setMore(true)} /></span>
        {status === 'signed-in' ? (
          <Link href="/account" aria-label="Profile" className="rounded-full"><Avatar name={me.data?.name} /></Link>
        ) : status === 'guest' ? (
          <Link href={signInPath('/')} className="sw-btn sw-btn-sm">Sign in</Link>
        ) : null}
      </div>
      {locationError ? <p role="alert" className="mt-2 text-[13px] leading-[18px] text-[var(--swift-error)]">{locationError}</p> : null}

      <section aria-labelledby="home-title" className="flex flex-col">
        {/* [W2] The page can be served from the server's cache a little after
            it was drawn; the browser's clock is the one that greets. */}
        <h1 id="home-title" className="sw-title mt-3" suppressHydrationWarning>{firstName ? `${greeting}, ${firstName}` : greeting}</h1>
        <p className="sr-only">Order food, groceries and more from businesses in {market} — you pay them directly, cash or MMG.</p>
        <Link
          href="/order/search"
          prefetch={true}
          className={`mt-3 flex h-12 w-full items-center gap-2 rounded-full border border-[var(--swift-border)] bg-[var(--swift-card)] px-4 text-[13px] font-medium leading-[18px] text-[var(--swift-muted-soft)] hover:border-[var(--swift-border-strong)] wide:max-w-[640px] ${PRESS}`}
        >
          <Search size={17} aria-hidden />
          Restaurants, groceries, shops…
        </Link>

        {data?.activeOrder ? <LiveOrder order={data.activeOrder} /> : null}

        <nav aria-label="Services" className="mt-1 pb-3">
          <ul className="grid grid-cols-4 wide:grid-cols-8">
            {SERVICES.map((service) => {
              const tile = (
                <>
                  <span className={`grid h-14 w-14 place-items-center rounded-2xl ${service.key === 'food' ? 'bg-[var(--swift-red)] text-[var(--swift-white)]' : 'bg-[var(--swift-sunken)] text-[var(--swift-ink)]'}`}>
                    <Pictogram name={service.pictogram} size={28} />
                  </span>
                  <span>{service.label}</span>
                  <span className="sr-only">{service.sub}</span>
                </>
              );
              const cls = `mt-3 flex w-full flex-col items-center gap-1.5 text-[13px] font-medium leading-[18px] text-[var(--swift-ink)] active:scale-[0.94] motion-reduce:active:scale-100 transition-transform duration-150`;
              return (
                <li key={service.key}>
                  {service.href ? (
                    <Link href={service.href} className={cls}>{tile}</Link>
                  ) : (
                    <button type="button" onClick={() => setScanHelp(true)} aria-haspopup="dialog" className={`${cls} cursor-pointer border-0 bg-transparent p-0`}>{tile}</button>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
      </section>

      {feed.isError && !data ? (
        <div className="mt-5"><DataUnavailable what="the stores" error={feed.error} onRetry={() => void feed.refetch()} /></div>
      ) : !data ? (
        <div className="mt-5"><HomeSkeleton /></div>
      ) : (
        <HomeRails data={data} />
      )}

      {more ? <MoreMenu guest={status === 'guest'} returnPath={() => '/'} onClose={() => setMore(false)} /> : null}
      {scanHelp ? <ScanHelp onClose={() => setScanHelp(false)} /> : null}
    </div>
  );
}

function HomeRails({ data }: { data: HomeFeed }) {
  const openStores = withoutRepeats(data.nearby, data.openVendors);
  const foodOpen = data.openVendors.filter((v) => v.vendorType === 'RESTAURANT');
  const recommended = (data.featured.length > 0 ? data.featured : foodOpen).filter((v) => v.isCurrentlyOpen).slice(0, 3);
  const shops = data.openVendors.filter((v) => v.vendorType !== 'RESTAURANT' && v.vendorType !== 'SERVICE');
  return (
    <>
      {data.popularItems.length > 0 ? <PopularRail items={data.popularItems} /> : null}

      <div className="sw-bleed sw-band mt-6 flex items-start gap-2 py-6">
        <CircleCheck size={16} className="mt-0.5 flex-none text-[var(--swift-success)]" aria-hidden />
        <div className="flex-1">
          <p className="text-[15px] font-semibold leading-5">0% fees, always.</p>
          <p className="mt-0.5 text-[13px] leading-[18px] text-[var(--swift-muted)]">Swift never marks up your order — pay cash when it arrives.</p>
        </div>
      </div>

      {data.orderAgain.length > 0 ? (
        <section aria-labelledby="order-again-title" className="mt-6">
          <SectionHead id="order-again-title" eyebrow="Your usuals" title="Order again" />
          <Rail>{data.orderAgain.map((vendor) => <li key={vendor.id} className="min-w-0"><VendorSquareCard v={vendor} /></li>)}</Rail>
        </section>
      ) : null}

      {recommended.length > 0 ? (
        <section aria-labelledby="recommended-title" className="mt-6">
          <SectionHead id="recommended-title" eyebrow="Open now" title={data.featured.length > 0 ? 'Recommended for you' : 'Restaurants open now'} seeAll={{ href: '/order/browse?type=RESTAURANT' }} />
          <ul className="sw-bleed sw-rail-scroll auto-cols-[72%] pb-4 pt-4 wide:mx-0 wide:grid-flow-row wide:grid-cols-3 wide:px-0">
            {recommended.map((vendor) => <li key={vendor.id} className="min-w-0"><VendorHeroCard v={vendor} /></li>)}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="open-stores-title" className="mt-6">
        <h2 id="open-stores-title" className="sw-title">{data.nearby.length > 0 ? 'Nearby' : 'Open now'}</h2>
        {openStores.length === 0 ? (
          <div className="mt-4"><EmptyNote>No stores are taking orders near you right now — check back soon.</EmptyNote></div>
        ) : (
          <div className={`mt-4 ${VENDOR_GRID}`}>{openStores.map((vendor) => <VendorCard key={vendor.id} v={vendor} />)}</div>
        )}
      </section>

      {shops.length > 0 ? (
        <section aria-labelledby="shops-title" className="mt-6">
          <SectionHead id="shops-title" title="Groceries & shops" seeAll={{ href: '/order/browse?type=SUPERMARKET' }} />
          <Rail>{shops.map((vendor) => <li key={vendor.id} className="min-w-0"><VendorSquareCard v={vendor} /></li>)}</Rail>
        </section>
      ) : null}

      {data.closedVendors.length > 0 ? (
        <section aria-labelledby="closed-stores-title" className="mt-6">
          <SectionHead id="closed-stores-title" eyebrow="Browse ahead" title="Closed now" />
          <div className={`mt-4 ${VENDOR_GRID}`}>{data.closedVendors.map((vendor) => <VendorCard key={vendor.id} v={vendor} />)}</div>
        </section>
      ) : null}
    </>
  );
}

function Rail({ children }: { children: React.ReactNode }) {
  return <ul className={RAIL}>{children}</ul>;
}

/** Nearby first, then every other open store, each once. */
function withoutRepeats(first: Vendor[], rest: Vendor[]): Vendor[] {
  const seen = new Set<string>();
  return [...first, ...rest].filter((vendor) => (seen.has(vendor.id) ? false : (seen.add(vendor.id), true)));
}

function DeliveryPoint({
  status, saved, savedLoading, nearMe, locating, onNearMe,
}: {
  status: string;
  saved: SavedAddress | null;
  savedLoading: boolean;
  nearMe: boolean;
  locating: boolean;
  onNearMe: () => void;
}) {
  const pill = `inline-flex min-h-8 max-w-full items-center gap-1 rounded-full border border-[var(--swift-border)] bg-[var(--swift-card)] px-3 py-1 text-[13px] font-semibold leading-[18px] text-[var(--swift-ink)] hover:border-[var(--swift-border-strong)] ${PRESS}`;
  if (status === 'checking' || savedLoading) {
    return <span aria-hidden className="sw-skeleton inline-block h-8 w-48 rounded-full" />;
  }
  if (status === 'signed-in') {
    return (
      <Link href="/order/location" className={`${pill} min-w-0`}>
        <MapPin size={14} className="flex-none" aria-hidden />
        <span className="truncate">{saved ? [saved.addressLine1, saved.label].find(Boolean) ?? 'Your address' : 'Add a delivery address'}</span>
        <ChevronDown size={15} className="flex-none text-[var(--swift-muted-soft)]" aria-hidden />
      </Link>
    );
  }
  return (
    <button type="button" onClick={onNearMe} disabled={locating} className={`${pill} cursor-pointer disabled:opacity-60`}>
      <MapPin size={14} className="flex-none" aria-hidden />
      <span>{locating ? 'Finding you…' : nearMe ? 'Showing stores near you' : 'Show stores near me'}</span>
    </button>
  );
}

function LiveOrder({ order }: { order: NonNullable<HomeFeed['activeOrder']> }) {
  const waiting = order.status === 'PENDING';
  return (
    <div className="sw-card mt-4 flex items-center gap-3 p-4">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[15px] font-semibold leading-[22px]">
          <span aria-hidden className={`h-2 w-2 flex-none rounded-full ${waiting ? 'bg-[var(--swift-warning)]' : 'bg-[var(--swift-success)]'}`} />
          {LIVE_TITLE[order.status] ?? 'Your live order'}
        </p>
        <p className="mt-1 truncate text-[13px] leading-[18px] text-[var(--swift-muted)]">{order.vendor?.name ?? 'Swift order'} · {order.orderNumber}</p>
      </div>
      <Link href={`/orders/${order.id}`} className="sw-btn sw-btn-sm sw-btn-ink" aria-label={`Track your live order ${order.orderNumber}`}>Track</Link>
    </div>
  );
}

function PopularRail({ items }: { items: PopularItem[] }) {
  return (
    <section aria-labelledby="popular-title" className="mt-5">
      <SectionHead id="popular-title" eyebrow="Most ordered" title="Popular on Swift" seeAll={{ href: '/order/search' }} />
      <Rail>
        {items.map((item) => (
          <li key={item.id} className="min-w-0">
            <ItemCard
              href={`/order/vendor/${encodeURIComponent(item.vendorId)}?item=${encodeURIComponent(item.id)}`}
              name={item.name}
              price={item.price}
              imageUrl={item.imageUrl}
              vendorType={item.vendorType}
              meta={item.etaMin != null ? `${item.vendorName} · ${item.etaMin} min` : item.vendorName}
            />
          </li>
        ))}
      </Rail>
    </section>
  );
}

function ScanHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal labelledBy="scan-help-title" onClose={onClose} className="bg-[var(--swift-card)] px-6 pb-6 pt-5">
        <div className="flex items-start gap-3">
          <span className="grid h-12 w-12 flex-none place-items-center rounded-2xl bg-[var(--swift-red-50)] text-[var(--swift-red-600)]"><Pictogram name="scan" size={24} /></span>
          <div className="flex-1">
            <h2 id="scan-help-title" className="sw-title">Scan a store’s Swift code</h2>
            <p className="sw-caption mt-1 text-[15px] leading-[22px]">Point your phone’s camera at the Swift code on a store’s counter or flyer. It opens that store here, ready to order.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" data-modal-initial-focus className="sw-icon-btn"><X size={20} aria-hidden /></button>
        </div>
        <button type="button" onClick={onClose} className="sw-btn sw-btn-block mt-5">Got it</button>
    </Modal>
  );
}
