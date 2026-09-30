'use client';

import Link from 'next/link';
import Image from 'next/image';
import { Star, Clock } from 'lucide-react';
import { Bone } from './customer-skeletons';
import type { Vendor } from '@/lib/customer';

export function VendorCard({ v }: { v: Vendor }) {
  return (
    <Link href={`/order/vendor/${v.id}`} className="group block min-w-0 overflow-hidden rounded-2xl border border-black/5 bg-white transition-shadow hover:shadow-md">
      <div data-store-part="image" className="relative h-32 bg-[var(--swift-subtle)]">
        {v.coverImageUrl && <Image src={v.coverImageUrl} alt={v.name} fill unoptimized sizes="(min-width: 1024px) 264px, (min-width: 640px) 30vw, 46vw" loading="lazy" className="object-cover" />}
        {!v.isCurrentlyOpen && <span className="absolute left-3 top-3 rounded-full bg-black/70 px-2.5 py-1 text-xs font-bold text-white">Closed</span>}
      </div>
      <div data-store-part="copy" className="h-24 min-w-0 p-3">
        <p className="truncate font-bold group-hover:text-[var(--swift-red)]">{v.name}</p>
        <p data-store-part="meta" className="mt-1 flex h-10 flex-wrap content-start items-center gap-x-3 text-sm leading-5 text-[var(--swift-muted)]">
          <span className="flex items-center gap-1"><Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />{v.displayRating === null ? 'New' : v.displayRating.toFixed(1)}</span>
          <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" />~{v.estimatedPrepTime} min</span>
          {v.distanceKm != null && <span>· {v.distanceKm.toFixed(1)} km</span>}
        </p>
      </div>
    </Link>
  );
}

export function VendorGridSkeleton({ n = 8 }: { n?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading stores" className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: n }).map((_, i) => <VendorCardSkeleton key={i} />)}
    </div>
  );
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="rounded-2xl border border-dashed border-black/10 p-8 text-center text-[var(--swift-muted)]">{children}</p>;
}

export function VendorCardSkeleton() {
  return <div className="overflow-hidden rounded-2xl border border-black/5 bg-white">
    <div data-store-part="image" className="relative h-32 bg-[var(--swift-subtle)]"><Bone className="h-full rounded-none" /></div>
    <div data-store-part="copy" className="h-24 min-w-0 p-3"><Bone className="h-6 w-3/4" /><div data-store-part="meta" className="mt-1 flex h-10 flex-wrap content-start items-center gap-x-3 text-sm leading-5 text-[var(--swift-muted)]"><Bone className="h-5 w-24" /></div></div>
  </div>;
}
