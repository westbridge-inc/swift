import { notFound, permanentRedirect } from 'next/navigation';
import { vendorSeed } from '@/lib/browse-server';
import { canonicalStorePath } from '@/components/storefront/store-path';

type LegacyStoreProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * [W6] One store page. A store used to have two: this address (by id) and
 * its storefront (by name, `/store/<slug>`). Every link, bookmark, shared
 * link and Home's "popular" card that still points here is sent, permanently,
 * to the store's one page — keeping only the item it opened at and a scanned
 * code's attribution, never anything else from the old query.
 *
 * The store is read as a GUEST (lib/browse-server.ts: no cookie, no person),
 * only for an id that can be a store id. A store the server does not know is
 * "not found" here, never a made-up address.
 */
export default async function LegacyStorePage({ params, searchParams }: LegacyStoreProps): Promise<never> {
  const { id } = await params;
  const seed = await vendorSeed(id);
  const slug = seed?.data.slug;
  if (typeof slug !== 'string' || slug.length === 0) notFound();
  permanentRedirect(canonicalStorePath(slug, searchParams ? await searchParams : {}));
}
