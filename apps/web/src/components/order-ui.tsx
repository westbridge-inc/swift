'use client';

import Link from 'next/link';
import Image from 'next/image';
import { Star, Clock } from 'lucide-react';
import type { Vendor } from '@/lib/customer';

export function VendorCard({ v }: { v: Vendor }) {
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

export function VendorGridSkeleton({ n = 8 }: { n?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: n }).map((_, i) => <div key={i} className="h-48 animate-pulse rounded-2xl bg-[var(--swift-subtle)]" />)}
    </div>
  );
}

export function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="rounded-2xl border border-dashed border-black/10 p-8 text-center text-[var(--swift-muted)]">{children}</p>;
}
