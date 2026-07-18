'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { UtensilsCrossed, ShoppingCart, Store, Car, Package, Wrench, Compass, Star, Clock } from 'lucide-react';
import { getHome, type Vendor } from '@/lib/customer';

// The 4 primary options the founder asked for (3 ordering verticals + the
// web-only Explore Swift), then the rest of what the app offers.
const PRIMARY = [
  { href: '/order/browse?type=RESTAURANT', label: 'Food', sub: 'Restaurants & takeaway', Icon: UtensilsCrossed },
  { href: '/order/browse?type=SUPERMARKET', label: 'Groceries & Shops', sub: 'Markets, pharmacies, goods', Icon: ShoppingCart },
  { href: '/taxi', label: 'Taxi', sub: 'A ride, cash on arrival', Icon: Car },
  { href: '/explore', label: 'Explore Swift', sub: 'What Swift can do', Icon: Compass, web: true },
];
const SECONDARY = [
  { href: '/order/browse?type=STORE', label: 'Shops', Icon: Store },
  { href: '/courier', label: 'Send a package', Icon: Package },
  { href: '/order/browse?type=SERVICE', label: 'Services', Icon: Wrench },
];

function VendorCard({ v }: { v: Vendor }) {
  return (
    <Link href={`/order/vendor/${v.id}`} className="group overflow-hidden rounded-2xl border border-black/5 bg-white transition-shadow hover:shadow-md">
      <div className="relative h-32 bg-[var(--swift-subtle)]">
        {v.coverImageUrl && <Image src={v.coverImageUrl} alt={v.name} fill unoptimized className="object-cover" />}
        {!v.isCurrentlyOpen && <span className="absolute left-3 top-3 rounded-full bg-black/70 px-2.5 py-1 text-xs font-bold text-white">Closed</span>}
      </div>
      <div className="p-3">
        <p className="font-bold group-hover:text-[var(--swift-red)]">{v.name}</p>
        <p className="mt-1 flex items-center gap-3 text-sm text-[var(--swift-muted)]">
          <span className="flex items-center gap-1"><Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />{(v.averageRating ?? 0).toFixed(1)}</span>
          <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" />~{v.estimatedPrepTime} min</span>
          {v.distanceKm != null && <span>· {v.distanceKm.toFixed(1)} km</span>}
        </p>
      </div>
    </Link>
  );
}

export default function OrderHome() {
  const [featured, setFeatured] = useState<Vendor[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getHome()
      .then((d) => setFeatured([...(d.featured ?? []), ...(d.openVendors ?? []), ...(d.nearby ?? [])].slice(0, 8)))
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-extrabold md:text-3xl">Order on Swift</h1>
        <p className="mt-1 text-[var(--swift-muted)]">Food, groceries, a ride, and more — pay the business or driver directly, cash or MMG.</p>
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {PRIMARY.map(({ href, label, sub, Icon, web }) => (
            <Link key={label} href={href} className="group rounded-2xl border border-black/5 bg-white p-4 transition-shadow hover:shadow-md">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--swift-red-50)]">
                <Icon className="h-5.5 w-5.5 text-[var(--swift-red)]" />
              </span>
              <p className="mt-3 font-bold group-hover:text-[var(--swift-red)]">{label}{web && <span className="ml-1 rounded-full bg-[var(--swift-red-50)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--swift-red)]">WEB</span>}</p>
              <p className="text-xs text-[var(--swift-muted)]">{sub}</p>
            </Link>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {SECONDARY.map(({ href, label, Icon }) => (
            <Link key={label} href={href} className="flex items-center gap-2 rounded-full border border-black/10 bg-white px-3.5 py-2 text-sm font-semibold hover:bg-[var(--swift-subtle)]">
              <Icon className="h-4 w-4 text-[var(--swift-red)]" /> {label}
            </Link>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-xl font-extrabold">Featured near you</h2>
        {error ? (
          <p className="mt-4 rounded-2xl border border-dashed border-black/10 p-8 text-center text-[var(--swift-muted)]">Couldn’t load stores — {error}</p>
        ) : featured === null ? (
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-48 animate-pulse rounded-2xl bg-[var(--swift-subtle)]" />)}
          </div>
        ) : featured.length === 0 ? (
          <p className="mt-4 rounded-2xl border border-dashed border-black/10 p-8 text-center text-[var(--swift-muted)]">No open stores near you right now — check back soon.</p>
        ) : (
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {featured.map((v) => <VendorCard key={v.id} v={v} />)}
          </div>
        )}
      </section>
    </div>
  );
}
