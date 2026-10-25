import type { ReactNode } from 'react';

/**
 * [WEB-REDESIGN] Loading shapes in the design's geometry. Each page's
 * placeholder and its content share the same layout constants (exported
 * below), so nothing moves when the data lands.
 */

export function Bone({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`swift-bone block rounded-lg bg-[var(--swift-skeleton)] ${className}`} />;
}

export function LoadingRegion({ label, className = '', children }: { label: string; className?: string; children: ReactNode }) {
  return <><div aria-busy="true" aria-label={label} className={className}>{children}</div><span role="status" aria-live="polite" className="sr-only">{label}…</span></>;
}

/** Market: the category strip, and the grid of bordered item cards. */
export const MARKET_CHIPS = 'sw-chip-row h-[60px] items-center pt-3';
export const MARKET_GRID = 'grid grid-cols-2 gap-4 wide:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]';
export const MARKET_CARD = 'sw-card flex h-full min-w-0 flex-col overflow-hidden border border-[var(--swift-border)] text-[var(--swift-ink)]';
export const MARKET_IMAGE = 'relative block aspect-square w-full overflow-hidden';
export const MARKET_COPY = 'flex flex-col gap-0.5 p-3';

export function MarketGridSkeleton() {
  return (
    <LoadingRegion label="Loading market items" className={MARKET_GRID}>
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className={MARKET_CARD}>
          <span className={MARKET_IMAGE}><Bone className="h-full rounded-none" /></span>
          <span className={MARKET_COPY}><Bone className="h-[18px] w-3/4" /><Bone className="h-[18px] w-1/2" /><span className="mt-1 flex items-center justify-between"><Bone className="h-[22px] w-16" /><Bone className="h-8 w-8 rounded-full" /></span></span>
        </div>
      ))}
    </LoadingRegion>
  );
}

export function MarketSkeleton() {
  return (
    <div className="flex flex-col">
      <div><span className="sw-eyebrow">Swift market</span><h1 className="sw-title mt-1">Market</h1></div>
      <CategorySkeleton />
      <div className="pb-3 pt-6"><Bone className="h-[14px] w-32" /><Bone className="mt-1 h-7 w-56" /></div>
      <MarketGridSkeleton />
    </div>
  );
}

export function CategorySkeleton() {
  return <LoadingRegion label="Loading categories" className={MARKET_CHIPS}>{[1, 2, 3, 4].map((i) => <Bone key={i} className="h-12 w-20 shrink-0 rounded-full" />)}</LoadingRegion>;
}

/** Orders & rides: one hairline row per order. */
export const ORDER_ROW = 'swift-order-row flex items-center gap-3 border-b border-[var(--swift-border)] py-3';

export function OrdersListSkeleton() {
  return (
    <LoadingRegion label="Loading your orders" className="mt-6">
      {[1, 2, 3].map((i) => (
        <div key={i} className={ORDER_ROW}>
          <Bone className="h-11 w-11 flex-none rounded-xl" />
          <span className="flex min-w-0 flex-1 flex-col gap-1"><Bone className="h-5 w-40" /><Bone className="h-[18px] w-32" /></span>
          <span className="flex flex-col items-end gap-1"><Bone className="h-[22px] w-16" /><Bone className="h-[22px] w-20 rounded-full" /></span>
        </div>
      ))}
    </LoadingRegion>
  );
}

export function OrdersSkeleton() {
  return (
    <div className="flex flex-col">
      <span className="sw-eyebrow">Orders &amp; rides</span>
      <h1 className="sw-title mt-1">Your activity</h1>
      <OrdersListSkeleton />
    </div>
  );
}
