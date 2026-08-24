import type { Metadata } from 'next';
import Link from 'next/link';
import Image from 'next/image';
import { Star, Clock } from 'lucide-react';
import { Section } from '@/components/site';
import { fetchStorefronts } from '@/lib/api';
import styles from './stores.module.css';

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
      <h1 className={styles.title}>Stores on Swift</h1>
      <p className={styles.intro}>
        Every business here is document-verified and keeps 100% of what you pay them.
      </p>

      <nav className={styles.filters} aria-label="Store type">
        {TYPES.map((t) => (
          <Link
            key={t.key}
            href={t.key ? `/stores?type=${t.key}` : '/stores'}
            className={`${styles.filter} ${(type ?? '') === t.key ? styles.filterSelected : ''}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {stores === null ? (
        <p className={styles.empty} role="alert">
          Swift could not load the live store directory. Refresh this page when the service is available; no empty catalog is being inferred.
        </p>
      ) : stores.length === 0 ? (
        <p className={styles.empty}>
          No stores to show here yet — new businesses go live after verification.
        </p>
      ) : (
        <div className={styles.grid}>
          {stores.map((s) => (
            <Link
              key={s.id}
              href={`/store/${s.slug}`}
              className={styles.card}
            >
              <div className={styles.media}>
                {s.coverImageUrl && (
                  <Image
                    src={s.coverImageUrl}
                    alt={s.name}
                    fill
                    unoptimized
                    className={styles.mediaImage}
                  />
                )}
                {!s.isCurrentlyOpen && (
                  <span className={styles.closed}>
                    Closed now
                  </span>
                )}
              </div>
              <div className={styles.cardBody}>
                <p className={styles.name}>{s.name}</p>
                <p className={styles.description}>
                  {s.cuisineTypes.length > 0 ? s.cuisineTypes.join(' · ') : s.city}
                </p>
                <p className={styles.meta}>
                  <span className={styles.metaItem}>
                    <Star size={16} className={styles.star} aria-hidden="true" />
                    {s.averageRating.toFixed(1)}
                    {s.totalRatings > 0 && <span>({s.totalRatings})</span>}
                  </span>
                  <span className={styles.metaItem}>
                    <Clock size={16} aria-hidden="true" /> ~{s.estimatedPrepTime} min
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
