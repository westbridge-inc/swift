import type { ReactNode } from 'react';

export function Bone({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`swift-bone block rounded-lg bg-[var(--swift-subtle)] ${className}`} />;
}

export function LoadingRegion({ label, className = '', children }: { label: string; className?: string; children: ReactNode }) {
  return <><div aria-busy="true" aria-label={label} className={className}>{children}</div><span role="status" aria-live="polite" className="sr-only">{label}…</span></>;
}

export function MenuSkeleton() {
  return (
    <LoadingRegion label="Loading this store" className="space-y-6 pb-24">
      <Bone className="h-44 rounded-2xl md:h-56" />
      <div className="swift-menu-heading"><Bone className="h-8 w-2/3 md:h-9" /><Bone className="mt-1 h-5 w-48" /><Bone className="mt-2 h-12 max-w-2xl" /></div>
      <section>
        <Bone className="mb-3 h-7 w-36" />
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="swift-menu-item flex items-center gap-3 rounded-2xl border border-black/5 bg-white p-3">
              <div className="min-w-0 flex-1"><Bone className="h-6 w-3/4" /><Bone className="h-10" /><Bone className="mt-1 h-6 w-20" /></div>
              <Bone className="h-20 w-20 shrink-0 rounded-xl" />
            </div>
          ))}
        </div>
      </section>
    </LoadingRegion>
  );
}

export function MarketGridSkeleton() {
  return (
    <LoadingRegion label="Loading market items" className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-card)]">
          <Bone className="h-36 rounded-none" /><div className="p-3"><Bone className="h-6 w-3/4" /><Bone className="h-6 w-20" /><Bone className="h-4 w-2/3" /></div>
        </div>
      ))}
    </LoadingRegion>
  );
}

export function MarketSkeleton() {
  return <div className="space-y-5"><div><h1 className="text-2xl font-extrabold">Market</h1><p className="mt-1 text-sm text-[var(--swift-muted)]">Goods from every store — clothes, tools, household things.</p></div><CategorySkeleton /><MarketGridSkeleton /></div>;
}

export function CategorySkeleton() {
  return <LoadingRegion label="Loading categories" className="flex h-12 gap-2 overflow-hidden pb-1">{[1, 2, 3, 4].map((i) => <Bone key={i} className="h-11 w-20 shrink-0 rounded-full" />)}</LoadingRegion>;
}

export function OrdersListSkeleton() {
  return <LoadingRegion label="Loading your orders" className="space-y-4">{[1, 2, 3].map((i) => <div key={i} className="swift-order-row flex items-center justify-between rounded-2xl border border-black/5 bg-white p-4"><div><Bone className="h-6 w-40" /><Bone className="h-5 w-32" /></div><div><Bone className="h-6 w-20 rounded-full" /><Bone className="mt-1 h-6 w-20" /></div></div>)}</LoadingRegion>;
}

export function OrdersSkeleton() {
  return <div className="space-y-4"><h1 className="text-2xl font-extrabold">Your orders</h1><OrdersListSkeleton /></div>;
}
