import { Bone, LoadingRegion } from '@/components/customer-skeletons';
import cart from './cart.module.css';

export default function CartSkeleton() {
  return <LoadingRegion label="Loading your cart" className={cart.page}>
    <section className={cart.itemsColumn}><h1 className={cart.title}>Your cart</h1>{[1, 2, 3].map((i) => <div key={i} className={cart.itemCard}><div className={cart.itemCopy}><Bone className="h-6 w-3/4" /><Bone className="mt-1 h-5 w-24" /><Bone className="mt-1 h-6 w-20" /></div><Bone className="h-11 w-28 rounded-full" /></div>)}</section>
    <aside className={cart.rail} aria-label="Loading checkout">{[1, 2, 3].map((i) => <div key={i} className={cart.panel}><Bone className="h-6 w-32" /><Bone className="mt-3 h-11" /><Bone className="mt-3 h-5 w-2/3" /></div>)}</aside>
  </LoadingRegion>;
}
