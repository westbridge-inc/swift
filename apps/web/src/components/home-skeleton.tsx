import { Bone, LoadingRegion } from './customer-skeletons';
import { ItemCardSkeleton, VendorCardSkeleton, VENDOR_GRID } from './order-ui';

/** Phone: a sideways rail of 44 % cards. From 760 px: a six-column grid. */
// The design shows one row of six on wide screens; a longer rail keeps
// scrolling on phones and stops at six from 760 px ("See all" has the rest).
export const RAIL = 'sw-bleed sw-rail-scroll auto-cols-[44%] pb-1 pt-4 wide:mx-0 wide:grid-flow-row wide:grid-cols-6 wide:px-0 wide:[&>li:nth-child(n+7)]:hidden';

/** Home's rails while the feed is on its way: the same cards, in outline. */
export function HomeSkeleton() {
  return (
    <LoadingRegion label="Loading home feed" className="flex flex-col gap-6">
      <section>
        <Bone className="h-[14px] w-24" /><Bone className="mt-1 h-7 w-48" />
        <ul className={RAIL}>{[1, 2, 3, 4, 5, 6].map((i) => <li key={i} className="min-w-0"><ItemCardSkeleton /></li>)}</ul>
      </section>
      <section>
        <Bone className="h-7 w-36" />
        <ul className={`mt-4 ${VENDOR_GRID}`}>{[1, 2, 3, 4].map((i) => <li key={i}><VendorCardSkeleton /></li>)}</ul>
      </section>
    </LoadingRegion>
  );
}

/** The whole of Home before the page itself has arrived. */
export function HomeOpeningSkeleton() {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3"><Bone className="h-8 w-48 rounded-full" /><span className="flex-1" /><Bone className="h-10 w-10 rounded-full" /></div>
      <Bone className="mt-3 h-7 w-56" />
      <Bone className="mt-3 h-12 rounded-full wide:max-w-[640px]" />
      <div className="mt-1 grid grid-cols-4 pb-3 wide:grid-cols-8">
        {Array.from({ length: 8 }, (_, i) => <div key={i} className="mt-3 flex flex-col items-center gap-1.5"><Bone className="h-14 w-14 rounded-2xl" /><Bone className="h-[18px] w-12" /></div>)}
      </div>
      <div className="mt-5"><HomeSkeleton /></div>
    </div>
  );
}
