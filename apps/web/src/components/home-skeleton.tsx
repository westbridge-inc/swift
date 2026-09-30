import { Bone } from './customer-skeletons';
import { VendorCardSkeleton, VendorGridSkeleton } from './order-ui';

export const RAIL = 'mt-3 -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 [overscroll-behavior-x:contain] [scrollbar-width:none]';

export function HomeSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading home feed" className="space-y-8">
      <section><Bone className="h-11 w-44" /><ul className={RAIL}>
        {[1, 2, 3, 4].map((i) => <li key={i} className="w-40 shrink-0 snap-start sm:w-44"><div className="overflow-hidden rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-card)]"><Bone className="h-28 rounded-none" /><div className="p-2.5"><Bone className="h-5 w-3/4" /><Bone className="h-5 w-20" /><Bone className="mt-0.5 h-4 w-24" /></div></div></li>)}
      </ul></section>
      <section><Bone className="h-7 w-36" /><ul className={RAIL}>
        {[1, 2, 3].map((i) => <li key={i} className="w-60 shrink-0 snap-start"><VendorCardSkeleton /></li>)}
      </ul></section>
      <section><h2 className="text-xl font-extrabold">Open now</h2><div className="mt-4"><VendorGridSkeleton /></div></section>
    </div>
  );
}

export function HomeOpeningSkeleton() {
  return <div className="space-y-8"><section className="space-y-4"><Bone className="h-11 w-48 rounded-full" /><div><h1 className="text-2xl font-extrabold tracking-tight md:text-3xl">Order food, groceries and more</h1><Bone className="mt-1 h-10 md:h-6" /></div><Bone className="h-[50px] rounded-full md:hidden" /><div className="grid grid-cols-4 gap-2 sm:gap-3 lg:grid-cols-8">{Array.from({ length: 8 }, (_, i) => <div key={i} className="flex flex-col items-center gap-2 p-2 sm:p-3"><Bone className="h-14 w-14 rounded-2xl" /><Bone className="h-4 w-12 sm:h-5" /></div>)}</div></section><HomeSkeleton /></div>;
}
