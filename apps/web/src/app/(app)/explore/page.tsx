'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { UtensilsCrossed, ShoppingCart, Store, Car, Package, Wrench, BadgePercent, Wallet, ShieldCheck } from 'lucide-react';
import { getVendors, type Vendor } from '@/lib/customer';
import { VendorCard, VendorGridSkeleton, VENDOR_GRID } from '@/components/order-ui';

const VERTICALS = [
  { href: '/order/browse?type=RESTAURANT', label: 'Food', desc: 'Restaurants & takeaway', Icon: UtensilsCrossed },
  { href: '/order/browse?type=SUPERMARKET', label: 'Groceries', desc: 'Markets & supermarkets', Icon: ShoppingCart },
  { href: '/order/browse?type=STORE', label: 'Shops', desc: 'Pharmacy, hardware, goods', Icon: Store },
  { href: '/taxi', label: 'Taxi', desc: 'Book in the Swift mobile app', Icon: Car },
  { href: '/courier', label: 'Send a package', desc: 'Point-to-point courier', Icon: Package },
  { href: '/order/browse?type=SERVICE', label: 'Services', desc: 'Electricians, cleaners & more', Icon: Wrench },
];
const VALUES = [
  { Icon: BadgePercent, title: '0% fees, no markups', body: 'Prices are the business’s own. Swift adds nothing to your order.' },
  { Icon: Wallet, title: 'Pay cash or MMG', body: 'You pay the business or driver directly — Swift never holds your money.' },
  { Icon: ShieldCheck, title: 'Verified locals', body: 'Every business and driver is document-verified before they go live.' },
];

export default function ExplorePage() {
  const [featured, setFeatured] = useState<Vendor[] | null>(null);
  useEffect(() => { getVendors().then((v) => setFeatured(v.slice(0, 8))).catch(() => setFeatured([])); }, []);

  return (
    <div className="space-y-10">
      <section className="rounded-[20px] bg-[var(--swift-red)] p-8 text-[var(--swift-white)] wide:p-12">
        <h1 className="font-display text-[28px] font-semibold leading-[34px] wide:text-[34px] wide:leading-[38px]">Explore Swift</h1>
        <p className="mt-2 max-w-xl text-white/90">One app for your city — food, groceries, shops, rides, courier and services. Order from stores on the web. Taxi rides require the Swift mobile app.</p>
        <Link href="/" className="sw-btn sw-btn-md mt-5 bg-[var(--swift-card)] text-[var(--swift-red)] hover:!bg-[var(--swift-red-50)]">Start an order</Link>
      </section>

      <section>
        <h2 className="sw-title">Everything you can do</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {VERTICALS.map(({ href, label, desc, Icon }) => (
            <Link key={label} href={href} className="group flex items-center gap-3 sw-card p-4 hover:shadow-md">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--swift-red-50)]"><Icon className="h-5.5 w-5.5 text-[var(--swift-red)]" /></span>
              <span><span className="block font-bold group-hover:text-[var(--swift-red)]">{label}</span><span className="block text-xs text-[var(--swift-muted)]">{desc}</span></span>
            </Link>
          ))}
        </div>
      </section>

      <section>
        <h2 className="sw-title">Why Swift</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {VALUES.map(({ Icon, title, body }) => (
            <div key={title} className="sw-card p-5">
              <Icon className="h-6 w-6 text-[var(--swift-red)]" />
              <p className="mt-2 font-bold">{title}</p>
              <p className="text-sm text-[var(--swift-muted)]">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between"><h2 className="sw-title">Popular near you</h2><Link href="/order/browse" className="text-sm font-semibold text-[var(--swift-red)]">See all</Link></div>
        <div className="mt-4">{featured === null ? <VendorGridSkeleton /> : <div className={VENDOR_GRID}>{featured.map((v) => <VendorCard key={v.id} v={v} />)}</div>}</div>
      </section>
    </div>
  );
}
