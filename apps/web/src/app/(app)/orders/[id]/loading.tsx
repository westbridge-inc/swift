import { Bone, LoadingRegion } from '@/components/customer-skeletons';
import tracking from './tracking.module.css';

export default function OrderDetailSkeleton() {
  return <LoadingRegion label="Loading order tracking" className={tracking.page}>
    <section className={tracking.hero}><div className={tracking.heroIcon} /><div className={tracking.heroCopy}><Bone className="h-[14px] w-40" /><Bone className="mt-1 h-7 w-3/4" /><Bone className="mt-1 h-[18px] w-56" /></div><Bone className="h-[22px] w-20 rounded-full" /></section>
    <section className={tracking.progressCard}><Bone className="h-[14px] w-24" /><Bone className="mt-1 h-6 w-2/3" /><div className="mt-4 flex flex-col gap-4">{[1, 2, 3, 4].map((i) => <div key={i} className="flex items-center gap-3"><Bone className="h-5 w-5 rounded-full" /><Bone className="h-5 w-32" /></div>)}</div></section>
    <div className={tracking.detailGrid}><div className={tracking.mainColumn}><section className={tracking.card}><Bone className="h-[14px] w-24" /><Bone className="mt-1 h-6 w-2/3" /><Bone className="mt-3 h-12" /></section></div><aside className={tracking.summaryCard}><Bone className="h-[14px] w-28" /><Bone className="mt-1 h-6 w-36" /><Bone className="mt-4 h-24" /><Bone className="mt-4 h-12 rounded-full" /></aside></div>
  </LoadingRegion>;
}
