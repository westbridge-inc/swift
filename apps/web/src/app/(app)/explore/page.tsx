'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { UtensilsCrossed, ShoppingCart, Store, Car, Package, Wrench, BadgePercent, Wallet, ShieldCheck } from 'lucide-react';
import { getVendors, type Vendor } from '@/lib/customer';
import { VendorCard, VendorGridSkeleton } from '@/components/order-ui';

const VERTICALS = [
  { href: '/order/browse?type=RESTAURANT', label: 'Food', desc: 'Restaurants & takeaway', Icon: UtensilsCrossed },
  { href: '/order/browse?type=SUPERMARKET', label: 'Groceries', desc: 'Markets & supermarkets', Icon: ShoppingCart },
  { href: '/order/browse?type=STORE', label: 'Shops', desc: 'Pharmacy, hardware, goods', Icon: Store },
  { href: '/taxi', label: 'Taxi', desc: 'A ride across town', Icon: Car },
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
      <section className="rounded-3xl bg-[var(--swift-red)] p-8 text-white md:p-12">
        <h1 className="text-3xl font-extrabold md:text-4xl">Explore Swift</h1>
        <p className="mt-2 max-w-xl text-white/90">One app for your city — food, groceries, shops, rides, courier and services. Everything the Swift app does, now on the web.</p>
        <Link href="/order" className="mt-5 inline-block rounded-full bg-white px-5 py-2.5 font-bold text-[var(--swift-red)]">Start an order</Link>
      </section>

      <section>
        <h2 className="text-xl font-extrabold">Everything you can do</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {VERTICALS.map(({ href, label, desc, Icon }) => (
            <Link key={label} href={href} className="group flex items-center gap-3 rounded-2xl border border-black/5 bg-white p-4 hover:shadow-md">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--swift-red-50)]"><Icon className="h-5.5 w-5.5 text-[var(--swift-red)]" /></span>
              <span><span className="block font-bold group-hover:text-[var(--swift-red)]">{label}</span><span className="block text-xs text-[var(--swift-muted)]">{desc}</span></span>
            </Link>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-xl font-extrabold">Why Swift</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {VALUES.map(({ Icon, title, body }) => (
            <div key={title} className="rounded-2xl border border-black/5 bg-white p-5">
              <Icon className="h-6 w-6 text-[var(--swift-red)]" />
              <p className="mt-2 font-bold">{title}</p>
              <p className="text-sm text-[var(--swift-muted)]">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between"><h2 className="text-xl font-extrabold">Popular near you</h2><Link href="/order/browse" className="text-sm font-semibold text-[var(--swift-red)]">See all</Link></div>
        <div className="mt-4">{featured === null ? <VendorGridSkeleton /> : <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">{featured.map((v) => <VendorCard key={v.id} v={v} />)}</div>}</div>
      </section>
    </div>
  );
}
