import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { fetchStorefront } from '@/lib/api';
import { StorefrontExperience } from './storefront-experience';

type StorefrontRouteProps = {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function scannedReturnPath(slug: string, searchParams: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  const src = searchParams['src'];
  const code = searchParams['c'];
  const template = searchParams['t'];
  if (src === 'qr') query.set('src', src);
  if (typeof code === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(code)) query.set('c', code);
  if (typeof template === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(template)) query.set('t', template);
  const suffix = query.toString();
  return `/store/${encodeURIComponent(slug)}${suffix ? `?${suffix}` : ''}`;
}

export async function generateStorefrontMetadata({ params }: StorefrontRouteProps): Promise<Metadata> {
  const { slug } = await params;
  const store = await fetchStorefront(slug);
  if (!store) return { title: 'Store not found' };
  return {
    title: `${store.name} — order on Swift`,
    description:
      store.description ??
      `${store.name} in ${store.city} — browse the live listings and place an order on Swift.`,
    alternates: { canonical: `/store/${store.slug}` },
  };
}

export async function StorefrontPage({ params, searchParams }: StorefrontRouteProps) {
  const { slug } = await params;
  const store = await fetchStorefront(slug);
  if (!store) notFound();
  const returnPath = scannedReturnPath(store.slug, searchParams ? await searchParams : {});
  return <StorefrontExperience store={store} returnPath={returnPath} />;
}
