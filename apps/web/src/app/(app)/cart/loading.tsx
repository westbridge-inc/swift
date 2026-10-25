import { Bone, LoadingRegion } from '@/components/customer-skeletons';
import cart from './cart.module.css';

export default function CartSkeleton() {
  return <LoadingRegion label="Loading your cart" className={cart.page}>
    <section className={cart.itemsColumn}>
      <div className={cart.titleRow}><h1 className={cart.title}>Cart</h1></div>
      <div className={cart.lines}>
        {[1, 2, 3].map((i) => <div key={i} className={cart.itemCard}><Bone className="h-16 w-16 flex-none rounded-xl" /><div className={cart.itemCopy}><Bone className="h-[22px] w-3/4" /><Bone className="mt-1 h-[18px] w-24" /><Bone className="mt-2 h-8 w-[104px] rounded-full" /></div></div>)}
      </div>
      <div className={cart.panel}><Bone className="h-6 w-32" /><Bone className="h-[52px] rounded-2xl" /></div>
    </section>
    <aside className={cart.rail} aria-label="Loading checkout"><div className={cart.summary}><Bone className="h-6 w-40" /><Bone className="h-24" /><Bone className="h-16 rounded-full" /></div></aside>
  </LoadingRegion>;
}
