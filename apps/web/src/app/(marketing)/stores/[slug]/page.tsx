import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { Star, MapPin, Clock } from 'lucide-react';
import { fetchStorefront } from '@/lib/api';

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const store = await fetchStorefront(slug);
  if (!store) return { title: 'Store not found' };
  return {
    title: `${store.name} — order on Swift`,
    description:
      store.description ??
      `${store.name} in ${store.city} — browse the menu and order on Swift. Verified local business, zero commission.`,
  };
}

export default async function StorefrontPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const store = await fetchStorefront(slug);
  if (!store) notFound();

  const typeLabel =
    store.vendorType === 'SUPERMARKET' ? 'Grocery' : store.vendorType === 'STORE' ? 'Shop' : store.vendorType === 'SERVICE' ? 'Services' : 'Restaurant';

  return (
    <>
      <div className="relative h-56 bg-[var(--swift-subtle)] md:h-72">
        {store.coverImageUrl && (
          <Image src={store.coverImageUrl} alt={store.name} fill unoptimized className="object-cover" />
        )}
      </div>

      <div className="mx-auto max-w-6xl px-5">
        <div className="-mt-10 flex flex-col gap-4 rounded-3xl border border-black/5 bg-white p-6 shadow-sm md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-4">
            {store.logoUrl && (
              <span className="relative block h-16 w-16 shrink-0 overflow-hidden rounded-2xl border border-black/5">
                <Image src={store.logoUrl} alt="" fill unoptimized className="object-cover" />
              </span>
            )}
            <div>
              <h1 className="text-2xl font-extrabold md:text-3xl">{store.name}</h1>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--swift-muted)]">
                <span>{typeLabel}</span>
                <span className="flex items-center gap-1">
                  <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                  {store.averageRating.toFixed(1)} ({store.totalRatings})
                </span>
                <span className="flex items-center gap-1">
                  <MapPin className="h-4 w-4" /> {store.addressLine1}, {store.city}
                </span>
                <span className={`font-semibold ${store.isCurrentlyOpen ? 'text-green-600' : 'text-[var(--swift-red)]'}`}>
                  {store.isCurrentlyOpen ? 'Open now' : 'Closed now'}
                </span>
              </p>
            </div>
          </div>
          <Link
            href={`/order/vendor/${store.id}`}
            className="shrink-0 rounded-full bg-[var(--swift-red)] px-6 py-3 text-center font-semibold text-white hover:bg-[var(--swift-red-600)]"
          >
            Order now
          </Link>
        </div>

        {store.description && <p className="mt-6 max-w-2xl text-[var(--swift-muted)]">{store.description}</p>}

        <div className="mt-8 grid gap-8 pb-16 lg:grid-cols-[1fr_280px]">
          <div className="space-y-8">
            {store.categories.length === 0 && (
              <p className="rounded-2xl border border-dashed border-black/10 p-10 text-center text-[var(--swift-muted)]">
                Menu coming soon.
              </p>
            )}
            {store.categories.map((cat) => (
              <section key={cat.id}>
                <h2 className="text-xl font-bold">{cat.name}</h2>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {cat.items.map((item) => (
                    <div key={item.id} className="flex gap-3 rounded-2xl border border-black/5 bg-white p-4">
                      {item.imageUrl && (
                        <span className="relative block h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-[var(--swift-subtle)]">
                          <Image src={item.imageUrl} alt="" fill unoptimized className="object-cover" />
                        </span>
                      )}
                      <div className="min-w-0">
                        <p className="font-semibold">
                          {item.name}
                          {item.isPopular && (
                            <span className="ml-2 rounded-full bg-[var(--swift-red)]/10 px-2 py-0.5 text-[11px] font-bold text-[var(--swift-red)]">
                              Popular
                            </span>
                          )}
                        </p>
                        {item.description && (
                          <p className="mt-0.5 line-clamp-2 text-sm text-[var(--swift-muted)]">{item.description}</p>
                        )}
                        <p className="mt-1 font-bold">
                          {money(item.basePrice)}
                          {item.unit && <span className="font-normal text-[var(--swift-muted)]"> / {item.unit}</span>}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>

          <aside className="h-fit rounded-2xl border border-black/5 bg-white p-5">
            <h3 className="flex items-center gap-2 font-bold">
              <Clock className="h-4 w-4 text-[var(--swift-red)]" /> Hours
            </h3>
            <div className="mt-3 space-y-1.5 text-sm">
              {store.operatingHours.length === 0 && <p className="text-[var(--swift-muted)]">Not published yet.</p>}
              {store.operatingHours.map((h) => (
                <p key={h.dayOfWeek} className="flex justify-between">
                  <span className="text-[var(--swift-muted)]">{DAYS[h.dayOfWeek]}</span>
                  <span className="font-medium">{h.isClosed ? 'Closed' : `${h.openTime} – ${h.closeTime}`}</span>
                </p>
              ))}
            </div>
            {store.minOrderAmount > 0 && (
              <p className="mt-4 border-t border-black/5 pt-3 text-sm text-[var(--swift-muted)]">
                Minimum order {money(store.minOrderAmount)}
              </p>
            )}
          </aside>
        </div>
      </div>
    </>
  );
}
