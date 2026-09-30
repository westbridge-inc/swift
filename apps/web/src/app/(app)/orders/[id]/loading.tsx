import { Bone, LoadingRegion } from '@/components/customer-skeletons';
import tracking from './tracking.module.css';

export default function OrderDetailSkeleton() {
  return <LoadingRegion label="Loading order tracking" className={tracking.page}>
    <section className={tracking.hero}><div className={tracking.heroIcon} /><div className={tracking.heroCopy}><Bone className="h-4 w-36" /><Bone className="mt-1 h-9 w-3/4" /><Bone className="mt-1 h-5 w-40" /></div><Bone className="h-9 w-24 rounded-full" /></section>
    <section className={tracking.progressCard}><Bone className="h-4 w-24" /><Bone className="mt-1 h-8 w-2/3" /><div className="mt-6 flex justify-between gap-3">{[1, 2, 3, 4].map((i) => <Bone key={i} className="h-11 w-11 rounded-full" />)}</div></section>
    <div className={tracking.detailGrid}><div className={tracking.mainColumn}><section className={tracking.card}><Bone className="h-6 w-40" /><Bone className="mt-3 h-12" /></section></div><aside className={tracking.summaryCard}><Bone className="h-7 w-36" /><Bone className="mt-4 h-24" /><Bone className="mt-4 h-11" /></aside></div>
  </LoadingRegion>;
}
