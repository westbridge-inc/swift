import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import { Star, Clock } from 'lucide-react';
import { Section } from '@/components/site';
import { fetchStorefronts } from '@/lib/api';

export const metadata: Metadata = {
  title: 'Stores on Swift',
  description:
    'Browse restaurants, supermarkets, shops and services on Swift — verified local businesses across the Caribbean, delivered by Swift.',
};

const TYPES = [
  { key: '', label: 'All' },
  { key: 'RESTAURANT', label: 'Restaurants' },
  { key: 'SUPERMARKET', label: 'Groceries' },
  { key: 'STORE', label: 'Shops' },
  { key: 'SERVICE', label: 'Services' },
];

export default async function StoresPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const { type } = await searchParams;
  const stores = await fetchStorefronts(type ? { type } : {});

  return (
    <Section>
      <h1 className="text-3xl font-extrabold md:text-4xl">Stores on Swift</h1>
      <p className="mt-2 max-w-xl text-[var(--swift-muted)]">
        Every business here is document-verified and keeps 100% of what you pay them.
      </p>

      <div className="mt-6 flex flex-wrap gap-2">
        {TYPES.map((t) => (
          <Link
            key={t.key}
            href={t.key ? `/stores?type=${t.key}` : '/stores'}
            className={`rounded-full px-4 py-2 text-sm font-semibold ${
              (type ?? '') === t.key
                ? 'bg-[var(--swift-red)] text-white'
                : 'border border-black/10 bg-white hover:bg-[var(--swift-subtle)]'
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {stores.length === 0 ? (
        <p className="mt-10 rounded-2xl border border-dashed border-black/10 p-10 text-center text-[var(--swift-muted)]">
          No stores to show here yet — new businesses go live after verification.
        </p>
      ) : (
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {stores.map((s) => (
            <Link
              key={s.id}
              href={`/stores/${s.slug}`}
              className="group overflow-hidden rounded-2xl border border-black/5 bg-white transition-shadow hover:shadow-md"
            >
              <div className="relative h-36 bg-[var(--swift-subtle)]">
                {s.coverImageUrl && (
                  <Image
                    src={s.coverImageUrl}
                    alt={s.name}
                    fill
                    unoptimized
                    className="object-cover"
                  />
                )}
                {!s.isCurrentlyOpen && (
                  <span className="absolute left-3 top-3 rounded-full bg-black/70 px-2.5 py-1 text-xs font-bold text-white">
                    Closed now
                  </span>
                )}
              </div>
              <div className="p-4">
                <p className="font-bold group-hover:text-[var(--swift-red)]">{s.name}</p>
                <p className="mt-0.5 line-clamp-1 text-sm text-[var(--swift-muted)]">
                  {s.cuisineTypes.length > 0 ? s.cuisineTypes.join(' · ') : s.city}
                </p>
                <p className="mt-2 flex items-center gap-3 text-sm text-[var(--swift-muted)]">
                  <span className="flex items-center gap-1">
                    <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                    {s.averageRating.toFixed(1)}
                    {s.totalRatings > 0 && <span>({s.totalRatings})</span>}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" /> ~{s.estimatedPrepTime} min
                  </span>
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </Section>
  );
}
